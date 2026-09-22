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
    generateDeviceToken,
    hashPassword,
    verifyPassword,
} from "../auth";
import type { AppDatabase } from "../auth";
import { DEFAULT_RATE_LIMIT_CONFIG, type AppConfig } from "../config";
import { AuthedRequest, requireAuth, requireOwner } from "./middleware";
import { RateLimiter } from "./rateLimit";

const USERNAME_MAX = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 1024;
const DEVICE_NAME_MAX = 64;

/**
 * Single-use bootstrap gate owned by the router.
 *
 * `AppConfig.bootstrapToken` stays a pure, immutable ADT field; the "this
 * secret works exactly once" policy lives here. A consumed (or unset) gate
 * answers `isEnabled() === false`, so an operator's leftover env secret can
 * never bootstrap a duplicate owner.
 *
 * The gate is scoped per `createAuthRouter` call (one per app, one per test);
 * a second router built from the same config gets its own fresh gate, but
 * `store.hasOwner()` rejects the attempt as `OWNER_EXISTS` — the database row
 * remains the cross-instance backstop.
 */
class BootstrapGate {
    constructor(
        private readonly token: string | undefined,
        private consumed = false,
    ) {}

    /** Whether a bootstrap attempt may proceed at all. */
    isEnabled(): boolean {
        return this.token !== undefined && !this.consumed;
    }

    /** The configured secret, for comparison by the route handler. */
    get secret(): string | undefined {
        return this.consumed ? undefined : this.token;
    }

    /** Consumes the gate on success; subsequent attempts are disabled. */
    consume(): void {
        this.consumed = true;
    }
}

/** Long enough that a single attempt can't be meaningfully throttled; a rate
 * check keying on username requires the body to parse first. */
const BOOTSTRAP_KEY_PREFIX = "bootstrap:";
const LOGIN_KEY_PREFIX = "login:";

/** Cached dummy hash so a missing username costs the same scrypt as a real one. */
let dummyPasswordHash: Promise<string> | null = null;
function dummyHash(): Promise<string> {
    // Any password; never actually verified against, only the *cost* must
    // match the real path so usernames can't be enumerated by response time.
    dummyPasswordHash ??= hashPassword("definitely-not-a-real-password");
    return dummyPasswordHash;
}

/** Maps a stable AuthError code to an HTTP status. */
const AUTH_ERROR_STATUS: Record<string, number> = {
    USERNAME_TAKEN: 409,
    BAD_REQUEST: 400,
    INVALID_CREDENTIALS: 401,
    OWNER_EXISTS: 409,
    BOOTSTRAP_DISABLED: 409,
    BAD_BOOTSTRAP_TOKEN: 403,
    RATE_LIMITED: 429,
    NOT_FOUND: 404,
    NOT_AUTHORIZED: 403,
    MALFORMED_HASH: 500,
};

/**
 * Builds the `/api` router.
 *
 * `store` backs every ledger query; `appConfig` supplies the bootstrap token
 * gate. Passwords are hashed at the default scrypt cost (`DEFAULT_SCRYPT_PARAMS`).
 * Credential endpoints are throttled per `(ip, username)` and per `ip` by the
 * limiter built from `appConfig.loginRateLimit`.
 */
export function createAuthRouter(
    store: AppDatabase,
    appConfig: AppConfig,
): Router {
    const router = Router();
    const limiter = new RateLimiter(
        appConfig.loginRateLimit ?? DEFAULT_RATE_LIMIT_CONFIG,
    );
    const bootstrapGate = new BootstrapGate(appConfig.bootstrapToken);

    router.post("/bootstrap", async (req, res) => {
        try {
            if (!bootstrapGate.isEnabled()) {
                throw new AuthError(
                    "BOOTSTRAP_DISABLED",
                    "first-owner setup is disabled; set JARVIS_BOOTSTRAP_TOKEN to enable it",
                );
            }
            const ipKey = `${BOOTSTRAP_KEY_PREFIX}${req.ip ?? "unknown"}`;
            const blocked = limiter.admit(ipKey);
            if (blocked) {
                throw new AuthError(
                    "RATE_LIMITED",
                    "too many attempts; try again later",
                );
            }
            const bootstrap = bootstrapTokenFrom(req);
            if (!constantTimeMatches(bootstrap, bootstrapGate.secret)) {
                throw new AuthError(
                    "BAD_BOOTSTRAP_TOKEN",
                    "bootstrap token mismatch",
                );
            }
            if (store.hasOwner()) {
                throw new AuthError(
                    "OWNER_EXISTS",
                    "an owner already exists; bootstrap is a one-time step",
                );
            }
            const { username, password, deviceName } = credentialBody(req);
            const owner = store.createUser(
                username,
                await hashPassword(password),
                "owner",
            );
            // Single-use: the operator's secret is gone once setup succeeds,
            // so a leaked/leftover env value can't bootstrap a duplicate owner.
            bootstrapGate.consume();
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
            const ip = req.ip ?? "unknown";
            const userKey = `${LOGIN_KEY_PREFIX}${ip}:${username}`;
            const ipKey = `${LOGIN_KEY_PREFIX}${ip}`;
            const blocked = limiter.admit(userKey) ?? limiter.admit(ipKey);
            if (blocked) {
                throw new AuthError(
                    "RATE_LIMITED",
                    "too many attempts; try again later",
                );
            }
            const storedHash =
                store.getPasswordHash(username) ?? (await dummyHash());
            if (!(await verifyPassword(password, storedHash))) {
                throw new AuthError(
                    "INVALID_CREDENTIALS",
                    "invalid username or password",
                );
            }
            limiter.recordSuccess(userKey);
            limiter.recordSuccess(ipKey);
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
        const device = Number.isInteger(deviceId)
            ? store.getDeviceById(deviceId)
            : null;
        if (!device) {
            res.status(404).json({ error: "device not found" });
            return;
        }
        if (device.userId !== jarv.user.id && jarv.user.role !== "owner") {
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
                    await hashPassword(password),
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
        if (
            !session ||
            (session.userId !== jarv.user.id && jarv.user.role !== "owner")
        ) {
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
    if (password.length < PASSWORD_MIN) {
        throw new AuthError(
            "BAD_REQUEST",
            `password must be at least ${PASSWORD_MIN} characters`,
        );
    }
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
    if (role !== "owner" && role !== "user") {
        throw new AuthError("BAD_REQUEST", "'role' must be 'owner' or 'user'");
    }
    return role;
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

/** The bootstrap secret, read exclusively from the `x-bootstrap-token` header. */
function bootstrapTokenFrom(req: Request): string | undefined {
    const header = req.headers["x-bootstrap-token"];
    return typeof header === "string" && header.length > 0 ? header : undefined;
}

function constantTimeMatches(
    presented: string | undefined,
    configured: string | undefined,
): boolean {
    if (!presented || !configured) {
        return false;
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(configured);
    return a.length === b.length && timingSafeEqual(a, b);
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
