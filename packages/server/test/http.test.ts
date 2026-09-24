import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
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
