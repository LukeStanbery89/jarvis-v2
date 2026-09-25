/**
 * REST management API for accounts, devices, sessions, and prefs.
 *
 * Mounted at `/api` by `createApp`. Unauthenticated routes: `POST /bootstrap`
 * (first-owner setup, gated by `JARVIS_BOOTSTRAP_TOKEN`) and the two credential
 * logins — `POST /auth/login` (username + password → a fresh device token) and
 * `POST /session` (username + password → a cookie session for the web portal).
 * Everything else sits behind `requireAuth` (`Authorization: Bearer <device
 * token>` *or* a session cookie), with owner-only routes additionally requiring
 * `requireOwner` and cookie-authenticated state changes requiring `requireCsrf`.
 * Errors are always `{ "error": "<message>" }` with an appropriate status code.
 */
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import {
    AuthError,
    canManage,
    createCookieSessionProvider,
    createCredentialVerifier,
    generateDeviceToken,
} from "@lukestanbery/jarvis-auth";
import type {
    AppDatabase,
    AppDevice,
    AppUser,
    CookieSessionProvider,
    CredentialVerifier,
} from "@lukestanbery/jarvis-auth";
import {
    clearSessionCookie,
    readSessionToken,
    sessionCookieName,
    setSessionCookie,
} from "./cookies";
import { authed, requireAuth, requireCsrf, requireOwner } from "./middleware";
import type { CookieAuthOptions } from "./middleware";
import { DEFAULT_RATE_LIMIT_CONFIG, type AppConfig } from "../config";
import { RateLimiter } from "./rateLimit";

const USERNAME_MAX = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 1024;
const DEVICE_NAME_MAX = 64;
const PREF_KEY_MAX = 256;
const PREF_KEY_COUNT_MAX = 64;

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
 *  check keying on username requires the body to parse first. */
const BOOTSTRAP_KEY_PREFIX = "bootstrap:";
const LOGIN_KEY_PREFIX = "login:";

/** Maps a stable AuthError code to an HTTP status. */
const AUTH_ERROR_STATUS: Record<string, number> = {
    USERNAME_TAKEN: 409,
    BAD_REQUEST: 400,
    INVALID_CREDENTIALS: 401,
    OWNER_EXISTS: 409,
    LAST_OWNER: 409,
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
 * gate and the cookie-session TTL; `credentials` is the hashing/verification
 * seam (default: scrypt at `DEFAULT_SCRYPT_PARAMS`, with the timing-equalized
 * dummy-hash for unknown usernames) — injectable so tests can substitute a
 * fake and a future biometric credential (#25) can plug in. `cookieSessions`
 * is the {@link CookieSessionProvider} the portal routes authenticate through
 * (default: real provider at the configured TTL) — injectable for tests.
 *
 * Credential endpoints (`/auth/login`, `/session`) are throttled per
 * `(ip, username)` and per `ip` by the limiter built from
 * `appConfig.loginRateLimit`, sharing one quota across both login methods.
 */
export function createAuthRouter(
    store: AppDatabase,
    appConfig: AppConfig,
    credentials: CredentialVerifier = createCredentialVerifier(),
    cookieSessions: CookieSessionProvider = createCookieSessionProvider(store, {
        ttlMs: appConfig.sessionTtlMs,
    }),
): Router {
    const router = Router();
    const limiter = new RateLimiter(
        appConfig.loginRateLimit ?? DEFAULT_RATE_LIMIT_CONFIG,
    );
    const bootstrapGate = new BootstrapGate(appConfig.bootstrapToken);
    // Secure cookies (adds `__Host-` + `Secure`) only when the server actually
    // speaks TLS: a `__Host-` cookie is rejected by browsers over plain HTTP.
    const secure = Boolean(appConfig.tlsCertPath && appConfig.tlsKeyPath);
    const cookieOptions: CookieAuthOptions = {
        provider: cookieSessions,
        cookieName: sessionCookieName(secure),
    };
    const authenticated = requireAuth(store, cookieOptions);

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
                await credentials.hash(password),
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
                user: userJson(owner),
                device: issuedDeviceJson(device, material.token),
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
            const body = credentialBody(req);
            const user = await verifyCredentials(
                store,
                credentials,
                limiter,
                body.username,
                body.password,
                req,
            );
            const material = generateDeviceToken();
            const device = store.provisionDevice(
                user.id,
                body.deviceName,
                material.tokenHash,
                material.prefix,
            );
            res.status(200).json({
                user: userJson(user),
                device: issuedDeviceJson(device, material.token),
            });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.post("/session", async (req, res) => {
        try {
            if (!store.hasOwner()) {
                throw new AuthError(
                    "NOT_FOUND",
                    "no owner configured; bootstrap before logging in",
                );
            }
            const { username, password } = usernamePasswordBody(req);
            const user = await verifyCredentials(
                store,
                credentials,
                limiter,
                username,
                password,
                req,
            );
            const material = cookieSessions.issue(user.id);
            const maxAgeSeconds =
                (Date.parse(material.expiresAt) - Date.now()) / 1000;
            setSessionCookie(res, material.token, maxAgeSeconds, secure);
            res.status(201).json({
                user: userJson(user),
                csrfToken: material.csrfToken,
                expiresAt: material.expiresAt,
            });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.get("/session", authenticated, (req: Request, res: Response) => {
        const jarv = authed(req).jarv;
        if (jarv.kind === "session") {
            res.status(200).json({
                user: userJson(jarv.user),
                csrfToken: jarv.csrfToken,
            });
            return;
        }
        res.status(200).json({ user: userJson(jarv.user) });
    });

    router.delete("/session", authenticated, requireCsrf, (req, res) => {
        const jarv = authed(req).jarv;
        if (jarv.kind === "session") {
            const token = readSessionToken(req, secure);
            if (token) {
                cookieSessions.revoke(token);
            }
        }
        clearSessionCookie(res, secure);
        res.status(204).end();
    });

    router.get("/me", authenticated, (req: Request, res: Response) => {
        const jarv = authed(req).jarv;
        const devices = store
            .listDevicesByUser(jarv.user.id)
            .map((d) => deviceJson(d));
        res.status(200).json({ user: userJson(jarv.user), devices });
    });

    router.post("/devices", authenticated, requireCsrf, (req, res) => {
        try {
            const jarv = authed(req).jarv;
            const name = deviceNameFrom(req.body);
            const material = generateDeviceToken();
            const device = store.provisionDevice(
                jarv.user.id,
                name,
                material.tokenHash,
                material.prefix,
            );
            res.status(201).json({
                device: issuedDeviceJson(device, material.token),
            });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.delete("/devices/:id", authenticated, requireCsrf, (req, res) => {
        try {
            const jarv = authed(req).jarv;
            const device = ownedDeviceOrThrow(store, req, jarv.user);
            store.revokeDevice(device.id);
            res.status(204).end();
        } catch (err) {
            handleError(res, err);
        }
    });

    router.patch("/devices/:id", authenticated, requireCsrf, (req, res) => {
        try {
            const jarv = authed(req).jarv;
            const device = ownedDeviceOrThrow(store, req, jarv.user);
            const name = renameNameFrom(req.body);
            const updated = store.renameDevice(device.id, name);
            res.status(200).json({ device: deviceJson(updated) });
        } catch (err) {
            handleError(res, err);
        }
    });

    router.get("/users", authenticated, requireOwner, (req, res) => {
        const users = store.listUsers().map((u) => userJson(u));
        res.status(200).json(users);
    });

    router.post(
        "/users",
        authenticated,
        requireOwner,
        requireCsrf,
        async (req, res) => {
            try {
                const { username, password } = usernamePasswordBody(req);
                const role = roleFrom(req.body);
                const user = store.createUser(
                    username,
                    await credentials.hash(password),
                    role,
                );
                res.status(201).json({ user: userJson(user) });
            } catch (err) {
                handleError(res, err);
            }
        },
    );

    router.patch(
        "/users/:id",
        authenticated,
        requireOwner,
        requireCsrf,
        (req, res) => {
            try {
                const jarv = authed(req).jarv;
                const target = userParamOrThrow(store, req);
                const body = (req.body ?? {}) as Record<string, unknown>;
                const hasRole = "role" in body;
                const hasDisabled = "disabled" in body;
                if (!hasRole && !hasDisabled) {
                    throw new AuthError(
                        "BAD_REQUEST",
                        "provide 'role' or 'disabled' to update",
                    );
                }
                if (hasRole) {
                    const role = body.role;
                    if (role !== "owner" && role !== "user") {
                        throw new AuthError(
                            "BAD_REQUEST",
                            "'role' must be 'owner' or 'user'",
                        );
                    }
                    store.setUserRole(target.id, role);
                }
                if (hasDisabled) {
                    const disabled = body.disabled;
                    if (typeof disabled !== "boolean") {
                        throw new AuthError(
                            "BAD_REQUEST",
                            "'disabled' must be a boolean",
                        );
                    }
                    if (disabled && target.id === jarv.user.id) {
                        throw new AuthError(
                            "BAD_REQUEST",
                            "you cannot disable your own account",
                        );
                    }
                    store.setUserDisabled(target.id, disabled);
                }
                const updated = store.getUserById(target.id)!;
                res.status(200).json({ user: userJson(updated) });
            } catch (err) {
                handleError(res, err);
            }
        },
    );

    router.get("/sessions", authenticated, (req, res) => {
        const jarv = authed(req).jarv;
        const sessions =
            jarv.user.role === "owner"
                ? store.listAllSessions()
                : store.listOwnedSessions(jarv.user.id);
        res.status(200).json(
            sessions.map((s) => ({
                threadId: s.threadId,
                kind: s.kind,
                userId: s.userId,
                createdAt: s.createdAt,
                lastActiveAt: s.lastActiveAt,
            })),
        );
    });

    router.delete(
        "/sessions/:threadId",
        authenticated,
        requireCsrf,
        (req, res) => {
            const jarv = authed(req).jarv;
            const threadId = String(req.params.threadId);
            const session = store.getSessionByThread(threadId);
            if (
                !session ||
                !canManage(
                    session.userId,
                    jarv.user.id,
                    jarv.user.role === "owner",
                )
            ) {
                res.status(404).json({ error: "session not found" });
                return;
            }
            store.deleteSession(threadId);
            res.status(204).end();
        },
    );

    router.get("/prefs", authenticated, (req, res) => {
        const jarv = authed(req).jarv;
        res.status(200).json(store.getPrefs(jarv.user.id));
    });

    router.put("/prefs", authenticated, requireCsrf, (req, res) => {
        try {
            const jarv = authed(req).jarv;
            store.setPrefs(jarv.user.id, prefsFrom(req.body));
            res.status(200).json(store.getPrefs(jarv.user.id));
        } catch (err) {
            handleError(res, err);
        }
    });

    router.delete("/prefs", authenticated, requireCsrf, (req, res) => {
        const jarv = authed(req).jarv;
        const keys = Object.keys(store.getPrefs(jarv.user.id));
        if (keys.length > 0) {
            store.deletePrefKeys(jarv.user.id, keys);
        }
        res.status(204).end();
    });

    router.get("/users/:id/prefs", authenticated, requireOwner, (req, res) => {
        try {
            const target = userParamOrThrow(store, req);
            res.status(200).json(store.getPrefs(target.id));
        } catch (err) {
            handleError(res, err);
        }
    });

    router.get(
        "/users/:id/devices",
        authenticated,
        requireOwner,
        (req, res) => {
            try {
                const target = userParamOrThrow(store, req);
                res.status(200).json(
                    store
                        .listDevicesByUser(target.id)
                        .map((d) => deviceJson(d)),
                );
            } catch (err) {
                handleError(res, err);
            }
        },
    );

    router.put(
        "/users/:id/prefs",
        authenticated,
        requireOwner,
        requireCsrf,
        (req, res) => {
            try {
                const target = userParamOrThrow(store, req);
                store.setPrefs(target.id, prefsFrom(req.body));
                res.status(200).json(store.getPrefs(target.id));
            } catch (err) {
                handleError(res, err);
            }
        },
    );

    router.delete(
        "/users/:id/prefs",
        authenticated,
        requireOwner,
        requireCsrf,
        (req, res) => {
            try {
                const target = userParamOrThrow(store, req);
                const keys = Object.keys(store.getPrefs(target.id));
                if (keys.length > 0) {
                    store.deletePrefKeys(target.id, keys);
                }
                res.status(204).end();
            } catch (err) {
                handleError(res, err);
            }
        },
    );

    return router;
}

/**
 * Shared credential gate for both login methods.
 *
 * Rate-limits per `(ip, username)` and per `ip` (one combined quota across the
 * device-token and cookie login paths, so an attacker can't double the guesses
 * by hitting both endpoints), then verifies against the stored hash. Marks the
 * attempt successful on a verified password so repeated successes never trip
 * the throttle. Returns the confirmed {@link AppUser} — validated by
 * {@link requireUser}, which rejects disabled accounts.
 */
async function verifyCredentials(
    store: AppDatabase,
    credentials: CredentialVerifier,
    limiter: RateLimiter,
    username: string,
    password: string,
    req: Request,
): Promise<AppUser> {
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
    const storedHash = store.getPasswordHash(username);
    if (!(await credentials.verify(password, storedHash))) {
        throw new AuthError(
            "INVALID_CREDENTIALS",
            "invalid username or password",
        );
    }
    limiter.recordSuccess(userKey);
    limiter.recordSuccess(ipKey);
    return requireUser(store, username);
}

/**
 * Re-reads the user by username after a successful password check and rejects
 * disabled accounts.
 *
 * The re-read (rather than trusting the hash lookup) mirrors the device-token
 * login guard: the only way this flips after a pass is a presented password
 * that equals the dummy-literal collision, which should read as invalid
 * credentials, not a 500. Disabled accounts are rejected outright — issuing a
 * credential that instantly 401s is worse than refusing the login.
 */
function requireUser(store: AppDatabase, username: string): AppUser {
    const user = store.getUserByUsername(username);
    if (!user) {
        throw new AuthError(
            "INVALID_CREDENTIALS",
            "invalid username or password",
        );
    }
    if (user.disabled) {
        throw new AuthError("NOT_AUTHORIZED", "this account is disabled");
    }
    return user;
}

/** The `:id` URL param resolved to a user, or a 404 `NOT_FOUND`. */
function userParamOrThrow(store: AppDatabase, req: Request): AppUser {
    const id = Number(String(req.params.id));
    const user = Number.isInteger(id) ? store.getUserById(id) : null;
    if (!user) {
        throw new AuthError("NOT_FOUND", "user not found");
    }
    return user;
}

/** The `:id` URL param resolved to a device the caller may manage. */
function ownedDeviceOrThrow(
    store: AppDatabase,
    req: Request,
    caller: AppUser,
): AppDevice {
    const id = Number(String(req.params.id));
    const device = Number.isInteger(id) ? store.getDeviceById(id) : null;
    if (!device) {
        throw new AuthError("NOT_FOUND", "device not found");
    }
    if (!canManage(device.userId, caller.id, caller.role === "owner")) {
        throw new AuthError(
            "NOT_AUTHORIZED",
            "you can only manage your own devices",
        );
    }
    return device;
}

/** Public user shape returned by the /api routes. */
function userJson(user: AppUser): {
    id: number;
    username: string;
    role: AppUser["role"];
    disabled: boolean;
    createdAt: string;
} {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        disabled: user.disabled,
        createdAt: user.createdAt,
    };
}

/** Public device shape returned by the /api routes. */
function deviceJson(device: AppDevice): {
    id: number;
    name: string;
    prefix: string;
    createdAt: string;
    lastSeenAt: string | null;
} {
    return {
        id: device.id,
        name: device.name,
        prefix: device.prefix,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
    };
}

/**
 * The shape of a *freshly issued* device credential: the stored fields plus
 * the one-time secret token that is never persisted (bootstrap / login /
 * provision responses only).
 */
function issuedDeviceJson(
    device: AppDevice,
    token: string,
): {
    id: number;
    name: string;
    prefix: string;
    token: string;
} {
    return {
        id: device.id,
        name: device.name,
        prefix: device.prefix,
        token,
    };
}

/** Reads + validates the username/password/deviceName credential body. */
function credentialBody(req: Request): {
    username: string;
    password: string;
    deviceName: string;
} {
    const { username, password } = usernamePasswordBody(req);
    return {
        username,
        password,
        deviceName: deviceNameFrom((req.body ?? {}) as Record<string, unknown>),
    };
}

/** Reads + validates just the username/password pair (cookie login). */
function usernamePasswordBody(req: Request): {
    username: string;
    password: string;
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
    return { username, password };
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

function renameNameFrom(body: unknown): string {
    const name = stringField((body as Record<string, unknown>).name, "name");
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

/** Reads + validates a prefs map body into ledger upsert entries. */
function prefsFrom(body: unknown): { key: string; value: unknown }[] {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AuthError("BAD_REQUEST", "prefs must be a JSON object");
    }
    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length === 0) {
        throw new AuthError("BAD_REQUEST", "at least one pref is required");
    }
    if (entries.length > PREF_KEY_COUNT_MAX) {
        throw new AuthError(
            "BAD_REQUEST",
            `too many prefs (max ${PREF_KEY_COUNT_MAX})`,
        );
    }
    return entries.map(([key, value]) => {
        if (key.length === 0 || key.length > PREF_KEY_MAX) {
            throw new AuthError(
                "BAD_REQUEST",
                "pref keys must be between 1 and 256 characters",
            );
        }
        try {
            JSON.stringify(value);
        } catch {
            throw new AuthError(
                "BAD_REQUEST",
                `pref '${key}' is not JSON-serializable`,
            );
        }
        return { key, value };
    });
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
