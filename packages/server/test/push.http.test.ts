/**
 * Web Push subscription routes (#189 follow-up).
 *
 * These are the browser's registration surface, not the delivery channel: the
 * route owns auth, CSRF, validation and the account's endpoint rows, while
 * `notify/channels/webPush` owns sending. The test checks the route contract
 * and that the stored row belongs to the caller.
 */
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppConfig } from "../src/config";

const PUSH: NonNullable<AppConfig["push"]> = {
    publicKey: "public-vapid-key",
    privateKey: "private-vapid-key",
    subject: "mailto:test@example.com",
};

function config(push: AppConfig["push"]): AppConfig {
    return {
        appDbPath: ":memory:",
        turnTimeoutMs: 30_000,
        bootstrapToken: "push-bootstrap",
        push,
    };
}

async function owner(
    store: ReturnType<typeof createInMemoryAppDatabase>,
    app: ReturnType<typeof createApp>,
): Promise<{ id: number; token: string }> {
    const bootstrap = await request(app)
        .post("/api/bootstrap")
        .set("x-bootstrap-token", "push-bootstrap")
        .send({ username: "luke", password: "hunter2pw", deviceName: "phone" });
    expect(bootstrap.status).toBe(201);
    const user = store.getUserByUsername("luke");
    if (!user) {
        throw new Error("bootstrap did not create the owner");
    }
    return { id: user.id, token: bootstrap.body.device.token as string };
}

const SUBSCRIPTION = {
    endpoint: "https://push.example/subscription",
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
};

describe("push routes", () => {
    const stores: ReturnType<typeof createInMemoryAppDatabase>[] = [];

    afterEach(() => {
        for (const store of stores.splice(0)) {
            store.close();
        }
    });

    function setup(push: AppConfig["push"]) {
        const store = createInMemoryAppDatabase();
        stores.push(store);
        const app = createApp(store, config(push));
        return { store, app };
    }

    it("serves the public key and stores/removes a browser subscription", async () => {
        const { store, app } = setup(PUSH);
        const me = await owner(store, app);
        const auth = `Bearer ${me.token}`;

        const key = await request(app)
            .get("/api/push/key")
            .set("authorization", auth);
        expect(key.status).toBe(200);
        expect(key.body).toEqual({ publicKey: PUSH.publicKey });

        const subscribed = await request(app)
            .post("/api/push/subscribe")
            .set("authorization", auth)
            .send(SUBSCRIPTION);
        expect(subscribed.status).toBe(204);
        const [device] = store.listDevicesByUser(me.id);
        expect(store.listPushSubscriptions(me.id)).toEqual([
            expect.objectContaining({
                endpoint: SUBSCRIPTION.endpoint,
                p256dh: SUBSCRIPTION.keys.p256dh,
                auth: SUBSCRIPTION.keys.auth,
                // #194: the row is attributable to the browser's device, so a
                // targeted timer can select it.
                deviceId: device.id,
            }),
        ]);

        const removed = await request(app)
            .post("/api/push/unsubscribe")
            .set("authorization", auth)
            .send({ endpoint: SUBSCRIPTION.endpoint });
        expect(removed.status).toBe(204);
        expect(store.listPushSubscriptions(me.id)).toEqual([]);
    });

    it("requires auth and rejects a non-HTTPS push endpoint", async () => {
        const { store, app } = setup(PUSH);
        const unauth = await request(app).get("/api/push/key");
        expect(unauth.status).toBe(401);

        const me = await owner(store, app);
        const bad = await request(app)
            .post("/api/push/subscribe")
            .set("authorization", `Bearer ${me.token}`)
            .send({
                endpoint: "http://push.example/subscription",
                keys: { p256dh: "key", auth: "secret" },
            });
        expect(bad.status).toBe(400);
        expect(store.listPushSubscriptions(me.id)).toEqual([]);
    });

    it("answers 503 when the deployment has no VAPID pair", async () => {
        const { store, app } = setup(undefined);
        const me = await owner(store, app);
        const key = await request(app)
            .get("/api/push/key")
            .set("authorization", `Bearer ${me.token}`);
        expect(key.status).toBe(503);
    });
});
