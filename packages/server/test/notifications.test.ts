/**
 * Notification tests (#139 phase 1): the store ledger, the delivery policy, and
 * the REST surface.
 *
 * Split three ways on purpose, because they fail for different reasons:
 *
 * - **Store** (`SqliteAppDatabase`) — the table, the transitions, and the
 *   terminal-state guard, against a real `:memory:` database.
 * - **Service** — the policy: presence-first delivery, quiet hours, the
 *   per-user delivery budget, and what is *recorded* versus *pushed*, with an
 *   injected clock and a fake hub so nothing here is timing-dependent.
 * - **Routes** — the REST surface over supertest, including the parts that are
 *   easy to get wrong: per-caller scoping (a foreign id is a 404, never a 403
 *   that would confirm it exists) and the outcome fields a producer reads.
 *
 * The in-app channel is exercised for real (a fake socket through the real
 * hub), so a change to the frame mapping or the registry shows up here.
 */
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { generateDeviceToken } from "@lukestanbery/jarvis-auth";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { createApp } from "../src/app";
import { getAppConfig } from "../src/config";
import type { AppConfig } from "../src/config";
import { createNotificationHub } from "../src/notify/hub";
import type { HubSocket, NotificationHub } from "../src/notify/hub";
import { createInAppChannel } from "../src/notify/channels/inApp";
import { createNotificationService } from "../src/notify/service";
import type { NotificationService } from "../src/notify/service";

/** A socket double that records what the hub pushed to it. */
function fakeSocket(): HubSocket & { frames: ServerFrame[] } {
    const frames: ServerFrame[] = [];
    return {
        readyState: 1,
        frames,
        send(data: string) {
            frames.push(JSON.parse(data) as ServerFrame);
        },
    };
}

/** Builds a service over a fresh in-memory store, with an injectable clock. */
function makeService(options: {
    at?: Date;
    deliveriesPerWindow?: number;
    maxPerUser?: number;
    store?: AppDatabase;
}): {
    store: AppDatabase;
    hub: NotificationHub;
    service: NotificationService;
    socket: ReturnType<typeof fakeSocket>;
} {
    const store = options.store ?? createInMemoryAppDatabase();
    const hub = createNotificationHub();
    const socket = fakeSocket();
    const service = createNotificationService({
        store,
        hub,
        channels: [createInAppChannel(hub)],
        maxPerUser: options.maxPerUser ?? 200,
        deliveriesPerWindow: options.deliveriesPerWindow ?? 20,
        now: () => options.at ?? new Date("2026-10-15T18:00:00.000Z"),
    });
    return { store, hub, service, socket };
}

/** Creates one user and returns its id. */
function makeUser(store: AppDatabase): number {
    return store.createUser("luke", "hash", "owner").id;
}

describe("notification store (#139)", () => {
    let store: AppDatabase;
    let userId: number;

    beforeEach(() => {
        store = createInMemoryAppDatabase();
        userId = makeUser(store);
    });

    it("stores a notification as pending and reads it back", () => {
        const created = store.createNotification(userId, {
            id: "n1",
            kind: "job.finished",
            priority: "normal",
            title: "PR #143 is ready",
            requiresAnswer: false,
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        expect(created.state).toBe("pending");
        expect(created.body).toBeNull();
        expect(created.deliveredAt).toBeNull();
        expect(created.settledAt).toBeNull();
        expect(store.getNotification(userId, "n1")).toEqual(created);
    });

    it("lists newest first and counts the unread", () => {
        for (const [id, at] of [
            ["a", "2026-10-15T10:00:00.000Z"],
            ["b", "2026-10-15T11:00:00.000Z"],
            ["c", "2026-10-15T12:00:00.000Z"],
        ]) {
            store.createNotification(userId, {
                id,
                kind: "k",
                priority: "low",
                title: id,
                createdAt: at,
            });
        }
        expect(store.listNotifications(userId).map((n) => n.id)).toEqual([
            "c",
            "b",
            "a",
        ]);
        expect(store.countUnreadNotifications(userId)).toBe(3);

        store.setNotificationState(userId, "b", "read");
        expect(store.countUnreadNotifications(userId)).toBe(2);
        expect(
            store.listNotifications(userId, { limit: 2 }).map((n) => n.id),
        ).toEqual(["c", "b"]);
    });

    it("hides dismissed notifications unless asked for them", () => {
        store.createNotification(userId, {
            id: "a",
            kind: "k",
            priority: "low",
            title: "a",
            createdAt: "2026-10-15T10:00:00.000Z",
        });
        store.setNotificationState(userId, "a", "dismissed");
        expect(store.listNotifications(userId)).toEqual([]);
        expect(
            store
                .listNotifications(userId, { includeDismissed: true })
                .map((n) => n.id),
        ).toEqual(["a"]);
    });

    it("stamps delivered_at on delivery and settled_at on a terminal state", () => {
        store.createNotification(userId, {
            id: "a",
            kind: "k",
            priority: "low",
            title: "a",
            createdAt: "2026-10-15T10:00:00.000Z",
        });
        const delivered = store.setNotificationState(userId, "a", "delivered");
        expect(delivered?.state).toBe("delivered");
        expect(delivered?.deliveredAt).not.toBeNull();
        expect(delivered?.settledAt).toBeNull();

        const read = store.setNotificationState(userId, "a", "read");
        expect(read?.settledAt).not.toBeNull();
        expect(read?.deliveredAt).toBe(delivered?.deliveredAt);
    });

    it("refuses to move a settled notification, returning it unchanged", () => {
        store.createNotification(userId, {
            id: "a",
            kind: "k",
            priority: "low",
            title: "a",
            createdAt: "2026-10-15T10:00:00.000Z",
        });
        store.setNotificationState(userId, "a", "read", { answer: undefined });
        const again = store.setNotificationState(userId, "a", "dismissed");
        expect(again?.state).toBe("read");
    });

    it("keeps the answer on an answered notification", () => {
        store.createNotification(userId, {
            id: "a",
            kind: "coding.question",
            priority: "high",
            title: "Which React version?",
            requiresAnswer: true,
            createdAt: "2026-10-15T10:00:00.000Z",
        });
        const answered = store.setNotificationState(userId, "a", "answered", {
            answer: "19",
        });
        expect(answered?.state).toBe("answered");
        expect(answered?.answer).toBe("19");
        expect(answered?.requiresAnswer).toBe(true);
    });

    it("scopes reads to their owner: a foreign id is indistinguishable from a missing one", () => {
        const other = store.createUser("someone-else", "hash", "user");
        store.createNotification(other.id, {
            id: "secret",
            kind: "k",
            priority: "low",
            title: "theirs",
            createdAt: "2026-10-15T10:00:00.000Z",
        });
        expect(store.getNotification(userId, "secret")).toBeNull();
        expect(store.setNotificationState(userId, "secret", "read")).toBeNull();
        // ...and the owner's row is untouched by that attempt.
        expect(store.getNotification(other.id, "secret")?.state).toBe(
            "pending",
        );
    });

    it("prunes settled notifications but never an undelivered one", () => {
        for (let i = 0; i < 5; i += 1) {
            store.createNotification(userId, {
                id: `read-${i}`,
                kind: "k",
                priority: "low",
                title: `read ${i}`,
                createdAt: `2026-10-15T0${i}:00:00.000Z`,
            });
            store.setNotificationState(userId, `read-${i}`, "read");
        }
        store.createNotification(userId, {
            id: "pending",
            kind: "k",
            priority: "high",
            title: "still waiting",
            createdAt: "2026-10-15T09:00:00.000Z",
        });
        const deleted = store.pruneNotifications(userId, 2);
        expect(deleted).toBe(3);
        const remaining = store
            .listNotifications(userId, { includeDismissed: true })
            .map((n) => n.id);
        expect(remaining).toContain("pending");
        expect(remaining).toContain("read-4");
        expect(remaining).toContain("read-3");
        expect(remaining).not.toContain("read-0");
    });
});

describe("notification service policy (#139)", () => {
    it("delivers to a present user and marks the record delivered", async () => {
        const { store, hub, service, socket } = makeService({});
        const userId = makeUser(store);
        hub.add(userId, socket);

        const outcome = await service.notify(userId, {
            kind: "job.finished",
            title: "PR #143 is ready",
            body: "4 files changed.",
        });

        expect(outcome.delivered).toBe(1);
        expect(outcome.suppressed).toBeNull();
        expect(outcome.notification.state).toBe("delivered");
        expect(socket.frames).toHaveLength(1);
        expect(socket.frames[0]).toEqual({
            notification: {
                id: outcome.notification.id,
                kind: "job.finished",
                priority: "normal",
                title: "PR #143 is ready",
                body: "4 files changed.",
                createdAt: "2026-10-15T18:00:00.000Z",
            },
        });
    });

    it("records without pushing when nobody is connected", async () => {
        const { store, service } = makeService({});
        const userId = makeUser(store);
        const outcome = await service.notify(userId, {
            kind: "reminder",
            title: "Take the medication",
        });
        expect(outcome.suppressed).toBe("absent");
        expect(outcome.delivered).toBe(0);
        // Still readable: the durable half is the point (#139).
        expect(service.list(userId).notifications).toHaveLength(1);
        expect(service.list(userId).unread).toBe(1);
    });

    it("respects the user's own switch while still recording", async () => {
        const { store, hub, service, socket } = makeService({});
        const userId = makeUser(store);
        hub.add(userId, socket);
        store.setPrefs(userId, [{ key: "notify.enabled", value: false }]);

        const outcome = await service.notify(userId, {
            kind: "k",
            title: "quiet please",
        });
        expect(outcome.suppressed).toBe("disabled");
        expect(socket.frames).toEqual([]);
        expect(service.list(userId).notifications).toHaveLength(1);
    });

    it("defers low and normal inside quiet hours but lets urgent through", async () => {
        // 23:30 in the server's LOCAL time — quiet hours are evaluated
        // against the local clock (a home server shares its user's), so the
        // instant is built from local parts rather than parsed from UTC.
        const at = new Date(2026, 9, 15, 23, 30);
        const { store, hub, service, socket } = makeService({ at });
        const userId = makeUser(store);
        hub.add(userId, socket);
        store.setPrefs(userId, [
            {
                key: "notify.quietHours",
                value: { start: "22:00", end: "07:00" },
            },
        ]);

        const quiet = await service.notify(userId, {
            kind: "k",
            priority: "normal",
            title: "not now",
        });
        expect(quiet.suppressed).toBe("quiet-hours");
        expect(socket.frames).toEqual([]);

        const loud = await service.notify(userId, {
            kind: "k",
            priority: "urgent",
            title: "now",
        });
        expect(loud.suppressed).toBeNull();
        expect(socket.frames).toHaveLength(1);
    });

    it("ignores a malformed quiet-hours pref rather than going silent", async () => {
        const at = new Date(2026, 9, 15, 23, 30);
        const { store, hub, service, socket } = makeService({ at });
        const userId = makeUser(store);
        hub.add(userId, socket);
        store.setPrefs(userId, [
            { key: "notify.quietHours", value: { start: "22:00" } },
        ]);

        const outcome = await service.notify(userId, {
            kind: "k",
            title: "still delivered",
        });
        expect(outcome.suppressed).toBeNull();
        expect(socket.frames).toHaveLength(1);
    });

    it("caps deliveries per user but keeps recording past the cap", async () => {
        const { store, hub, service, socket } = makeService({
            deliveriesPerWindow: 2,
        });
        const userId = makeUser(store);
        hub.add(userId, socket);

        await service.notify(userId, { kind: "k", title: "one" });
        await service.notify(userId, { kind: "k", title: "two" });
        const third = await service.notify(userId, {
            kind: "k",
            title: "three",
        });

        expect(third.suppressed).toBe("cap");
        expect(socket.frames).toHaveLength(2);
        expect(service.list(userId).notifications).toHaveLength(3);
    });

    it("settles a notification read, dismissed, or answered", async () => {
        const { store, service } = makeService({});
        const userId = makeUser(store);
        const question = await service.notify(userId, {
            kind: "coding.question",
            title: "Which React version?",
            requiresAnswer: true,
        });
        const answer = service.answer(
            userId,
            question.notification.id,
            "React 19",
        );
        expect(answer).toMatchObject({
            ok: true,
            notification: { state: "answered", answer: "React 19" },
        });

        const plain = await service.notify(userId, { kind: "k", title: "hi" });
        expect(service.markRead(userId, plain.notification.id)).toMatchObject({
            ok: true,
            notification: { state: "read" },
        });
        const later = await service.notify(userId, { kind: "k", title: "ho" });
        expect(service.dismiss(userId, later.notification.id)).toMatchObject({
            ok: true,
            notification: { state: "dismissed" },
        });
    });

    it("refuses an answer to a notification that did not ask one", async () => {
        const { store, service } = makeService({});
        const userId = makeUser(store);
        const plain = await service.notify(userId, { kind: "k", title: "hi" });
        expect(service.answer(userId, plain.notification.id, "sure")).toEqual({
            ok: false,
            reason: "not-answerable",
        });
        expect(service.answer(userId, "nope", "sure")).toEqual({
            ok: false,
            reason: "missing",
        });
    });

    it("supersedes an unsettled notification with the same dedupe key", async () => {
        const { store, service } = makeService({});
        const userId = makeUser(store);
        const first = await service.notify(userId, {
            kind: "job.status",
            title: "step 1 of 3",
            dedupeKey: "job-42",
        });
        const second = await service.notify(userId, {
            kind: "job.status",
            title: "step 2 of 3",
            dedupeKey: "job-42",
        });

        const list = service.list(userId).notifications;
        expect(list.map((n) => n.title)).toEqual(["step 2 of 3"]);
        // Dismissed rather than deleted: the superseded row is still on
        // record, just out of the way.
        expect(
            service
                .list(userId, { includeDismissed: true })
                .notifications.map((n) => n.id),
        ).toEqual([second.notification.id, first.notification.id]);
        expect(
            store.getNotification(userId, first.notification.id)?.state,
        ).toBe("dismissed");
    });

    it("still stacks notifications that carry no dedupe key", async () => {
        const { store, service } = makeService({});
        const userId = makeUser(store);
        await service.notify(userId, { kind: "k", title: "one" });
        await service.notify(userId, { kind: "k", title: "two" });
        expect(service.list(userId).notifications).toHaveLength(2);
    });

    it("rejects a title the protocol could not render", async () => {
        const { store, service } = makeService({});
        const userId = makeUser(store);
        await expect(
            service.notify(userId, { kind: "k", title: "x".repeat(201) }),
        ).rejects.toThrow(/title must be at most 200/);
        await expect(
            service.notify(userId, { kind: "", title: "hi" }),
        ).rejects.toThrow(/kind must be a non-empty string/);
    });
});

describe("notification routes (#139)", () => {
    let store: AppDatabase;
    let service: NotificationService;
    let hub: NotificationHub;
    let socket: ReturnType<typeof fakeSocket>;
    let token: string;
    let userId: number;
    let appConfig: AppConfig;

    beforeEach(() => {
        const made = makeService({});
        store = made.store;
        service = made.service;
        hub = made.hub;
        socket = made.socket;
        userId = makeUser(store);
        // A device token is stored as a hash: the middleware hashes the
        // presented bearer token and resolves it, so the raw secret never
        // reaches the database (or this test's fixtures).
        const material = generateDeviceToken();
        token = material.token;
        store.createDevice(
            userId,
            "web-test",
            material.tokenHash,
            material.prefix,
        );
        appConfig = {
            ...getAppConfig(),
            notify: { deliveriesPerMin: 20, maxPerUser: 200 },
        };
    });

    /** The app under test, with the notification surface wired. */
    const buildApp = () =>
        createApp(store, appConfig, undefined, undefined, service);

    it("lists, creates, and settles over HTTP", async () => {
        hub.add(userId, socket);
        const created = await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "job.finished", title: "PR #143 is ready" })
            .expect(201);
        expect(created.body.delivered).toBe(1);
        expect(created.body.suppressed).toBeNull();
        const id = created.body.notification.id as string;

        const listed = await request(buildApp())
            .get("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(listed.body.unread).toBe(1);
        expect(listed.body.notifications).toHaveLength(1);

        const read = await request(buildApp())
            .post(`/api/notifications/${id}/read`)
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(read.body.notification.state).toBe("read");

        const after = await request(buildApp())
            .get("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(after.body.unread).toBe(0);
    });

    it("answers an answerable notification and rejects the wrong kinds", async () => {
        const created = await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({
                kind: "coding.question",
                title: "Which React version?",
                requiresAnswer: true,
            })
            .expect(201);
        const id = created.body.notification.id as string;

        const answered = await request(buildApp())
            .post(`/api/notifications/${id}/answer`)
            .set("authorization", `Bearer ${token}`)
            .send({ answer: "React 19" })
            .expect(200);
        expect(answered.body.notification).toMatchObject({
            state: "answered",
            answer: "React 19",
        });

        // Already settled: 409, not a silent second answer.
        await request(buildApp())
            .post(`/api/notifications/${id}/answer`)
            .set("authorization", `Bearer ${token}`)
            .send({ answer: "again" })
            .expect(409);
    });

    it("rejects an unanswerable notification and a bad body", async () => {
        const created = await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "k", title: "informational" })
            .expect(201);

        await request(buildApp())
            .post(`/api/notifications/${created.body.notification.id}/answer`)
            .set("authorization", `Bearer ${token}`)
            .send({ answer: "sure" })
            .expect(400);

        await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "k", title: "x".repeat(201) })
            .expect(400);

        await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "k", title: "hi", priority: "apocalyptic" })
            .expect(400);
    });

    it("cannot see or settle another account's notification", async () => {
        const other = store.createUser("someone-else", "hash", "user");
        store.createNotification(other.id, {
            id: "theirs",
            kind: "k",
            priority: "low",
            title: "not yours",
            createdAt: "2026-10-15T10:00:00.000Z",
        });

        await request(buildApp())
            .post("/api/notifications/theirs/read")
            .set("authorization", `Bearer ${token}`)
            .expect(404);

        const listed = await request(buildApp())
            .get("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(listed.body.notifications).toEqual([]);
    });

    it("requires credentials", async () => {
        await request(buildApp()).get("/api/notifications").expect(401);
    });

    it("is absent entirely when the surface is not wired", async () => {
        const app = createApp(store, appConfig);
        // No router mounted: the request falls through to Express's 404
        // rather than a route that answers "disabled".
        await request(app)
            .get("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .expect(404);
    });
});
