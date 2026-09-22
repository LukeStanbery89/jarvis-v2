import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
    generateDeviceToken,
    SqliteAppDatabase,
    type AppDatabase,
    type AppDevice,
    type AppUser,
    type AuthContext,
} from "../src/auth";
import { createSessionManager } from "../src/sessionManager";
import type { SessionManager } from "../src/sessionManager";

let store: AppDatabase;
let sessions: SessionManager;

const GUEST: AuthContext = { kind: "guest" };

function makeUser(store: AppDatabase): AppUser {
    return store.createUser(`u-${Math.random()}`, "hash", "user");
}

function makeDevice(store: AppDatabase, userId: number): AppDevice {
    const material = generateDeviceToken();
    return store.provisionDevice(
        userId,
        "test",
        material.tokenHash,
        material.prefix,
    );
}

function authed(user: AppUser, device: AppDevice): AuthContext {
    return { kind: "authed", user, device };
}

beforeEach(() => {
    store = new SqliteAppDatabase(new Database(":memory:"));
    sessions = createSessionManager(store);
});

afterEach(() => {
    store.close();
});

describe("SessionManager.runTurn", () => {
    it("claims a guest session, streams, touches, and tracks it", async () => {
        const guestThreads = new Set<string>();
        const outcome = await sessions.runTurn({
            sessionId: "guest-1",
            actor: GUEST,
            guestThreads,
            stream: async (sessionId) => {
                expect(sessionId).toBe("guest-1");
            },
        });
        expect(outcome).toBe("completed");
        expect(guestThreads.has("guest-1")).toBe(true);
        expect(store.getSessionByThread("guest-1")?.userId).toBeNull();
        expect(
            store.getSessionByThread("guest-1")?.lastActiveAt,
        ).not.toBeNull();
    });

    it("does not treat an authenticated actor's session as a guest thread", async () => {
        const user = makeUser(store);
        const device = makeDevice(store, user.id);
        const guestThreads = new Set<string>();
        const outcome = await sessions.runTurn({
            sessionId: "owned-1",
            actor: authed(user, device),
            guestThreads,
            stream: async () => {},
        });
        expect(outcome).toBe("completed");
        expect(guestThreads.size).toBe(0);
        expect(store.getSessionByThread("owned-1")?.userId).toBe(user.id);
    });

    it("answers not-owned and never streams when another principal owns the session", async () => {
        const alice = makeUser(store);
        const aliceDevice = makeDevice(store, alice.id);
        const bob = makeUser(store);
        const bobDevice = makeDevice(store, bob.id);

        const guestThreads = new Set<string>();
        await sessions.runTurn({
            sessionId: "alice-thread",
            actor: authed(alice, aliceDevice),
            guestThreads,
            stream: async () => {},
        });

        let streamed = false;
        const outcome = await sessions.runTurn({
            sessionId: "alice-thread",
            actor: authed(bob, bobDevice),
            guestThreads,
            stream: async () => {
                streamed = true;
            },
        });
        expect(outcome).toBe("not-owned");
        expect(streamed).toBe(false);
    });

    it("answers busy while the same thread's lock is held", async () => {
        let releaseStream: () => void = () => {};
        const first: Promise<"completed" | "busy" | "not-owned"> =
            sessions.runTurn({
                sessionId: "contended",
                actor: GUEST,
                guestThreads: new Set<string>(),
                stream: () =>
                    new Promise<void>((resolve) => {
                        releaseStream = () => resolve();
                    }),
            });
        const second = await sessions.runTurn({
            sessionId: "contended",
            actor: GUEST,
            guestThreads: new Set<string>(),
            stream: async () => {},
        });
        expect(second).toBe("busy");
        releaseStream();
        await expect(first).resolves.toBe("completed");
    });

    it("releases the thread lock even when the stream throws", async () => {
        await expect(
            sessions.runTurn({
                sessionId: "boom",
                actor: GUEST,
                guestThreads: new Set<string>(),
                stream: async () => {
                    throw new Error("stream boom");
                },
            }),
        ).rejects.toThrow("stream boom");
        const retry = await sessions.runTurn({
            sessionId: "boom",
            actor: GUEST,
            guestThreads: new Set<string>(),
            stream: async () => {},
        });
        expect(retry).toBe("completed");
    });

    it("does not touch the session when ownership is refused", async () => {
        const alice = makeUser(store);
        const aliceDevice = makeDevice(store, alice.id);
        const bob = makeUser(store);
        const bobDevice = makeDevice(store, bob.id);

        await sessions.runTurn({
            sessionId: "alice-owned",
            actor: authed(alice, aliceDevice),
            guestThreads: new Set<string>(),
            stream: async () => {},
        });
        const before = store.getSessionByThread("alice-owned")!.lastActiveAt;

        const outcome = await sessions.runTurn({
            sessionId: "alice-owned",
            actor: authed(bob, bobDevice),
            guestThreads: new Set<string>(),
            stream: async () => {},
        });
        expect(outcome).toBe("not-owned");
        expect(store.getSessionByThread("alice-owned")!.lastActiveAt).toBe(
            before,
        );
    });
});

describe("SessionManager.cleanupGuests", () => {
    it("deletes only rows that are still guest-owned", async () => {
        const guestThreads = new Set<string>();
        await sessions.runTurn({
            sessionId: "guest-row",
            actor: GUEST,
            guestThreads,
            stream: async () => {},
        });

        const user = makeUser(store);
        const device = makeDevice(store, user.id);
        await sessions.runTurn({
            sessionId: "owned-row",
            actor: authed(user, device),
            guestThreads,
            stream: async () => {},
        });

        sessions.cleanupGuests(["guest-row", "owned-row", "never-claimed"]);
        expect(store.getSessionByThread("guest-row")).toBeNull();
        expect(store.getSessionByThread("owned-row")).not.toBeNull();
    });
});
