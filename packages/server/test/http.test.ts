import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../src/app";
import {
    SqliteAppDatabase,
    generateDeviceToken,
} from "@lukestanbery/jarvis-auth";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import type { AppConfig } from "../src/config";

const FAST: AppConfig & { bootstrapToken: string } = {
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: "s3cret-bootstrap",
};

/** Bootstrap secret for per-test apps (gate consumption leaves FAST untouched). */
const BOOTSTRAP = "s3cret-bootstrap";

const store = new SqliteAppDatabase(new Database(":memory:")) as AppDatabase;

const app = createApp(store, FAST);

afterAll(() => {
    store.close();
});

/** Bootstraps an owner (fast scrypt) and returns its fresh device token. */
async function passwordLogin(
    username: string,
    password: string,
    deviceName = "test",
): Promise<string> {
    const res = await request(app)
        .post("/api/auth/login")
        .send({ username, password, deviceName });
    expect(res.status).toBe(200);
    return res.body.device.token as string;
}

let ownerHeaderPromise: Promise<string> | null = null;

/** Lazy `Authorization` header for the owner, bootstrapping if needed. */
function ownerHeader(): Promise<string> {
    ownerHeaderPromise ??= (async () => {
        if (store.getUserByUsername("luke")) {
            return `Bearer ${await passwordLogin("luke", "hunter2pw")}`;
        }
        const res = await request(app)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", FAST.bootstrapToken)
            .send({ username: "luke", password: "hunter2pw" });
        expect(res.status).toBe(201);
        return `Bearer ${res.body.device.token}`;
    })();
    return ownerHeaderPromise;
}

describe("bootstrap", () => {
    it("rejects bootstrap when disabled by configuration", async () => {
        const noBootstrap = createApp(store, {
            ...FAST,
            bootstrapToken: undefined,
        });
        const res = await request(noBootstrap).post("/api/bootstrap").send({
            username: "ghost",
            password: "x",
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/bootstrap/i);
    });

    it("rejects a missing or wrong bootstrap token", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const freshApp = createApp(freshStore, {
            ...FAST,
            bootstrapToken: BOOTSTRAP,
        });
        const missing = await request(freshApp).post("/api/bootstrap").send({
            username: "intruder",
            password: "x",
        });
        expect(missing.status).toBe(403);

        const wrong = await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", "wrong")
            .send({ username: "intruder", password: "x" });
        expect(wrong.status).toBe(403);
        freshStore.close();
    });

    it("creates the owner and returns a working device token", async () => {
        const res = await request(app)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", FAST.bootstrapToken)
            .send({
                username: "luke",
                password: "hunter2pw",
                deviceName: "init",
            });
        expect(res.status).toBe(201);
        expect(res.body.user).toMatchObject({
            username: "luke",
            role: "owner",
        });
        expect(res.body.device.name).toBe("init");

        const me = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${res.body.device.token}`);
        expect(me.status).toBe(200);
        expect(me.body.devices).toHaveLength(1);
    });

    it("rejects a second bootstrap once an owner exists", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const freshApp = createApp(freshStore, {
            ...FAST,
            bootstrapToken: BOOTSTRAP,
        });
        const first = await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", BOOTSTRAP)
            .send({ username: "first-owner", password: "x-hunter2pw" });
        expect(first.status).toBe(201);

        const again = await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", BOOTSTRAP)
            .send({ username: "second-owner", password: "x" });
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/owner already exists|disabled/i);
        freshStore.close();
    });

    it("ignores a bootstrap token supplied in the body (header only)", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const freshApp = createApp(freshStore, {
            ...FAST,
            bootstrapToken: BOOTSTRAP,
        });
        const res = await request(freshApp).post("/api/bootstrap").send({
            username: "body-hacker",
            password: "secretpass",
            bootstrapToken: BOOTSTRAP,
        });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/bootstrap token mismatch/);
        freshStore.close();
    });

    it("consumes the single-use token after a successful bootstrap", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const freshApp = createApp(freshStore, {
            ...FAST,
            appDbPath: ":memory:",
            bootstrapToken: "once-only",
        });
        const ok = await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", "once-only")
            .send({ username: "first-guy", password: "hunter2pw" });
        expect(ok.status).toBe(201);
        // The router's BootstrapGate consumed the secret even though the
        // config object was never mutated; a second bootstrap is refused
        // outright as disabled (not merely because an owner now exists).
        const again = await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", "once-only")
            .send({ username: "second-guy", password: "hunter2pw" });
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/setup is disabled/i);
        freshStore.close();
    });

    it("throttles login attempts past the per-key limit", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const limiterConfig = { maxFailures: 3 } as const;
        const cfg: AppConfig & { bootstrapToken: string } = {
            ...FAST,
            appDbPath: ":memory:",
            bootstrapToken: BOOTSTRAP,
            loginRateLimit: {
                windowMs: 60_000,
                maxFailures: limiterConfig.maxFailures,
                lockoutMs: 60_000,
                maxIpFailures: 100,
            },
        };
        const freshApp = createApp(freshStore, cfg);
        await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", cfg.bootstrapToken)
            .send({ username: "throttled", password: "hunter2pw" });

        for (let i = 0; i < limiterConfig.maxFailures; i += 1) {
            const bad = await request(freshApp)
                .post("/api/auth/login")
                .send({ username: "throttled", password: "wrong-pass" });
            expect(bad.status).toBe(401);
        }
        const blocked = await request(freshApp)
            .post("/api/auth/login")
            .send({ username: "throttled", password: "wrong-pass" });
        expect(blocked.status).toBe(429);
        expect(blocked.body.error).toMatch(/too many attempts/);
        freshStore.close();
    });

    it("resets the failure count on a successful login", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const cfg: AppConfig & { bootstrapToken: string } = {
            ...FAST,
            appDbPath: ":memory:",
            bootstrapToken: BOOTSTRAP,
            loginRateLimit: {
                windowMs: 60_000,
                maxFailures: 3,
                lockoutMs: 60_000,
                maxIpFailures: 100,
            },
        };
        const freshApp = createApp(freshStore, cfg);
        await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", cfg.bootstrapToken)
            .send({ username: "resettable", password: "hunter2pw" });

        const wrong = async () =>
            (
                await request(freshApp)
                    .post("/api/auth/login")
                    .send({ username: "resettable", password: "wrong-pass" })
            ).status;
        expect(await wrong()).toBe(401);
        expect(await wrong()).toBe(401);
        const ok = await request(freshApp)
            .post("/api/auth/login")
            .send({ username: "resettable", password: "hunter2pw" });
        expect(ok.status).toBe(200);
        // Two fresh failures now slide back onto a clean count.
        expect(await wrong()).toBe(401);
        expect(await wrong()).toBe(401);
        const res = await request(freshApp)
            .post("/api/auth/login")
            .send({ username: "resettable", password: "wrong-pass" });
        expect(res.status).toBe(401);
        freshStore.close();
    });

    it("throttles bootstrap guesses by IP", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const cfg: AppConfig & { bootstrapToken: string } = {
            ...FAST,
            appDbPath: ":memory:",
            bootstrapToken: BOOTSTRAP,
            loginRateLimit: {
                windowMs: 60_000,
                maxFailures: 3,
                lockoutMs: 60_000,
                maxIpFailures: 100,
            },
        };
        const freshApp = createApp(freshStore, cfg);
        for (let i = 0; i < 3; i += 1) {
            const bad = await request(freshApp)
                .post("/api/bootstrap")
                .set("x-bootstrap-token", "nope")
                .send({ username: `guesser-${i}`, password: "hunter2pw" });
            expect(bad.status).toBe(403);
        }
        const blocked = await request(freshApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", cfg.bootstrapToken)
            .send({ username: "guesser-3", password: "hunter2pw" });
        expect(blocked.status).toBe(429);
        expect(blocked.body.error).toMatch(/too many attempts/);
        freshStore.close();
    });
});

describe("auth middleware", () => {
    it("answers 401 without a bearer token", async () => {
        const res = await request(app).get("/api/me");
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/bearer token/);
    });

    it("answers 401 for an unknown token", async () => {
        const res = await request(app)
            .get("/api/me")
            .set("authorization", "Bearer not-a-real-token");
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid device token/);
    });
});

describe("login + devices", () => {
    it("logs in with username + password and returns a device token", async () => {
        const token = await passwordLogin("luke", "hunter2pw", "cli");
        const me = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${token}`);
        expect(me.status).toBe(200);
        expect(me.body.user.username).toBe("luke");
        expect(me.body.devices.map((d: { name: string }) => d.name)).toContain(
            "cli",
        );
    });

    it("rotates the same-named device and invalidates the old token", async () => {
        const first = await passwordLogin("luke", "hunter2pw", "cli");
        const afterFirst = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${first}`);

        const second = await passwordLogin("luke", "hunter2pw", "cli");
        const afterSecond = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${second}`);
        expect(afterSecond.status).toBe(200);
        // Re-login on the same device name rotates, never grows the list.
        expect(afterSecond.body.devices.length).toBe(
            afterFirst.body.devices.length,
        );

        const stale = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${first}`);
        expect(stale.status).toBe(401);
    });

    it("rejects wrong credentials", async () => {
        const bad = await request(app).post("/api/auth/login").send({
            username: "luke",
            password: "wrong-pass",
        });
        expect(bad.status).toBe(401);
        expect(bad.body.error).toMatch(/invalid username or password/);
    });

    it("rejects empty or oversized fields", async () => {
        const empty = await request(app).post("/api/auth/login").send({
            username: "",
            password: "x",
        });
        expect(empty.status).toBe(400);

        const huge = await request(app)
            .post("/api/auth/login")
            .send({
                username: "luke",
                password: "x".repeat(1025),
            });
        expect(huge.status).toBe(400);
    });

    it("rejects passwords shorter than 8 characters", async () => {
        const short = await request(app).post("/api/auth/login").send({
            username: "luke",
            password: "hunter2",
        });
        expect(short.status).toBe(400);
        expect(short.body.error).toMatch(/at least 8/);

        const createShort = await request(app)
            .post("/api/users")
            .set("authorization", await ownerHeader())
            .send({ username: "shorty", password: "tiny" });
        expect(createShort.status).toBe(400);
        expect(createShort.body.error).toMatch(/at least 8/);
    });

    it("rejects login before an owner is bootstrapped", async () => {
        const freshStore = new SqliteAppDatabase(new Database(":memory:"));
        const freshApp = createApp(freshStore, FAST);
        const res = await request(freshApp).post("/api/auth/login").send({
            username: "anyone",
            password: "x",
        });
        expect(res.status).toBe(404);
        freshStore.close();
    });

    it("lets a non-owner provision and revoke their own device", async () => {
        await request(app)
            .post("/api/users")
            .set("authorization", await ownerHeader())
            .send({
                username: "pepper",
                password: "pwd-1234",
            });
        const pepperToken = await passwordLogin("pepper", "pwd-1234");

        const deviceRes = await request(app)
            .post("/api/devices")
            .set("authorization", `Bearer ${pepperToken}`)
            .send({ name: "phone" });
        expect(deviceRes.status).toBe(201);

        const revoke = await request(app)
            .delete(`/api/devices/${deviceRes.body.device.id}`)
            .set("authorization", `Bearer ${pepperToken}`);
        expect(revoke.status).toBe(204);
    });

    it("blocks a user from revoking another user's device", async () => {
        const lukeId = store.getUserByUsername("luke")!.id;
        const material = generateDeviceToken();
        const lukeDevice = store.createDevice(
            lukeId,
            "unlisted",
            material.tokenHash,
            material.prefix,
        );
        const pepperToken = await passwordLogin("pepper", "pwd-1234");

        const denied = await request(app)
            .delete(`/api/devices/${lukeDevice.id}`)
            .set("authorization", `Bearer ${pepperToken}`);
        expect(denied.status).toBe(403);
    });

    it("answers 404 for a nonexistent or malformed device id", async () => {
        const pepperToken = await passwordLogin("pepper", "pwd-1234");
        const missing = await request(app)
            .delete("/api/devices/999999")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(missing.status).toBe(404);

        const bogus = await request(app)
            .delete("/api/devices/nope")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(bogus.status).toBe(404);
    });
});

describe("users (owner-only)", () => {
    it("lists users as the owner", async () => {
        const res = await request(app)
            .get("/api/users")
            .set("authorization", await ownerHeader());
        expect(res.status).toBe(200);
        const names = res.body.map((u: { username: string }) => u.username);
        expect(names).toContain("luke");
        expect(names).toContain("pepper");
    });

    it("rejects non-owners from user management", async () => {
        const pepperToken = await passwordLogin("pepper", "pwd-1234");
        const res = await request(app)
            .get("/api/users")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/owner access/);
    });
});

describe("sessions", () => {
    it("lists and deletes only the caller's owned sessions", async () => {
        const pepperToken = await passwordLogin("pepper", "pwd-1234");
        const pepperId = store.getUserByUsername("pepper")!.id;
        const ownerId = store.getUserByUsername("luke")!.id;

        store.claimSession("pepper-conversation", {
            userId: pepperId,
            deviceId: null,
            kind: "text",
        });
        store.claimSession("owner-conversation", {
            userId: ownerId,
            deviceId: null,
            kind: "text",
        });

        const list = await request(app)
            .get("/api/sessions")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(list.status).toBe(200);
        expect(list.body.map((s: { threadId: string }) => s.threadId)).toEqual([
            "pepper-conversation",
        ]);

        const deleteOther = await request(app)
            .delete("/api/sessions/owner-conversation")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(deleteOther.status).toBe(404);
        expect(store.getSessionByThread("owner-conversation")).not.toBeNull();

        const deleteOwn = await request(app)
            .delete("/api/sessions/pepper-conversation")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(deleteOwn.status).toBe(204);
        expect(store.getSessionByThread("pepper-conversation")).toBeNull();
    });

    it("lets the owner delete any user's session", async () => {
        const pepperId = store.getUserByUsername("pepper")!.id;
        store.claimSession("pepper-again", {
            userId: pepperId,
            deviceId: null,
            kind: "text",
        });

        const res = await request(app)
            .delete("/api/sessions/pepper-again")
            .set("authorization", await ownerHeader());
        expect(res.status).toBe(204);
        expect(store.getSessionByThread("pepper-again")).toBeNull();
    });
});

/** The `name=value` pair of the session cookie from a Set-Cookie response. */
function sessionCookiePair(res: request.Response, secure = false): string {
    const prefix = secure ? "__Host-jarvis_session=" : "jarvis_session=";
    const header = (
        (res.headers["set-cookie"] as unknown as string[]) ?? []
    ).find((c) => c.startsWith(prefix));
    expect(header).toBeTruthy();
    return header!.split(";")[0];
}

describe("cookie sessions", () => {
    it("logs in via cookie and uses it for the API", async () => {
        const login = await request(app).post("/api/session").send({
            username: "pepper",
            password: "pwd-1234",
        });
        expect(login.status).toBe(201);
        expect(login.body.csrfToken).toBeTruthy();
        expect(login.body.user.username).toBe("pepper");
        const cookie = sessionCookiePair(login);

        const me = await request(app).get("/api/me").set("Cookie", cookie);
        expect(me.status).toBe(200);
        expect(me.body.user.username).toBe("pepper");
    });

    it("reports the session user via GET /api/session", async () => {
        const login = await request(app).post("/api/session").send({
            username: "pepper",
            password: "pwd-1234",
        });
        const cookie = sessionCookiePair(login);

        const session = await request(app)
            .get("/api/session")
            .set("Cookie", cookie);
        expect(session.status).toBe(200);
        expect(session.body.user.username).toBe("pepper");
        expect(session.body.user.id).toBe(
            store.getUserByUsername("pepper")!.id,
        );

        const unauth = await request(app).get("/api/session");
        expect(unauth.status).toBe(401);
    });

    it("rejects an unknown or malformed cookie", async () => {
        const unknown = await request(app)
            .get("/api/me")
            .set("Cookie", "jarvis_session=not-a-real-token");
        expect(unknown.status).toBe(401);

        const absent = await request(app).get("/api/me");
        expect(absent.status).toBe(401);
    });

    it("logs out by revoking the cookie", async () => {
        const login = await request(app).post("/api/session").send({
            username: "pepper",
            password: "pwd-1234",
        });
        const cookie = sessionCookiePair(login);

        const logout = await request(app)
            .delete("/api/session")
            .set("Cookie", cookie)
            .set("x-csrf-token", login.body.csrfToken);
        expect(logout.status).toBe(204);
        expect(
            ((logout.headers["set-cookie"] as unknown as string[]) ?? []).join(
                "; ",
            ),
        ).toContain("jarvis_session=;");

        const me = await request(app).get("/api/me").set("Cookie", cookie);
        expect(me.status).toBe(401);
    });

    it("lets a cookie session manage its own device with the CSRF nonce", async () => {
        const login = await request(app).post("/api/session").send({
            username: "pepper",
            password: "pwd-1234",
        });
        const cookie = sessionCookiePair(login);

        const created = await request(app)
            .post("/api/devices")
            .set("Cookie", cookie)
            .set("x-csrf-token", login.body.csrfToken)
            .send({ deviceName: "portal-phone" });
        expect(created.status).toBe(201);

        const revoked = await request(app)
            .delete(`/api/devices/${created.body.device.id}`)
            .set("Cookie", cookie)
            .set("x-csrf-token", login.body.csrfToken);
        expect(revoked.status).toBe(204);
    });
});

describe("CSRF protection", () => {
    it("requires the nonce for cookie-authed mutations", async () => {
        const login = await request(app).post("/api/session").send({
            username: "pepper",
            password: "pwd-1234",
        });
        const cookie = sessionCookiePair(login);

        const missing = await request(app)
            .put("/api/prefs")
            .set("Cookie", cookie)
            .send({ theme: "dark" });
        expect(missing.status).toBe(403);
        expect(missing.body.error).toMatch(/csrf token/i);

        const wrong = await request(app)
            .put("/api/prefs")
            .set("Cookie", cookie)
            .set("x-csrf-token", "not-the-nonce")
            .send({ theme: "dark" });
        expect(wrong.status).toBe(403);
        expect(wrong.body.error).toMatch(/invalid csrf/i);

        const ok = await request(app)
            .put("/api/prefs")
            .set("Cookie", cookie)
            .set("x-csrf-token", login.body.csrfToken)
            .send({ theme: "dark" });
        expect(ok.status).toBe(200);
    });

    it("exempts bearer-authenticated mutations", async () => {
        const token = await passwordLogin("pepper", "pwd-1234");
        const res = await request(app)
            .put("/api/prefs")
            .set("authorization", `Bearer ${token}`)
            .send({ bearerPref: true });
        expect(res.status).toBe(200);
    });
});

describe("prefs", () => {
    /** Creates a throwaway user (isolated prefs) and returns a bearer token. */
    async function prefsUser(username: string): Promise<string> {
        await request(app)
            .post("/api/users")
            .set("authorization", await ownerHeader())
            .send({ username, password: "pwd-1234" });
        return passwordLogin(username, "pwd-1234");
    }

    it("round-trips typed values per user", async () => {
        const token = await prefsUser("prefs-roundtrip");
        const cookieLogin = await request(app).post("/api/session").send({
            username: "prefs-roundtrip",
            password: "pwd-1234",
        });

        const empty = await request(app)
            .get("/api/prefs")
            .set("authorization", `Bearer ${token}`);
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({});

        const value = { layout: { panels: ["a", "b"] }, volume: 7.5, on: true };
        const put = await request(app)
            .put("/api/prefs")
            .set("authorization", `Bearer ${token}`)
            .send(value);
        expect(put.status).toBe(200);
        expect(put.body).toEqual(value);

        const got = await request(app)
            .get("/api/prefs")
            .set("Cookie", sessionCookiePair(cookieLogin));
        expect(got.status).toBe(200);
        expect(got.body).toEqual(value);
    });

    it("isolates prefs between users; the owner can read/write any user's", async () => {
        const ownerToken = await ownerHeader();
        const guestToken = await prefsUser("prefs-guest");
        const guestId = store.getUserByUsername("prefs-guest")!.id;
        const guestValue = { accent: "blue", layout: "grid" };

        const set = await request(app)
            .put("/api/prefs")
            .set("authorization", `Bearer ${guestToken}`)
            .send(guestValue);
        expect(set.status).toBe(200);

        const ownerRead = await request(app)
            .get(`/api/users/${guestId}/prefs`)
            .set("authorization", ownerToken);
        expect(ownerRead.status).toBe(200);
        expect(ownerRead.body).toEqual(guestValue);

        const put = await request(app)
            .put(`/api/users/${guestId}/prefs`)
            .set("authorization", ownerToken)
            .send({ ownerSet: "yes" });
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ ...guestValue, ownerSet: "yes" });

        // The owner's own prefs are NOT the guest's.
        const own = await request(app)
            .get("/api/prefs")
            .set("authorization", ownerToken);
        expect(own.body).not.toHaveProperty("ownerSet");
    });

    it("lets the owner view prefs but a non-owner cannot", async () => {
        const pepperToken = await passwordLogin("pepper", "pwd-1234");
        const ownerId = store.getUserByUsername("luke")!.id;
        const denied = await request(app)
            .get(`/api/users/${ownerId}/prefs`)
            .set("authorization", `Bearer ${pepperToken}`);
        expect(denied.status).toBe(403);
    });

    it("rejects invalid prefs bodies", async () => {
        const token = await prefsUser("prefs-invalid");
        const tooMany = Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => [`key-${i}`, i]),
        );
        const res = await request(app)
            .put("/api/prefs")
            .set("authorization", `Bearer ${token}`)
            .send(tooMany);
        expect(res.status).toBe(400);

        const notObject = await request(app)
            .put("/api/prefs")
            .set("authorization", `Bearer ${token}`)
            .send([{ key: "a", value: 1 }]);
        expect(notObject.status).toBe(400);

        const nonJson = await request(app)
            .put("/api/prefs")
            .set("authorization", `Bearer ${token}`)
            .send({ exploding: undefined });
        expect(nonJson.status).toBe(400);
    });
});

describe("user role + disabled management", () => {
    afterEach(() => {
        // Pepper ended the flagged tests in an enabled state so the shared app
        // stays usable by later suites regardless of which test ran last.
        const pepper = store.getUserByUsername("pepper");
        if (pepper) {
            store.setUserDisabled(pepper.id, false);
        }
    });

    it("rejects a second owner and demotes the owner (fresh app)", async () => {
        const fresh = new SqliteAppDatabase(new Database(":memory:"));
        try {
            const freshApp = createApp(fresh, {
                ...FAST,
                appDbPath: ":memory:",
                bootstrapToken: BOOTSTRAP,
            });
            const boot = await request(freshApp)
                .post("/api/bootstrap")
                .set("x-bootstrap-token", BOOTSTRAP)
                .send({ username: "first-guy", password: "hunter2pw" });
            const ownerToken = boot.body.device.token;
            const second = await request(freshApp)
                .post("/api/users")
                .set("authorization", `Bearer ${ownerToken}`)
                .send({ username: "second-guy", password: "hunter2pw" });
            expect(second.status).toBe(201);

            // A second owner is rejected while one exists.
            const clash = await request(freshApp)
                .patch(`/api/users/${second.body.user.id}`)
                .set("authorization", `Bearer ${ownerToken}`)
                .send({ role: "owner" });
            expect(clash.status).toBe(409);
            expect(clash.body.error).toMatch(/owner already exists/i);

            // The sole owner may demote themselves (the store allows a zero-
            // owner state, though re-promotion needs a re-bootstrap).
            const demote = await request(freshApp)
                .patch(`/api/users/${boot.body.user.id}`)
                .set("authorization", `Bearer ${ownerToken}`)
                .send({ role: "user" });
            expect(demote.status).toBe(200);
            expect(demote.body.user.role).toBe("user");
        } finally {
            fresh.close();
        }
    });

    it("disabling a user revokes their credentials instantly; re-enable restores", async () => {
        const pepperId = store.getUserByUsername("pepper")!.id;
        const pepperToken = await passwordLogin("pepper", "pwd-1234");
        expect(
            (
                await request(app)
                    .get("/api/me")
                    .set("authorization", `Bearer ${pepperToken}`)
            ).status,
        ).toBe(200);

        const disable = await request(app)
            .patch(`/api/users/${pepperId}`)
            .set("authorization", await ownerHeader())
            .send({ disabled: true });
        expect(disable.status).toBe(200);
        expect(disable.body.user.disabled).toBe(true);

        const stale = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(stale.status).toBe(401);

        const enable = await request(app)
            .patch(`/api/users/${pepperId}`)
            .set("authorization", await ownerHeader())
            .send({ disabled: false });
        expect(enable.status).toBe(200);
        const restored = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(restored.status).toBe(200);
    });

    it("rejects a disabled account at both login endpoints", async () => {
        const pepperId = store.getUserByUsername("pepper")!.id;
        await request(app)
            .patch(`/api/users/${pepperId}`)
            .set("authorization", await ownerHeader())
            .send({ disabled: true });

        const session = await request(app).post("/api/session").send({
            username: "pepper",
            password: "pwd-1234",
        });
        expect(session.status).toBe(403);
        expect(session.body.error).toMatch(/disabled/i);

        const device = await request(app).post("/api/auth/login").send({
            username: "pepper",
            password: "pwd-1234",
        });
        expect(device.status).toBe(403);
        expect(device.body.error).toMatch(/disabled/i);
    });

    it("rejects disabling your own account", async () => {
        const lukeId = store.getUserByUsername("luke")!.id;
        const res = await request(app)
            .patch(`/api/users/${lukeId}`)
            .set("authorization", await ownerHeader())
            .send({ disabled: true });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/own account/i);
        expect(store.getUserById(lukeId)?.disabled).toBe(false);
    });

    it("requires role/disabled and validates them", async () => {
        const pepperId = store.getUserByUsername("pepper")!.id;
        const none = await request(app)
            .patch(`/api/users/${pepperId}`)
            .set("authorization", await ownerHeader())
            .send({});
        expect(none.status).toBe(400);

        const badRole = await request(app)
            .patch(`/api/users/${pepperId}`)
            .set("authorization", await ownerHeader())
            .send({ role: "superuser" });
        expect(badRole.status).toBe(400);

        const badDisabled = await request(app)
            .patch(`/api/users/${pepperId}`)
            .set("authorization", await ownerHeader())
            .send({ disabled: "yes" });
        expect(badDisabled.status).toBe(400);
    });
});

describe("device rename", () => {
    it("renames an owned device and rejects cross-user renames", async () => {
        const lukeId = store.getUserByUsername("luke")!.id;
        const ownerDevice = store.createDevice(
            lukeId,
            "owner-laptop",
            "hash-a",
            "aaaa1234",
        );
        const pepperToken = await passwordLogin("pepper", "pwd-1234");

        const denied = await request(app)
            .patch(`/api/devices/${ownerDevice.id}`)
            .set("authorization", `Bearer ${pepperToken}`)
            .send({ name: "stolen" });
        expect(denied.status).toBe(403);

        const own = await request(app)
            .patch(`/api/devices/${ownerDevice.id}`)
            .set("authorization", await ownerHeader())
            .send({ name: "owner-macbook" });
        expect(own.status).toBe(200);
        expect(own.body.device.name).toBe("owner-macbook");
        expect(store.getDeviceById(ownerDevice.id)?.name).toBe("owner-macbook");
        store.revokeDevice(ownerDevice.id);
    });

    it("rejects a rename clashing with a same-user device name", async () => {
        const pepperId = store.getUserByUsername("pepper")!.id;
        store.createDevice(pepperId, "phone", "hash-a", "aaaa1234");
        const tablet = store.createDevice(
            pepperId,
            "tablet",
            "hash-b",
            "bbbb1234",
        );
        const pepperToken = await passwordLogin("pepper", "pwd-1234");

        const clash = await request(app)
            .patch(`/api/devices/${tablet.id}`)
            .set("authorization", `Bearer ${pepperToken}`)
            .send({ name: "phone" });
        expect(clash.status).toBe(400);
    });
});

describe("sessions (owner-wide)", () => {
    it("shows the owner every session with its userId", async () => {
        // A throwaway user (isolated state) for the non-owner view.
        await request(app)
            .post("/api/users")
            .set("authorization", await ownerHeader())
            .send({ username: "sessions-viewer", password: "pwd-1234" });
        const viewerId = store.getUserByUsername("sessions-viewer")!.id;
        const viewer = await passwordLogin("sessions-viewer", "pwd-1234");

        const lukeId = store.getUserByUsername("luke")!.id;
        store.claimSession("owner-wide-a", {
            userId: lukeId,
            deviceId: null,
            kind: "text",
        });
        store.claimSession("owner-wide-b", {
            userId: viewerId,
            deviceId: null,
            kind: "text",
        });

        const ownerView = await request(app)
            .get("/api/sessions")
            .set("authorization", await ownerHeader());
        expect(ownerView.status).toBe(200);
        const all = ownerView.body as {
            threadId: string;
            userId: number | null;
        }[];
        const byThread = new Map(all.map((s) => [s.threadId, s.userId]));
        expect(byThread.get("owner-wide-a")).toBe(lukeId);
        expect(byThread.get("owner-wide-b")).toBe(viewerId);

        const viewerView = await request(app)
            .get("/api/sessions")
            .set("authorization", `Bearer ${viewer}`);
        expect(viewerView.status).toBe(200);
        expect(Array.isArray(viewerView.body)).toBe(true);
        const viewerThreads = (viewerView.body as { threadId: string }[]).map(
            (s) => s.threadId,
        );
        expect(viewerThreads).toContain("owner-wide-b");
        expect(viewerThreads).not.toContain("owner-wide-a");

        store.deleteSession("owner-wide-a");
        store.deleteSession("owner-wide-b");
    });
});

describe("cookie attributes", () => {
    it("uses a plain cookie without Secure on plain HTTP", async () => {
        const fresh = new SqliteAppDatabase(new Database(":memory:"));
        try {
            const freshApp = createApp(fresh, FAST);
            await request(freshApp)
                .post("/api/bootstrap")
                .set("x-bootstrap-token", BOOTSTRAP)
                .send({ username: "plain-owner", password: "hunter2pw" });
            const login = await request(freshApp).post("/api/session").send({
                username: "plain-owner",
                password: "hunter2pw",
            });
            const header = (
                login.headers["set-cookie"] as unknown as string[]
            )[0];
            expect(header).toContain("jarvis_session=");
            expect(header).not.toContain("__Host-");
            expect(header).not.toContain("Secure");
            expect(header).toContain("HttpOnly");
            expect(header).toContain("SameSite=Strict");
        } finally {
            fresh.close();
        }
    });

    it("uses a __Host- cookie with Secure under TLS", async () => {
        const fresh = new SqliteAppDatabase(new Database(":memory:"));
        try {
            const tls: AppConfig & { bootstrapToken: string } = {
                ...FAST,
                tlsCertPath: "/tmp/fake-cert.pem",
                tlsKeyPath: "/tmp/fake-key.pem",
            };
            const freshApp = createApp(fresh, tls);
            await request(freshApp)
                .post("/api/bootstrap")
                .set("x-bootstrap-token", BOOTSTRAP)
                .send({ username: "tls-owner", password: "hunter2pw" });
            const login = await request(freshApp).post("/api/session").send({
                username: "tls-owner",
                password: "hunter2pw",
            });
            const header = (
                login.headers["set-cookie"] as unknown as string[]
            )[0];
            expect(header).toContain("__Host-jarvis_session=");
            expect(header).toContain("Secure");
        } finally {
            fresh.close();
        }
    });
});
