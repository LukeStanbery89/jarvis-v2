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
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { generateDeviceToken } from "@lukestanbery/jarvis-auth";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { createApp } from "../src/app";
import { getAppConfig } from "../src/config";
import type { AppConfig } from "../src/config";
import { attachChatServer } from "../src/ws";
import { createNotificationHub } from "../src/notify/hub";
import type { HubSocket, NotificationHub } from "../src/notify/hub";
import { createInAppChannel } from "../src/notify/channels/inApp";
import { createNotificationService } from "../src/notify/service";
import type { NotificationService } from "../src/notify/service";
import { assertKnownPrefs } from "../src/prefs/known";

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

    it("deletes a dismissed notification rather than keeping it (#90 9c)", () => {
        // Dismissal used to be a terminal state the row sat in, hidden from the
        // list. It is a delete now: the user is finished with it, so there is
        // nothing to list, count or hide.
        store.createNotification(userId, {
            id: "a",
            kind: "k",
            priority: "low",
            title: "a",
            createdAt: "2026-10-15T10:00:00.000Z",
        });

        expect(store.deleteNotification(userId, "a")).toMatchObject({
            id: "a",
        });
        expect(store.listNotifications(userId)).toEqual([]);
        expect(store.getNotification(userId, "a")).toBeNull();
        expect(store.countUnreadNotifications(userId)).toBe(0);
        // A row that is already gone is what a repeat dismissal asked for.
        expect(store.deleteNotification(userId, "a")).toBeNull();
        // And a foreign id is indistinguishable from a missing one.
        expect(store.deleteNotification(userId + 1, "a")).toBeNull();
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
        const again = store.setNotificationState(userId, "a", "snoozed");
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

    it("prunes settled notifications first, keeping an undelivered one when it can", () => {
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
        // Newest, and never delivered: the one row the ceiling must not take
        // while it has a settled alternative.
        store.createNotification(userId, {
            id: "pending",
            kind: "k",
            priority: "high",
            title: "still waiting",
            createdAt: "2026-10-15T09:00:00.000Z",
        });
        const deleted = store.pruneNotifications(userId, 2);
        expect(deleted).toBe(4);
        const remaining = store.listNotifications(userId).map((n) => n.id);
        expect(remaining).toEqual(["pending", "read-4"]);
    });

    it("still bounds the table when the pending rows are the ones piling up", () => {
        for (let i = 0; i < 4; i += 1) {
            store.createNotification(userId, {
                id: `p${i}`,
                kind: "k",
                priority: "low",
                title: `p${i}`,
                createdAt: `2026-10-15T0${i}:00:00.000Z`,
            });
        }
        expect(store.pruneNotifications(userId, 2)).toBe(2);
        expect(store.listNotifications(userId).map((n) => n.id)).toEqual([
            "p3",
            "p2",
        ]);
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
                class: "notification",
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

    it("holds every class inside quiet hours except a timer", async () => {
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
            title: "not now",
        });
        expect(quiet.suppressed).toBe("quiet-hours");
        expect(socket.frames).toEqual([]);

        // And so does a *prioritised* one. Since #90 the class owns quiet
        // hours, so an escalated priority is emphasis rather than a way
        // through — which is what closes the hole a model used to have on the
        // `sendNotification` path.
        const prioritised = await service.notify(userId, {
            kind: "k",
            priority: "urgent",
            title: "still not now",
        });
        expect(prioritised.suppressed).toBe("quiet-hours");
        expect(socket.frames).toEqual([]);

        // A timer pierces: it is the class the user chose for a moment they
        // chose, and a timer that waits for morning is not a timer.
        const timer = await service.notify(userId, {
            kind: "timer.fired",
            class: "timer",
            title: "the kettle",
        });
        expect(timer.suppressed).toBeNull();
        expect(socket.frames).toHaveLength(1);
        expect(socket.frames[0]).toMatchObject({
            notification: { class: "timer" },
        });
    });

    it("honours the master switch even for a timer", async () => {
        const at = new Date(2026, 9, 15, 23, 30);
        const { store, hub, service, socket } = makeService({ at });
        const userId = makeUser(store);
        hub.add(userId, socket);
        store.setPrefs(userId, [
            { key: "notify.enabled", value: false },
            {
                key: "notify.quietHours",
                value: { start: "22:00", end: "07:00" },
            },
        ]);

        // `notify.enabled: false` is a switch the user threw, not a quiet
        // hour: a class named by a producer must not be a way around it. The
        // flow that schedules a timer warns at that moment instead, which is
        // why the silence is announced when the user asked for it rather than
        // discovered when the kettle was supposed to boil.
        const outcome = await service.notify(userId, {
            kind: "timer.fired",
            class: "timer",
            title: "the kettle",
        });
        expect(outcome.suppressed).toBe("disabled");
        expect(socket.frames).toEqual([]);
    });

    it("treats a quiet-hours window as half-open across midnight", async () => {
        const prefs = [
            {
                key: "notify.quietHours",
                value: { start: "22:00", end: "07:00" },
            },
        ];
        // Local-time instants: quiet hours are evaluated against the server's
        // clock, so the boundaries have to be built the same way.
        const cases: Array<[Date, boolean]> = [
            [new Date(2026, 9, 15, 21, 59), false],
            [new Date(2026, 9, 15, 22, 0), true],
            [new Date(2026, 9, 16, 3, 0), true],
            [new Date(2026, 9, 16, 6, 59), true],
            [new Date(2026, 9, 16, 7, 0), false],
            [new Date(2026, 9, 16, 12, 0), false],
        ];
        for (const [at, quiet] of cases) {
            const { store, hub, service, socket } = makeService({ at });
            const userId = makeUser(store);
            hub.add(userId, socket);
            store.setPrefs(userId, prefs);
            const outcome = await service.notify(userId, {
                kind: "k",
                priority: "normal",
                title: "when?",
            });
            expect([at.getHours(), outcome.suppressed]).toEqual([
                at.getHours(),
                quiet ? "quiet-hours" : null,
            ]);
        }
    });

    it("handles a non-wrapping quiet-hours window", async () => {
        const { store, hub, service, socket } = makeService({
            at: new Date(2026, 9, 15, 12, 30),
        });
        const userId = makeUser(store);
        hub.add(userId, socket);
        store.setPrefs(userId, [
            {
                key: "notify.quietHours",
                value: { start: "12:00", end: "13:00" },
            },
        ]);
        expect(
            (await service.notify(userId, { kind: "k", title: "lunch" }))
                .suppressed,
        ).toBe("quiet-hours");

        const outside = makeService({ at: new Date(2026, 9, 15, 13, 30) });
        const otherUser = makeUser(outside.store);
        outside.hub.add(otherUser, outside.socket);
        outside.store.setPrefs(otherUser, [
            {
                key: "notify.quietHours",
                value: { start: "12:00", end: "13:00" },
            },
        ]);
        expect(
            (
                await outside.service.notify(otherUser, {
                    kind: "k",
                    title: "after lunch",
                })
            ).suppressed,
        ).toBeNull();
        expect(outside.socket.frames).toHaveLength(1);
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

    it("honours a window the prefs write path accepted (#143 parity)", async () => {
        const at = new Date(2026, 9, 15, 23, 30);
        const { store, hub, service, socket } = makeService({ at });
        const userId = makeUser(store);
        hub.add(userId, socket);

        // Exactly what the settings panel sends: one key, the documented shape.
        // The write path validates it (a 400 here would make the panel's save a
        // silent no-op) and the delivery path then acts on it. The two halves
        // share one definition of the shape, and this is the assertion that
        // says so.
        const patch: Record<string, unknown> = {
            "notify.quietHours": { start: "22:00", end: "07:00" },
        };
        const entries = Object.entries(patch).map(([key, value]) => ({
            key,
            value,
        }));
        expect(() => assertKnownPrefs(entries)).not.toThrow();
        store.setPrefs(userId, entries);

        const outcome = await service.notify(userId, {
            kind: "k",
            priority: "normal",
            title: "held for the morning",
        });
        expect(outcome.suppressed).toBe("quiet-hours");
        expect(socket.frames).toEqual([]);
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

    it("settles a notification read, dismissed, or answered (#90 9c)", async () => {
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
        // Dismissal deletes: the row handed back is the one that was there, and
        // the store no longer has it.
        const later = await service.notify(userId, { kind: "k", title: "ho" });
        expect(service.dismiss(userId, later.notification.id)).toMatchObject({
            ok: true,
            notification: { id: later.notification.id },
        });
        expect(store.getNotification(userId, later.notification.id)).toBeNull();
        expect(service.dismiss(userId, later.notification.id)).toEqual({
            ok: false,
            reason: "missing",
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
        // Deleted rather than dismissed (#90 9c): one live row per key is the
        // point — a minutely series must not stack a thousand tombstones.
        expect(list.map((n) => n.id)).toEqual([second.notification.id]);
        expect(store.getNotification(userId, first.notification.id)).toBeNull();
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

    it("honours limit from the query string, on a list dismissal removes from", async () => {
        // The contract validator coerces `req.query` in place, so these
        // assertions only hold if the handler reads the *coerced* types — the
        // bug this test exists for silently ignored both knobs.
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
        store.deleteNotification(userId, "b");

        const all = await request(buildApp())
            .get("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(all.body.notifications.map((n: { id: string }) => n.id)).toEqual(
            ["c", "a"],
        );

        const limited = await request(buildApp())
            .get("/api/notifications?limit=1")
            .set("authorization", `Bearer ${token}`)
            .expect(200);
        expect(
            limited.body.notifications.map((n: { id: string }) => n.id),
        ).toEqual(["c"]);
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

        await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "k", title: "hi", class: "alarm" })
            .expect(400);
    });

    it("runs a timer through quiet hours and holds a notification", async () => {
        hub.add(userId, socket);
        // The route harness runs on a fixed clock (see `makeService`), so the
        // window is built around *that* instant in local time — which is what
        // quiet hours are evaluated against. Two hours wide, so the instant is
        // comfortably inside it.
        const serviceNow = new Date("2026-10-15T18:00:00.000Z");
        const asClock = (offsetMinutes: number): string => {
            const at = new Date(serviceNow.getTime() + offsetMinutes * 60_000);
            const pad = (n: number) => String(n).padStart(2, "0");
            return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
        };
        store.setPrefs(userId, [
            {
                key: "notify.quietHours",
                value: { start: asClock(-60), end: asClock(60) },
            },
        ]);

        const held = await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "job.finished", title: "held" })
            .expect(201);
        expect(held.body.suppressed).toBe("quiet-hours");
        expect(held.body.delivered).toBe(0);
        expect(socket.frames).toEqual([]);

        // The same request with the class the user picks for a moment they
        // chose reaches the live socket — the one difference #90 is about.
        const rung = await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "timer.fired", class: "timer", title: "the kettle" })
            .expect(201);
        expect(rung.body.suppressed).toBeNull();
        expect(rung.body.delivered).toBe(1);
        expect(socket.frames).toHaveLength(1);
    });

    it("takes a class and defaults it to the quiet one", async () => {
        const timer = await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "timer.fired", class: "timer", title: "the kettle" })
            .expect(201);
        expect(timer.body.notification.class).toBe("timer");

        const plain = await request(buildApp())
            .post("/api/notifications")
            .set("authorization", `Bearer ${token}`)
            .send({ kind: "k", title: "no opinion" })
            .expect(201);
        expect(plain.body.notification.class).toBe("notification");
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

describe("notification push, end to end (#139)", () => {
    it("delivers a REST-created notification to the user's live socket", async () => {
        const store = createInMemoryAppDatabase();
        const userId = makeUser(store);
        const material = generateDeviceToken();
        store.createDevice(userId, "web", material.tokenHash, material.prefix);
        const hub = createNotificationHub();
        const service = createNotificationService({
            store,
            hub,
            channels: [createInAppChannel(hub)],
            maxPerUser: 200,
            deliveriesPerWindow: 20,
        });
        const appConfig: AppConfig = {
            ...getAppConfig(),
            notify: { deliveriesPerMin: 20, maxPerUser: 200 },
        };
        const server = createApp(
            store,
            appConfig,
            undefined,
            undefined,
            service,
        );
        const listening = server.listen(0);
        attachChatServer(listening, store, {
            turnTimeoutMs: 30_000,
            notifications: hub,
        });
        const port = (listening.address() as AddressInfo).port;

        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const received: unknown[] = [];
        const gotFrame = new Promise<void>((resolve) => {
            socket.on("message", (data) => {
                const frame = JSON.parse((data as Buffer).toString());
                if ("notification" in frame) {
                    received.push(frame);
                    resolve();
                }
            });
        });
        await new Promise<void>((resolve) => socket.once("open", resolve));
        socket.send(
            JSON.stringify({ type: "hello", capabilities: ["notification"] }),
        );
        socket.send(JSON.stringify({ type: "auth", token: material.token }));
        // Wait for the authResult so the server has certainly processed auth.
        await new Promise<void>((resolve) => {
            socket.on("message", (data) => {
                if ("authResult" in JSON.parse((data as Buffer).toString())) {
                    resolve();
                }
            });
        });
        expect(hub.isPresent(userId)).toBe(true);

        const created = await request(listening)
            .post("/api/notifications")
            .set("authorization", `Bearer ${material.token}`)
            .send({ kind: "test", title: "Background alert", priority: "high" })
            .expect(201);

        expect(created.body.suppressed).toBeNull();
        expect(created.body.delivered).toBe(1);
        await gotFrame;
        expect(received).toHaveLength(1);
        socket.close();
        listening.close();
    });
});

describe("notification hub (#139)", () => {
    it("tracks a user's sockets and counts what a push reached", () => {
        const hub = createNotificationHub();
        const first = fakeSocket();
        const second = fakeSocket();
        hub.add(1, first);
        hub.add(1, second);
        expect(hub.isPresent(1)).toBe(true);
        expect(hub.presentUsers()).toBe(1);
        expect(hub.deliver(1, { chunk: "hi" })).toBe(2);
        expect(first.frames).toHaveLength(1);
        expect(second.frames).toHaveLength(1);
    });

    it("moves a socket when it is re-registered under another user", () => {
        const hub = createNotificationHub();
        const socket = fakeSocket();
        hub.add(1, socket);
        hub.add(2, socket);
        // One socket is addressable by exactly one user, or a push would leak
        // across accounts.
        expect(hub.isPresent(1)).toBe(false);
        expect(hub.isPresent(2)).toBe(true);
        expect(hub.deliver(1, { chunk: "no" })).toBe(0);
        expect(hub.deliver(2, { chunk: "yes" })).toBe(1);
    });

    it("forgets a socket idempotently and skips a closed one", () => {
        const hub = createNotificationHub();
        const socket = fakeSocket();
        hub.add(1, socket);
        hub.remove(socket);
        hub.remove(socket);
        expect(hub.isPresent(1)).toBe(false);
        expect(hub.presentUsers()).toBe(0);

        const gone = { ...fakeSocket(), readyState: 3 };
        hub.add(1, gone);
        expect(hub.deliver(1, { chunk: "into the void" })).toBe(0);
    });

    it("survives a socket whose write throws", () => {
        const hub = createNotificationHub();
        const healthy = fakeSocket();
        const broken = {
            readyState: 1,
            send() {
                throw new Error("write after close");
            },
        };
        hub.add(1, broken);
        hub.add(1, healthy);
        // One dead socket must not cost the others their copy.
        expect(hub.deliver(1, { chunk: "still delivered" })).toBe(1);
        expect(healthy.frames).toHaveLength(1);
    });
});
