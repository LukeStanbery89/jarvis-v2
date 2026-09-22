import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../src/app";
import { SqliteAppStore, generateDeviceToken } from "../src/auth";
import type { AppStore } from "../src/auth";
import type { AppConfig } from "../src/config";

const FAST: AppConfig & { bootstrapToken: string } = {
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: "s3cret-bootstrap",
};

const store = new SqliteAppStore(new Database(":memory:")) as AppStore;

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
            return `Bearer ${await passwordLogin("luke", "hunter2")}`;
        }
        const res = await request(app)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", FAST.bootstrapToken)
            .send({ username: "luke", password: "hunter2" });
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
        const missing = await request(app).post("/api/bootstrap").send({
            username: "intruder",
            password: "x",
        });
        expect(missing.status).toBe(403);

        const wrong = await request(app)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", "wrong")
            .send({ username: "intruder", password: "x" });
        expect(wrong.status).toBe(403);
    });

    it("creates the owner and returns a working device token", async () => {
        const res = await request(app)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", FAST.bootstrapToken)
            .send({
                username: "luke",
                password: "hunter2",
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
        const again = await request(app)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", FAST.bootstrapToken)
            .send({ username: "second-owner", password: "x" });
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/owner already exists/);
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
        const token = await passwordLogin("luke", "hunter2", "cli");
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
        const first = await passwordLogin("luke", "hunter2", "cli");
        const afterFirst = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${first}`);

        const second = await passwordLogin("luke", "hunter2", "cli");
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
            password: "wrong",
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

    it("rejects login before an owner is bootstrapped", async () => {
        const freshStore = new SqliteAppStore(new Database(":memory:"));
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
                password: "pw",
            });
        const pepperToken = await passwordLogin("pepper", "pw");

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
        const pepperToken = await passwordLogin("pepper", "pw");

        const denied = await request(app)
            .delete(`/api/devices/${lukeDevice.id}`)
            .set("authorization", `Bearer ${pepperToken}`);
        expect(denied.status).toBe(403);
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
        const pepperToken = await passwordLogin("pepper", "pw");
        const res = await request(app)
            .get("/api/users")
            .set("authorization", `Bearer ${pepperToken}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/owner access/);
    });
});

describe("sessions", () => {
    it("lists and deletes only the caller's owned sessions", async () => {
        const pepperToken = await passwordLogin("pepper", "pw");
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
});
