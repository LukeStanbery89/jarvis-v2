/**
 * REST contract-verification smoke tests.
 *
 * Runs `createApp` with `apiContractVerify: true`, so the validator mounted
 * ahead of `/api` checks request AND response shapes against
 * `@lukestanbery/jarvis-contracts`' `spec/openapi.yaml`. If a real payload
 * ever drifts from the spec, its documented status flips to a 500 and these
 * tests fail. A canary test tampers the store into serving a spec-invalid
 * payload and expects the documented 500, so the suite also fails if the
 * validator ever stops mounting. The other suites run with responses
 * unverified on purpose: they pin behavior, this one pins the contract.
 */
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../src/app";
import { SqliteAppDatabase } from "@lukestanbery/jarvis-auth";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import type { AppConfig } from "../src/config";

const VERIFY: AppConfig = {
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: "s3cret-bootstrap",
    apiContractVerify: true,
};

const store = new SqliteAppDatabase(new Database(":memory:")) as AppDatabase;
const app = createApp(store, VERIFY);

afterAll(() => {
    store.close();
});

/** Owner device token (set by the bootstrap test). */
let ownerToken: string;
/** Cookie-login artifacts (set by the session-login test). */
let cookie: string;
let csrfToken: string;
/** A device provisioned through /api/devices (set by the devices test). */
let deviceId: number;

describe("REST contract verification", () => {
    it("bootstraps the owner and validates the issued credential payload", async () => {
        const res = await request(app)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", VERIFY.bootstrapToken!)
            .send({
                username: "luke",
                password: "owner-password-1",
                deviceName: "contract-test",
            });
        expect(res.status).toBe(201);
        expect(res.body.user.role).toBe("owner");
        expect(typeof res.body.device.token).toBe("string");
        ownerToken = res.body.device.token;
    });

    it("issues a device-token login", async () => {
        const res = await request(app).post("/api/auth/login").send({
            username: "luke",
            password: "owner-password-1",
            deviceName: "contract-login",
        });
        expect(res.status).toBe(200);
        expect(res.body.device).toHaveProperty("token");
    });

    it("echoes the account + devices for a bearer caller", async () => {
        const res = await request(app)
            .get("/api/me")
            .set("authorization", `Bearer ${ownerToken}`);
        expect(res.status).toBe(200);
        expect(res.body.user.username).toBe("luke");
        expect(Array.isArray(res.body.devices)).toBe(true);
    });

    it("shapes bearer failures as the declared Error", async () => {
        const res = await request(app)
            .get("/api/me")
            .set("authorization", "Bearer not-a-token");
        expect(res.status).toBe(401);
        expect(typeof res.body.error).toBe("string");
    });

    it("logs in over a cookie session and echoes it back", async () => {
        const login = await request(app).post("/api/session").send({
            username: "luke",
            password: "owner-password-1",
        });
        expect(login.status).toBe(201);
        expect(typeof login.body.csrfToken).toBe("string");
        expect(typeof login.body.expiresAt).toBe("string");
        csrfToken = login.body.csrfToken;
        cookie = login.headers["set-cookie"][0].split(";")[0];

        const echo = await request(app)
            .get("/api/session")
            .set("cookie", cookie);
        expect(echo.status).toBe(200);
        expect(echo.body.user.username).toBe("luke");
        expect(echo.body.csrfToken).toBe(csrfToken);
    });

    it("answers the machine health check", async () => {
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });

    it("stores arbitrary JSON prefs and reads them back", async () => {
        const prefs = { theme: { mode: "dark", accent: 2 }, count: 2 };
        const put = await request(app)
            .put("/api/prefs")
            .set("cookie", cookie)
            .set("x-csrf-token", csrfToken)
            .send(prefs);
        expect(put.status).toBe(200);

        const get = await request(app).get("/api/prefs").set("cookie", cookie);
        expect(get.status).toBe(200);
        expect(get.body).toEqual(prefs);
    });

    it("provisions, renames, and revokes a device", async () => {
        const provisioned = await request(app)
            .post("/api/devices")
            .set("authorization", `Bearer ${ownerToken}`)
            .send({ deviceName: "contract-device" });
        expect(provisioned.status).toBe(201);
        deviceId = provisioned.body.device.id;

        const renamed = await request(app)
            .patch(`/api/devices/${deviceId}`)
            .set("authorization", `Bearer ${ownerToken}`)
            .send({ name: "contract-renamed" });
        expect(renamed.status).toBe(200);
        expect(renamed.body.device.name).toBe("contract-renamed");

        const revoked = await request(app)
            .delete(`/api/devices/${deviceId}`)
            .set("authorization", `Bearer ${ownerToken}`);
        expect(revoked.status).toBe(204);
    });

    it("lists chat sessions for the owner", async () => {
        const res = await request(app)
            .get("/api/sessions")
            .set("authorization", `Bearer ${ownerToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it("rejects a body missing a required field before any handler runs", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ username: "luke" });
        expect(res.status).toBe(400);
        expect(typeof res.body.error).toBe("string");
    });

    it("fails loudly when a served payload violates the contract", async () => {
        // Canary for the response-verification path: tamper the store into
        // serving a user role the spec's enum does not allow. With the gate
        // active this is answered 500 (validator, generic body); without it
        // the bogus payload would sail out as 200.
        const tampered = new SqliteAppDatabase(
            new Database(":memory:"),
        ) as AppDatabase;
        const tamperedApp = createApp(tampered, VERIFY);
        const boot = await request(tamperedApp)
            .post("/api/bootstrap")
            .set("x-bootstrap-token", VERIFY.bootstrapToken!)
            .send({ username: "owner", password: "owner-password-1" });
        expect(boot.status).toBe(201);

        const listUsers = tampered.listUsers.bind(tampered);
        (tampered as unknown as { listUsers: () => unknown }).listUsers = () =>
            (listUsers() as { role: string }[]).map((u) => ({
                ...u,
                role: "bogus",
            }));

        const res = await request(tamperedApp)
            .get("/api/users")
            .set("authorization", `Bearer ${boot.body.device.token}`);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "internal server error" });

        tampered.close();
    });
});
