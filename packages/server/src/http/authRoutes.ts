/**
 * REST management API for accounts, devices, and sessions.
 *
 * Mounted at `/api` by `createApp`. Unauthenticated routes: `POST /bootstrap`
 * (first-owner setup, gated by `JARVIS_BOOTSTRAP_TOKEN`) and `POST /auth/login`
 * (username + password → a fresh device token). Everything else sits behind
 * `requireAuth` (`Authorization: Bearer <device token>`), with owner-only
 * routes additionally requiring `requireOwner`. Errors are always
 * `{ "error": "<message>" }` with an appropriate status code.
 */
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import {
    AuthError,
    DEFAULT_SCRYPT_PARAMS,
    generateDeviceToken,
    hashPassword,
    verifyPassword,
} from "../auth";
import type { AppStore } from "../auth";
import type { ScryptParams } from "../auth";
import type { AppConfig } from "../config";
import { AuthedRequest, requireAuth, requireOwner } from "./middleware";

const USERNAME_MAX = 64;
const PASSWORD_MAX = 1024;
const DEVICE_NAME_MAX = 64;

interface RouterOptions {
    /** scrypt cost for hashing new passwords (tests use the fast params). */
    scryptParams?: ScryptParams;
}

/** Maps a stable AuthError code to an HTTP status. */
const AUTH_ERROR_STATUS: Record<string, number> = {
    USERNAME_TAKEN: 409,
    BAD_REQUEST: 400,
    INVALID_CREDENTIALS: 401,
    OWNER_EXISTS: 409,
    BOOTSTRAP_DISABLED: 409,
    BAD_BOOTSTRAP_TOKEN: 403,
    NOT_FOUND: 404,
    NOT_AUTHORIZED: 403,
    MALFORMED_HASH: 500,
};

/**
 * Builds the `/api` router.
 *
 * `store` backs every ledger query; `appConfig` supplies the bootstrap token
 * gate. `options.scryptParams` lets tests hash quickly.
 */
export function createAuthRouter(
    store: AppStore,
    appConfig: AppConfig,
    options: RouterOptions = {},
): Router {
    const router = Router();

    router.post("/bootstrap", async (req, res) => {
        try {
            if (!appConfig.bootstrapToken) {
                throw new AuthError(
                    "BOOTSTRAP_DISABLED",
                    "first-owner setup is disabled; set JARVIS_BOOTSTRAP_TOKEN to enable it",
                );
            }
            if (store.hasOwner()) {
                throw new AuthError(
                    "OWNER_EXISTS",
                    "an owner already exists; bootstrap is a one-time step",
                );
            }
            const bootstrap = bootstrapTokenFrom(req);
            if (!constantTimeMatches(bootstrap, appConfig.bootstrapToken)) {
                throw new AuthError(
                    "BAD_BOOTSTRAP_TOKEN",
                    "bootstrap token mismatch",
                );
            }
            const { username, password, deviceName } = credentialBody(req);
            const owner = store.createUser(
                username,
                await hashPassword(password, scryptParamsOf(options)),
                "owner",
            );
            const material = generateDeviceToken();
            const device = store.provisionDevice(
                owner.id,
                deviceName,
                material.tokenHash,
                material.prefix,
            );
            res.status(201).json({
                user: {
                    id: owner.id,
                    username: owner.username,
                    role: owner.role,
                },
                device: {
                    id: device.id,
                    name: device.name,
                    prefix: device.prefix,
                    token: material.token,
                },
            });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.post("/auth/login", async (req, res) => {
        try {
            if (!store.hasOwner()) {
                throw new AuthError(
                    "NOT_FOUND",
                    "no owner configured; bootstrap before logging in",
                );
            }
            const { username, password, deviceName } = credentialBody(req);
            const storedHash = store.getPasswordHash(username);
            if (!storedHash || !(await verifyPassword(password, storedHash))) {
                throw new AuthError(
                    "INVALID_CREDENTIALS",
                    "invalid username or password",
                );
            }
            const user = store.getUserByUsername(username)!;
            const material = generateDeviceToken();
            const device = store.provisionDevice(
                user.id,
                deviceName,
                material.tokenHash,
                material.prefix,
            );
            res.status(200).json({
                user: { id: user.id, username: user.username, role: user.role },
                device: {
                    id: device.id,
                    name: device.name,
                    prefix: device.prefix,
                    token: material.token,
                },
            });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.get("/me", requireAuth(store), (req: Request, res: Response) => {
        const jarv = (req as AuthedRequest).jarv;
        const devices = store.listDevicesByUser(jarv.user.id).map((d) => ({
            id: d.id,
            name: d.name,
            prefix: d.prefix,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt,
        }));
        res.status(200).json({
            user: {
                id: jarv.user.id,
                username: jarv.user.username,
                role: jarv.user.role,
            },
            devices,
        });
    });

    router.post("/devices", requireAuth(store), (req, res) => {
        try {
            const jarv = (req as AuthedRequest).jarv;
            const name = deviceNameFrom(req.body);
            const material = generateDeviceToken();
            const device = store.provisionDevice(
                jarv.user.id,
                name,
                material.tokenHash,
                material.prefix,
            );
            res.status(201).json({
                device: {
                    id: device.id,
                    name: device.name,
                    prefix: device.prefix,
                    token: material.token,
                },
            });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.delete("/devices/:id", requireAuth(store), (req, res) => {
        const jarv = (req as AuthedRequest).jarv;
        const deviceId = Number(String(req.params.id));
        const device = store.getDeviceById(deviceId);
        if (
            device &&
            device.userId !== jarv.user.id &&
            jarv.user.role !== "owner"
        ) {
            res.status(403).json({
                error: "you can only revoke your own devices",
            });
            return;
        }
        store.revokeDevice(deviceId);
        res.status(204).end();
    });

    router.get("/users", requireAuth(store), requireOwner, (req, res) => {
        const users = store.listUsers().map((u) => ({
            id: u.id,
            username: u.username,
            role: u.role,
            createdAt: u.createdAt,
        }));
        res.status(200).json(users);
    });

    router.post(
        "/users",
        requireAuth(store),
        requireOwner,
        async (req, res) => {
            try {
                const { username, password } = credentialBody(req);
                const role = roleFrom(req.body);
                const user = store.createUser(
                    username,
                    await hashPassword(password, scryptParamsOf(options)),
                    role,
                );
                res.status(201).json({
                    user: {
                        id: user.id,
                        username: user.username,
                        role: user.role,
                    },
                });
            } catch (err) {
                handleError(res, err);
            }
        },
    );

    router.get("/sessions", requireAuth(store), (req, res) => {
        const jarv = (req as AuthedRequest).jarv;
        const sessions = store.listOwnedSessions(jarv.user.id).map((s) => ({
            threadId: s.threadId,
            kind: s.kind,
            createdAt: s.createdAt,
            lastActiveAt: s.lastActiveAt,
        }));
        res.status(200).json(sessions);
    });

    router.delete("/sessions/:threadId", requireAuth(store), (req, res) => {
        const jarv = (req as AuthedRequest).jarv;
        const threadId = String(req.params.threadId);
        const session = store.getSessionByThread(threadId);
        if (!session || session.userId !== jarv.user.id) {
            res.status(404).json({ error: "session not found" });
            return;
        }
        store.deleteSession(threadId);
        res.status(204).end();
    });

    return router;
}

/** Reads + validates the username/password/deviceName credential body. */
function credentialBody(req: Request): {
    username: string;
    password: string;
    deviceName: string;
} {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = stringField(body.username, "username");
    if (username.length > USERNAME_MAX) {
        throw new AuthError("BAD_REQUEST", "username is too long");
    }
    const password = stringField(body.password, "password");
    if (password.length > PASSWORD_MAX) {
        throw new AuthError("BAD_REQUEST", "password is too long");
    }
    return {
        username,
        password,
        deviceName: deviceNameFrom(body),
    };
}

function deviceNameFrom(body: unknown): string {
    const name = stringField(
        (body as Record<string, unknown>).deviceName ?? "cli",
        "deviceName",
    );
    if (name.length > DEVICE_NAME_MAX) {
        throw new AuthError("BAD_REQUEST", "device name is too long");
    }
    return name;
}

function roleFrom(body: unknown): "owner" | "user" {
    const role = (body as Record<string, unknown>).role ?? "user";
    return role === "owner" || role === "user" ? role : "user";
}

function stringField(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new AuthError(
            "BAD_REQUEST",
            `'${field}' must be a non-empty string`,
        );
    }
    return value;
}

/** The bootstrap secret: either the `x-bootstrap-token` header or the body. */
function bootstrapTokenFrom(req: Request): string | undefined {
    const header = req.headers["x-bootstrap-token"];
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof header === "string" && header.length > 0) {
        return header;
    }
    return typeof body.bootstrapToken === "string"
        ? body.bootstrapToken
        : undefined;
}

function constantTimeMatches(
    presented: string | undefined,
    configured: string,
): boolean {
    if (!presented) {
        return false;
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(configured);
    return a.length === b.length && timingSafeEqual(a, b);
}

function scryptParamsOf(options: RouterOptions): ScryptParams {
    return options.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
}

/** Answers with the mapped status + a user-safe error message. */
function handleError(res: Response, err: unknown): void {
    if (err instanceof AuthError) {
        res.status(AUTH_ERROR_STATUS[err.code] ?? 500).json({
            error: err.message,
        });
        return;
    }
    res.status(500).json({ error: "internal server error" });
}
