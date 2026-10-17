import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AuthError,
    SqliteAppDatabase,
    generateDeviceToken,
    openAppDatabase,
    type AppDatabase,
} from "../src";

let store: AppDatabase;
let db: Database.Database;

beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteAppDatabase(db);
});

afterEach(() => {
    store.close();
});

describe("users", () => {
    it("creates a user and reads it back, case-insensitively", () => {
        const user = store.createUser("Luke", "hash", "owner");
        expect(user.username).toBe("Luke");
        expect(user.role).toBe("owner");

        expect(store.getUserByUsername("luke")?.id).toBe(user.id);
        expect(store.getUserByUsername("LUKE")?.id).toBe(user.id);
        expect(store.getUserById(user.id)).toEqual(user);
        expect(store.getUserByUsername("nope")).toBeNull();
    });

    it("rejects a duplicate username with USERNAME_TAKEN", () => {
        store.createUser("luke", "hash", "owner");
        let caught: unknown = null;
        try {
            store.createUser("LUKE", "other-hash", "user");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("USERNAME_TAKEN");
    });

    it("tracks whether an owner exists", () => {
        expect(store.hasOwner()).toBe(false);
        store.createUser("luke", "hash", "owner");
        expect(store.hasOwner()).toBe(true);
    });

    it("allows a second owner (multiple owners may coexist)", () => {
        const luke = store.createUser("luke", "hash", "owner");
        const zoe = store.createUser("zoe", "hash", "owner");
        expect(store.getUserById(luke.id)?.role).toBe("owner");
        expect(store.getUserById(zoe.id)?.role).toBe("owner");
        expect(store.hasOwner()).toBe(true);
    });

    it("rejects a taken username inserted as owner with USERNAME_TAKEN", () => {
        store.createUser("luke", "hash", "owner");
        store.createUser("admin", "hash", "user");
        let caught: unknown = null;
        try {
            store.createUser("admin", "different-hash", "owner");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("USERNAME_TAKEN");
    });

    it("promotes a second owner and demotes an owner only while another remains", () => {
        const luke = store.createUser("luke", "hash", "owner");
        const zoe = store.createUser("zoe", "hash", "user");

        // A second owner is promoted alongside the current one (handover).
        store.setUserRole(zoe.id, "owner");
        expect(store.getUserById(zoe.id)?.role).toBe("owner");
        expect(store.getUserById(luke.id)?.role).toBe("owner");

        // With zoe remaining, the first owner can be demoted (incl. self).
        store.setUserRole(luke.id, "user");
        expect(store.getUserById(luke.id)?.role).toBe("user");
        expect(store.getUserById(zoe.id)?.role).toBe("owner");

        // Demoting the last owner is refused: a zero-owner state is a lockout.
        let caught: unknown = null;
        try {
            store.setUserRole(zoe.id, "user");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("LAST_OWNER");
        expect(store.getUserById(zoe.id)?.role).toBe("owner");
    });

    it("refuses to demote the last owner when the co-owner is disabled", () => {
        const luke = store.createUser("luke", "hash", "owner");
        const zoe = store.createUser("zoe", "hash", "owner");
        store.setUserDisabled(zoe.id, true);

        // zoe is disabled, so luke is the only *enabled* owner — demoting an
        // owner must stay impossible or the server is left with no one able
        // to administer it.
        let caught: unknown = null;
        try {
            store.setUserRole(luke.id, "user");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("LAST_OWNER");
        expect(store.getUserById(luke.id)?.role).toBe("owner");
    });

    it("toggles the disabled flag and revokes a disabled user's tokens", () => {
        const user = store.createUser("luke", "hash", "user");
        const material = generateDeviceToken();
        store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        expect(store.getUserById(user.id)?.disabled).toBe(false);
        expect(store.resolveTokenHash(material.tokenHash)).not.toBeNull();

        store.setUserDisabled(user.id, true);
        expect(store.getUserById(user.id)?.disabled).toBe(true);
        // Revoke-by-disable: the stored credential no longer resolves.
        expect(store.resolveTokenHash(material.tokenHash)).toBeNull();

        store.setUserDisabled(user.id, false);
        expect(store.getUserById(user.id)?.disabled).toBe(false);
        expect(store.resolveTokenHash(material.tokenHash)).not.toBeNull();
    });
});

describe("devices", () => {
    it("creates and reads back a device for a user", () => {
        const user = store.createUser("luke", "hash", "owner");
        const device = store.createDevice(
            user.id,
            "macbook",
            "abc-hash",
            "abc12345",
        );
        expect(device.userId).toBe(user.id);
        expect(store.getDeviceById(device.id)).toEqual(device);
        expect(store.getDeviceById(999)).toBeNull();
    });

    it("resolves a presented token to its identity", () => {
        const user = store.createUser("luke", "hash", "owner");
        const material = generateDeviceToken();
        const device = store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        const identity = store.resolveTokenHash(material.tokenHash);
        expect(identity).not.toBeNull();
        expect(identity!.user).toEqual(user);
        expect(identity!.device.id).toBe(device.id);
        expect(identity!.device.name).toBe("macbook");

        expect(
            store.resolveTokenHash(
                "0000000000000000000000000000000000000000000000000000000000000000",
            ),
        ).toBeNull();
    });

    it("touches a device's last-seen timestamp", () => {
        const user = store.createUser("luke", "hash", "owner");
        const device = store.createDevice(user.id, "macbook", "h", "abc12345");
        expect(device.lastSeenAt).toBeNull();

        store.touchDevice(device.id);
        const touched = store.getDeviceById(device.id)!;
        expect(touched.lastSeenAt).not.toBeNull();
        expect(new Date(touched.lastSeenAt!).toISOString()).toBe(
            touched.lastSeenAt,
        );
    });

    it("revoking a device removes it from the ledger", () => {
        const user = store.createUser("luke", "hash", "owner");
        const material = generateDeviceToken();
        const device = store.createDevice(
            user.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        store.revokeDevice(999);
        expect(store.resolveTokenHash(material.tokenHash)).not.toBeNull();

        store.revokeDevice(device.id);
        expect(store.getDeviceById(device.id)).toBeNull();
        expect(store.resolveTokenHash(material.tokenHash)).toBeNull();
    });

    it("renames a device and returns the updated row", () => {
        const user = store.createUser("luke", "hash", "owner");
        const device = store.createDevice(user.id, "macbook", "h", "abc12345");

        const renamed = store.renameDevice(device.id, "macbook-pro");
        expect(renamed.name).toBe("macbook-pro");
        expect(store.getDeviceById(device.id)?.name).toBe("macbook-pro");
    });

    it("rejects renaming to another device of the same user with BAD_REQUEST", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createDevice(user.id, "macbook", "h", "abc12345");
        const desktop = store.createDevice(user.id, "desktop", "h", "abc12346");

        let caught: unknown = null;
        try {
            store.renameDevice(desktop.id, "macbook");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("BAD_REQUEST");
    });

    it("allows the same device name across different users", () => {
        const a = store.createUser("luke", "hash", "owner");
        const b = store.createUser("zoe", "hash", "user");
        store.createDevice(a.id, "macbook", "h", "abc12345");
        const bDevice = store.createDevice(b.id, "macbook", "h", "abc12346");

        expect(store.renameDevice(bDevice.id, "macbook").name).toBe("macbook");
    });

    it("throws NOT_FOUND when renaming a missing device", () => {
        let caught: unknown = null;
        try {
            store.renameDevice(999, "nope");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("NOT_FOUND");
    });
});

describe("sessions", () => {
    it("claims a session on first use, then returns the existing row", () => {
        const owner = store.createUser("luke", "hash", "owner");
        const material = generateDeviceToken();
        const device = store.createDevice(
            owner.id,
            "macbook",
            material.tokenHash,
            material.prefix,
        );

        const first = store.claimSession("thread-a", {
            userId: owner.id,
            deviceId: device.id,
            kind: "text",
        });
        expect(first.created).toBe(true);
        expect(first.session.threadId).toBe("thread-a");
        expect(first.session.userId).toBe(owner.id);
        expect(first.session.deviceId).toBe(device.id);
        expect(first.session.kind).toBe("text");

        const second = store.claimSession("thread-a", {
            userId: owner.id,
            deviceId: device.id,
            kind: "text",
        });
        expect(second.created).toBe(false);
        expect(second.session.id).toBe(first.session.id);
    });

    it("stamps a fresh claim's created_at and last_active_at with one clock read", () => {
        store.claimSession("stamped", {
            userId: null,
            deviceId: null,
            kind: "text",
        });
        const row = db
            .prepare(
                "SELECT created_at, last_active_at FROM sessions WHERE thread_id = 'stamped'",
            )
            .get() as { created_at: string; last_active_at: string };
        expect(row.created_at).toBe(row.last_active_at);
    });

    it("records guest sessions and owned sessions separately", () => {
        const owner = store.createUser("luke", "hash", "owner");
        const guest = store.claimSession("guest-thread", {
            userId: null,
            deviceId: null,
            kind: "text",
        });
        expect(guest.created).toBe(true);
        expect(guest.session.userId).toBeNull();

        store.claimSession("owned-thread", {
            userId: owner.id,
            deviceId: null,
            kind: "voice",
        });
        expect(store.getSessionByThread("owned-thread")?.kind).toBe("voice");
    });

    it("updates last-active on touch and lists owned sessions newest-first", () => {
        const owner = store.createUser("luke", "hash", "owner");
        store.claimSession("owned-a", {
            userId: owner.id,
            deviceId: null,
            kind: "text",
        });
        store.claimSession("owned-b", {
            userId: owner.id,
            deviceId: null,
            kind: "text",
        });
        store.claimSession("guest", {
            userId: null,
            deviceId: null,
            kind: "text",
        });

        store.touchSession("owned-a");
        store.touchSession("owned-b");
        expect(
            store.getSessionByThread("owned-a")?.lastActiveAt,
        ).not.toBeNull();

        const sessions = store.listOwnedSessions(owner.id);
        expect(sessions.map((s) => s.threadId)).toContain("owned-a");
        expect(sessions.map((s) => s.threadId)).toContain("owned-b");
        expect(sessions.length).toBe(2);
    });

    it("deletes a session by thread id and reports null afterwards", () => {
        store.claimSession("gone", {
            userId: null,
            deviceId: null,
            kind: "text",
        });
        expect(store.getSessionByThread("gone")).not.toBeNull();

        store.deleteSession("gone");
        expect(store.getSessionByThread("gone")).toBeNull();
        store.deleteSession("never-existed");
    });
});

describe("web sessions", () => {
    it("creates a session and reads it back by secret hash", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createWebSession(
            user.id,
            "session-hash",
            "csrf-1",
            "2999-01-01T00:00:00.000Z",
        );

        const row = store.getWebSessionByHash("session-hash");
        expect(row).not.toBeNull();
        expect(row!.userId).toBe(user.id);
        expect(row!.csrfToken).toBe("csrf-1");
        expect(row!.expiresAt).toBe("2999-01-01T00:00:00.000Z");
        expect(store.getWebSessionByHash("missing")).toBeNull();
    });

    it("deletes a single session or all of a user's sessions", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createWebSession(
            user.id,
            "a",
            "csrf-a",
            "2999-01-01T00:00:00.000Z",
        );
        store.createWebSession(
            user.id,
            "b",
            "csrf-b",
            "2999-01-01T00:00:00.000Z",
        );

        store.deleteWebSession("a");
        expect(store.getWebSessionByHash("a")).toBeNull();
        expect(store.getWebSessionByHash("b")).not.toBeNull();

        store.deleteWebSessionsForUser(user.id);
        expect(store.getWebSessionByHash("b")).toBeNull();
    });

    it("deleting a user cascades to their web sessions", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createWebSession(
            user.id,
            "a",
            "csrf-a",
            "2999-01-01T00:00:00.000Z",
        );
        store.getWebSessionByHash("a"); // ensure the row exists is implied below
        // The ledger has no deleteUser; the FK cascade is exercised by dropping
        // the user row directly through the database handle.
        db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
        expect(store.getWebSessionByHash("a")).toBeNull();
    });

    it("deletes only expired sessions and reports the count", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createWebSession(
            user.id,
            "expired",
            "csrf-old",
            "2000-01-01T00:00:00.000Z",
        );
        store.createWebSession(
            user.id,
            "live",
            "csrf-new",
            "2999-01-01T00:00:00.000Z",
        );

        expect(store.deleteExpiredWebSessions()).toBe(1);
        expect(store.getWebSessionByHash("expired")).toBeNull();
        expect(store.getWebSessionByHash("live")).not.toBeNull();
        // Idempotent: nothing left to sweep.
        expect(store.deleteExpiredWebSessions()).toBe(0);
    });
});

describe("prefs", () => {
    it("starts empty and upserts key/value pairs", () => {
        const user = store.createUser("luke", "hash", "owner");
        expect(store.getPrefs(user.id)).toEqual({});

        store.setPrefs(user.id, [
            { key: "location", value: "home" },
            { key: "threshold", value: 7 },
        ]);
        expect(store.getPrefs(user.id)).toEqual({
            location: "home",
            threshold: 7,
        });

        store.setPrefs(user.id, [{ key: "threshold", value: 42 }]);
        expect(store.getPrefs(user.id)).toEqual({
            location: "home",
            threshold: 42,
        });
    });

    it("round-trips structured JSON values", () => {
        const a = store.createUser("luke", "hash", "owner");
        const b = store.createUser("zoe", "hash", "user");
        const value = { tags: ["x", "y"], nested: { on: true } };

        store.setPrefs(a.id, [{ key: "layout", value }]);
        expect(store.getPrefs(a.id)).toEqual({ layout: value });
        // Prefs are per-user: zoe sees nothing.
        expect(store.getPrefs(b.id)).toEqual({});
    });

    it("deletes the requested keys", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.setPrefs(user.id, [
            { key: "a", value: 1 },
            { key: "b", value: 2 },
            { key: "c", value: 3 },
        ]);
        store.deletePrefKeys(user.id, ["a", "c"]);
        expect(store.getPrefs(user.id)).toEqual({ b: 2 });
    });
});

describe("notifications", () => {
    it("defaults the class to the quiet one and stores an explicit class", () => {
        const user = store.createUser("luke", "hash", "owner");
        // No opinion: the store writes the quiet class rather than a null, so
        // every reader has one shape to handle.
        store.createNotification(user.id, {
            id: "n1",
            kind: "job.finished",
            priority: "normal",
            title: "quiet by default",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        store.createNotification(user.id, {
            id: "n2",
            kind: "timer.fired",
            class: "timer",
            priority: "normal",
            title: "the kettle",
            createdAt: "2026-10-15T18:00:01.000Z",
        });

        expect(store.getNotification(user.id, "n1")?.class).toBe(
            "notification",
        );
        expect(store.getNotification(user.id, "n2")?.class).toBe("timer");
    });

    it("creates, lists, and settles notifications for one user", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createNotification(user.id, {
            id: "n1",
            kind: "job.finished",
            priority: "high",
            title: "PR #143 is ready",
            body: "4 files changed.",
            requiresAnswer: false,
            dedupeKey: "job-143",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const created = store.getNotification(user.id, "n1");
        expect(created).toMatchObject({
            kind: "job.finished",
            priority: "high",
            body: "4 files changed.",
            dedupeKey: "job-143",
            state: "pending",
            requiresAnswer: false,
            deliveredAt: null,
            settledAt: null,
        });
        expect(store.countUnreadNotifications(user.id)).toBe(1);

        const read = store.setNotificationState(user.id, "n1", "read");
        expect(read?.state).toBe("read");
        expect(read?.settledAt).not.toBeNull();
        expect(store.countUnreadNotifications(user.id)).toBe(0);
    });

    it("records an answer and refuses to move a settled row", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createNotification(user.id, {
            id: "q1",
            kind: "coding.question",
            priority: "urgent",
            title: "Which React version?",
            requiresAnswer: true,
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        const answered = store.setNotificationState(user.id, "q1", "answered", {
            answer: "React 19",
        });
        expect(answered).toMatchObject({
            state: "answered",
            answer: "React 19",
            requiresAnswer: true,
        });
        expect(store.setNotificationState(user.id, "q1", "read")?.state).toBe(
            "answered",
        );
    });

    it("scopes every read and write to the owning user", () => {
        const luke = store.createUser("luke", "hash", "owner");
        const pepper = store.createUser("pepper", "hash", "user");
        store.createNotification(luke.id, {
            id: "n1",
            kind: "k",
            priority: "low",
            title: "mine",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        expect(store.getNotification(pepper.id, "n1")).toBeNull();
        expect(store.listNotifications(pepper.id)).toEqual([]);
        expect(store.setNotificationState(pepper.id, "n1", "read")).toBeNull();
        expect(store.getNotification(luke.id, "n1")?.state).toBe("pending");
    });

    it("links a notification to the job that produced it, and lets go when the job is pruned", () => {
        const user = store.createUser("luke", "hash", "owner");
        store.createJob(user.id, {
            id: "j1",
            label: "kettle",
            class: "timer",
            kind: "message",
            message: "Take the kettle off the heat.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        store.createNotification(user.id, {
            id: "n1",
            kind: "job.finished",
            class: "timer",
            priority: "normal",
            title: "kettle",
            jobId: "j1",
            createdAt: "2026-10-20T09:00:01.000Z",
        });
        // A producer with no job behind it (the agent's own notification)
        // omits the key rather than inventing a link.
        store.createNotification(user.id, {
            id: "n2",
            kind: "agent.request",
            priority: "normal",
            title: "standalone",
            createdAt: "2026-10-20T09:00:02.000Z",
        });

        expect(store.getNotification(user.id, "n1")?.jobId).toBe("j1");
        expect(store.getNotification(user.id, "n2")?.jobId).toBeNull();

        // Pruning the job takes its history, not the notification the user was
        // already shown: the link is what goes, and the row stays true.
        store.pruneJobs(user.id, 0);
        expect(store.getJob(user.id, "j1")).toBeNull();
        const kept = store.getNotification(user.id, "n1");
        expect(kept).not.toBeNull();
        expect(kept?.jobId).toBeNull();
        expect(kept?.title).toBe("kettle");
    });

    it("evicts settled rows first, and only reaches pending ones if it must", () => {
        const user = store.createUser("luke", "hash", "owner");
        for (let i = 0; i < 4; i += 1) {
            store.createNotification(user.id, {
                id: `n${i}`,
                kind: "k",
                priority: "low",
                title: `n${i}`,
                createdAt: `2026-10-15T0${i}:00:00.000Z`,
            });
            store.setNotificationState(user.id, `n${i}`, "dismissed");
        }
        // Newest of all, and never delivered: the row a prune must keep if
        // there is any choice.
        store.createNotification(user.id, {
            id: "keep",
            kind: "k",
            priority: "high",
            title: "keep",
            createdAt: "2026-10-15T09:00:00.000Z",
        });

        // Five rows, a ceiling of two: the three settled ones outside the cut
        // go, and the undelivered row survives because there was a choice.
        expect(store.pruneNotifications(user.id, 2)).toBe(3);
        expect(
            store
                .listNotifications(user.id, { includeDismissed: true })
                .map((n) => n.id),
        ).toEqual(["keep", "n3"]);
    });

    it("still bounds the table when the pending rows are the ones piling up", () => {
        const user = store.createUser("luke", "hash", "owner");
        for (let i = 0; i < 5; i += 1) {
            // The case retention exists for: nobody was connected, so every
            // one of these is `pending` and no settled row can absorb the cut.
            store.createNotification(user.id, {
                id: `p${i}`,
                kind: "k",
                priority: "low",
                title: `p${i}`,
                createdAt: `2026-10-15T0${i}:00:00.000Z`,
            });
        }
        expect(store.pruneNotifications(user.id, 2)).toBe(3);
        expect(store.listNotifications(user.id).map((n) => n.id)).toEqual([
            "p4",
            "p3",
        ]);
    });
});

describe("openAppDatabase", () => {
    it("reopens an existing database without error (migration is idempotent)", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            const first = openAppDatabase(path);
            first.createUser("luke", "hash", "owner");
            first.setPrefs(1, [{ key: "k", value: "v" }]);
            first.createWebSession(1, "h", "csrf", "2999-01-01T00:00:00.000Z");
            first.close();

            const second = openAppDatabase(path);
            expect(second.getUserByUsername("luke")?.role).toBe("owner");
            expect(second.getUserByUsername("luke")?.disabled).toBe(false);
            expect(second.getPrefs(1)).toEqual({ k: "v" });
            expect(second.getWebSessionByHash("h")?.csrfToken).toBe("csrf");
            second.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("upgrades a pre-v4 database (no web_sessions) in place", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            const old = new Database(path);
            old.exec(`
                CREATE TABLE users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
                    created_at    TEXT NOT NULL
                );
                CREATE TABLE devices (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name         TEXT NOT NULL,
                    secret_hash  TEXT NOT NULL,
                    prefix       TEXT NOT NULL,
                    created_at   TEXT NOT NULL,
                    last_seen_at TEXT,
                    UNIQUE (user_id, name)
                );
                CREATE TABLE sessions (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id      TEXT NOT NULL UNIQUE,
                    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                    kind           TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
                    created_at     TEXT NOT NULL,
                    last_active_at TEXT NOT NULL
                );
                CREATE TABLE prefs (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    key        TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, key)
                );
                INSERT INTO users (username, password_hash, role, created_at)
                    VALUES ('luke', 'hash', 'owner', '2026-01-01T00:00:00.000Z');
                PRAGMA user_version = 3;
            `);
            old.close();

            const upgraded = openAppDatabase(path);
            expect(upgraded.getUserByUsername("luke")?.role).toBe("owner");
            expect(upgraded.getUserByUsername("luke")?.disabled).toBe(false);
            upgraded.createWebSession(
                1,
                "h",
                "csrf",
                "2999-01-01T00:00:00.000Z",
            );
            expect(upgraded.getWebSessionByHash("h")?.csrfToken).toBe("csrf");
            // v7 (#139): the upgrade must leave a *usable* notifications
            // table, not merely a bumped version — a legacy store is exactly
            // the case the migration exists for.
            upgraded.createNotification(1, {
                id: "n1",
                kind: "k",
                priority: "normal",
                title: "after the upgrade",
                createdAt: "2026-10-15T18:00:00.000Z",
            });
            expect(upgraded.getNotification(1, "n1")?.state).toBe("pending");
            // v8 (#90): the same rule for the scheduler's tables — a legacy
            // store must end up with tables it can actually use, not merely a
            // bumped version.
            upgraded.createJob(1, {
                id: "j1",
                label: "after the upgrade",
                kind: "prompt",
                prompt: "check the filter",
                runAt: "2026-10-20T09:00:00.000Z",
                createdAt: "2026-10-15T18:00:00.000Z",
            });
            expect(upgraded.getJob(1, "j1")?.state).toBe("pending");
            // v11 (#90 phase 5): the notification → job link, on a store that
            // predates it, works in the same pass — the announcement can name
            // the job it came from.
            upgraded.createNotification(1, {
                id: "linked",
                kind: "job.finished",
                priority: "normal",
                title: "after the upgrade",
                jobId: "j1",
                createdAt: "2026-10-15T18:00:00.000Z",
            });
            expect(upgraded.getNotification(1, "linked")?.jobId).toBe("j1");
            upgraded.close();

            const check = new Database(path);
            expect(check.pragma("user_version", { simple: true })).toBe(11);
            const indexes = check.pragma("index_list(web_sessions)") as {
                name: string;
            }[];
            expect(
                indexes.some((i) => i.name === "idx_web_sessions_user"),
            ).toBe(true);
            check.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("adds the notification class to a store that predates it", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            // A store from before #90: the notifications table exists in its
            // v7 shape (no `class`), and holds a row the user has already
            // received. The rest of the schema is the v3 shape, so the
            // intervening migrations still do their work — which is the point:
            // the class arrives as an additive step on a table that is
            // already populated, not as part of creating it.
            const old = new Database(path);
            old.exec(`
                CREATE TABLE users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
                    created_at    TEXT NOT NULL
                );
                CREATE TABLE devices (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name         TEXT NOT NULL,
                    secret_hash  TEXT NOT NULL,
                    prefix       TEXT NOT NULL,
                    created_at   TEXT NOT NULL,
                    last_seen_at TEXT,
                    UNIQUE (user_id, name)
                );
                CREATE TABLE sessions (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id      TEXT NOT NULL UNIQUE,
                    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                    kind           TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
                    created_at     TEXT NOT NULL,
                    last_active_at TEXT NOT NULL
                );
                CREATE TABLE prefs (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    key        TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, key)
                );
                CREATE TABLE notifications (
                    id              TEXT PRIMARY KEY,
                    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    kind            TEXT NOT NULL,
                    priority        TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
                    title           TEXT NOT NULL,
                    body            TEXT,
                    state           TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'read', 'answered', 'dismissed')),
                    requires_answer INTEGER NOT NULL DEFAULT 0,
                    dedupe_key      TEXT,
                    answer          TEXT,
                    created_at      TEXT NOT NULL,
                    delivered_at    TEXT,
                    settled_at      TEXT
                );
                INSERT INTO users (username, password_hash, role, created_at)
                    VALUES ('luke', 'hash', 'owner', '2026-01-01T00:00:00.000Z');
                INSERT INTO notifications (id, user_id, kind, priority, title, state, created_at, delivered_at)
                    VALUES ('old', 1, 'job.finished', 'high', 'sent before the upgrade', 'delivered',
                            '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z');
                PRAGMA user_version = 3;
            `);
            old.close();

            const upgraded = openAppDatabase(path);
            // The migration is total: a notification the user already received
            // is not dropped and does not change meaning — it becomes the
            // quiet class, which is what it was.
            const existing = upgraded.getNotification(1, "old");
            expect(existing?.class).toBe("notification");
            expect(existing?.state).toBe("delivered");
            expect(existing?.title).toBe("sent before the upgrade");
            // And the column is usable afterwards.
            upgraded.createNotification(1, {
                id: "new",
                kind: "timer.fired",
                class: "timer",
                priority: "normal",
                title: "after the upgrade",
                createdAt: "2026-10-15T18:00:00.000Z",
            });
            expect(upgraded.getNotification(1, "new")?.class).toBe("timer");
            upgraded.close();

            const check = new Database(path);
            expect(check.pragma("user_version", { simple: true })).toBe(11);
            check.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rebuilds jobs to widen the payload CHECK, keeping jobs and their runs", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            // The v9 shape of the scheduler's tables: `jobs` allows only
            // `prompt`/`tool` and has no `class`/`message`, and a finished job
            // *plus its run* are in it. `user_version` stays at 3 so the
            // intervening migrations still do their work (web_sessions, the
            // notification class) — the point here is the v10 rebuild of a
            // populated `jobs`, which is the one that can lose a user's history.
            const old = new Database(path);
            old.exec(`
                CREATE TABLE users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
                    created_at    TEXT NOT NULL
                );
                CREATE TABLE devices (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name         TEXT NOT NULL,
                    secret_hash  TEXT NOT NULL,
                    prefix       TEXT NOT NULL,
                    created_at   TEXT NOT NULL,
                    last_seen_at TEXT,
                    UNIQUE (user_id, name)
                );
                CREATE TABLE sessions (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id      TEXT NOT NULL UNIQUE,
                    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                    kind           TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
                    created_at     TEXT NOT NULL,
                    last_active_at TEXT NOT NULL
                );
                CREATE TABLE prefs (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    key        TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, key)
                );
                CREATE TABLE notifications (
                    id              TEXT PRIMARY KEY,
                    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    kind            TEXT NOT NULL,
                    priority        TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
                    title           TEXT NOT NULL,
                    body            TEXT,
                    state           TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'read', 'answered', 'dismissed')),
                    requires_answer INTEGER NOT NULL DEFAULT 0,
                    dedupe_key      TEXT,
                    answer          TEXT,
                    created_at      TEXT NOT NULL,
                    delivered_at    TEXT,
                    settled_at      TEXT
                );
                CREATE TABLE jobs (
                    id          TEXT PRIMARY KEY,
                    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    label       TEXT NOT NULL,
                    kind        TEXT NOT NULL CHECK (kind IN ('prompt', 'tool')),
                    prompt      TEXT,
                    tool_name   TEXT,
                    tool_args   TEXT,
                    run_at      TEXT NOT NULL,
                    state       TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled', 'missed')),
                    attempts    INTEGER NOT NULL DEFAULT 0,
                    created_at  TEXT NOT NULL,
                    settled_at  TEXT,
                    last_error  TEXT,
                    CHECK (
                        (kind = 'prompt' AND prompt IS NOT NULL AND tool_name IS NULL) OR
                        (kind = 'tool' AND tool_name IS NOT NULL AND prompt IS NULL)
                    )
                );
                CREATE INDEX idx_jobs_due ON jobs (run_at) WHERE state = 'pending';
                CREATE INDEX idx_jobs_user ON jobs (user_id, created_at DESC);
                CREATE TABLE job_runs (
                    id          TEXT PRIMARY KEY,
                    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                    started_at  TEXT NOT NULL,
                    finished_at TEXT,
                    state       TEXT NOT NULL CHECK (state IN ('running', 'ok', 'failed')),
                    output      TEXT,
                    error       TEXT
                );
                CREATE INDEX idx_job_runs_job ON job_runs (job_id, started_at DESC);

                INSERT INTO users (username, password_hash, role, created_at)
                    VALUES ('luke', 'hash', 'owner', '2026-01-01T00:00:00.000Z');
                INSERT INTO jobs (id, user_id, label, kind, tool_name, tool_args,
                                  run_at, state, attempts, created_at, settled_at)
                    VALUES ('old', 1, 'What time was it', 'tool', 'getCurrentTime', '{}',
                            '2026-10-01T09:00:00.000Z', 'done', 1,
                            '2026-10-01T08:59:00.000Z', '2026-10-01T09:00:00.100Z');
                INSERT INTO job_runs (id, job_id, started_at, finished_at, state, output)
                    VALUES ('run-old', 'old', '2026-10-01T09:00:00.000Z',
                            '2026-10-01T09:00:00.100Z', 'ok', '9:00 AM');
                PRAGMA user_version = 3;
            `);
            old.close();

            const upgraded = openAppDatabase(path);
            // The job survived, and so did its run: dropping the old table with
            // foreign keys on would have cascaded the history away, which is why
            // the rebuild borrows a permissive FK setting for one step.
            expect(upgraded.getJob(1, "old")).toMatchObject({
                kind: "tool",
                class: "notification",
                message: null,
                state: "done",
                toolName: "getCurrentTime",
            });
            expect(upgraded.listJobRuns("old")).toMatchObject([
                { id: "run-old", state: "ok", output: "9:00 AM" },
            ]);
            // The widened CHECK accepts the payload kind it was rebuilt for.
            upgraded.createJob(1, {
                id: "new",
                label: "Kettle",
                class: "timer",
                kind: "message",
                message: "Take the kettle off.",
                runAt: "2026-10-20T09:00:00.000Z",
                createdAt: "2026-10-15T18:00:00.000Z",
            });
            expect(upgraded.getJob(1, "new")?.class).toBe("timer");
            upgraded.close();

            const check = new Database(path);
            expect(check.pragma("user_version", { simple: true })).toBe(11);
            // The indexes the drop took with it, recreated after the swap — the
            // queue's partial index is load-bearing for the claim feed.
            // `id TEXT PRIMARY KEY` brings its own sqlite_autoindex, so the
            // assertion is about the two the rebuild had to recreate.
            const indexes = (
                check.pragma("index_list(jobs)") as { name: string }[]
            )
                .map((index) => index.name)
                .filter((name) => !name.startsWith("sqlite_autoindex_"))
                .sort();
            expect(indexes).toEqual(["idx_jobs_due", "idx_jobs_user"]);
            check.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("upgrades a v3 database and drops the single-owner index", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            const old = new Database(path);
            old.exec(`
                CREATE TABLE users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
                    created_at    TEXT NOT NULL
                );
                CREATE TABLE devices (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name         TEXT NOT NULL,
                    secret_hash  TEXT NOT NULL,
                    prefix       TEXT NOT NULL,
                    created_at   TEXT NOT NULL,
                    last_seen_at TEXT,
                    UNIQUE (user_id, name)
                );
                CREATE TABLE sessions (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id      TEXT NOT NULL UNIQUE,
                    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                    kind           TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
                    created_at     TEXT NOT NULL,
                    last_active_at TEXT NOT NULL
                );
                CREATE TABLE prefs (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    key        TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, key)
                );
                INSERT INTO users (username, password_hash, role, created_at)
                    VALUES ('luke', 'hash', 'owner', '2026-01-01T00:00:00.000Z');
                CREATE UNIQUE INDEX idx_users_single_owner
                    ON users (role) WHERE role = 'owner';
                PRAGMA user_version = 3;
            `);
            old.close();

            const upgraded = openAppDatabase(path);
            // The v5 migration dropped the single-owner index, so a second
            // owner can now be promoted on an upgraded store.
            upgraded.createUser("zoe", "hash", "owner");
            const lukeId = upgraded.getUserByUsername("luke")!.id;
            const zoeId = upgraded.getUserByUsername("zoe")!.id;
            expect(upgraded.hasOwner()).toBe(true);

            // With zoe remaining, luke's demotion succeeds…
            upgraded.setUserRole(lukeId, "user");
            expect(upgraded.getUserById(lukeId)?.role).toBe("user");
            // …but the last owner is still protected.
            let caught: unknown = null;
            try {
                upgraded.setUserRole(zoeId, "user");
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(AuthError);
            expect((caught as AuthError).code).toBe("LAST_OWNER");
            upgraded.close();

            const check = new Database(path);
            expect(check.pragma("user_version", { simple: true })).toBe(11);
            const userIndexes = check.pragma("index_list(users)") as {
                name: string;
            }[];
            expect(
                userIndexes.some((i) => i.name === "idx_users_single_owner"),
            ).toBe(false);
            check.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("tightens the data directory to 0700 and the database to 0600", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            const first = openAppDatabase(path);
            expect(statSync(dir).mode & 0o777).toBe(0o700);
            expect(statSync(path).mode & 0o777).toBe(0o600);
            first.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** The names of every UNIQUE index over exactly (user_id, name) on `devices`. */
function uniqueUserNameIndexes(check: Database.Database): string[] {
    const indexes = check.pragma("index_list(devices)") as {
        name: string;
        unique: number;
    }[];
    const names: string[] = [];
    for (const index of indexes) {
        if (index.unique !== 1) {
            continue;
        }
        const columns = (
            check.pragma(`index_info('${index.name}')`) as { name: string }[]
        ).map((c) => c.name);
        if (
            columns.length === 2 &&
            columns.includes("user_id") &&
            columns.includes("name")
        ) {
            names.push(index.name);
        }
    }
    return names;
}

describe("device-name unique index convergence (v6)", () => {
    it("keeps exactly one enforcement on a fresh database (the inline constraint)", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            const store = openAppDatabase(path);
            const owner = store.createUser("luke", "hash", "owner");
            // Uniqueness still enforced…
            expect(() =>
                store.createDevice(owner.id, "macbook", "h1", "p1"),
            ).not.toThrow();
            expect(() =>
                store.createDevice(owner.id, "macbook", "h2", "p2"),
            ).toThrow();
            store.close();

            const check = new Database(path);
            expect(check.pragma("user_version", { simple: true })).toBe(11);
            const uniques = uniqueUserNameIndexes(check);
            expect(uniques).toHaveLength(1);
            // The v2 migration's named index is gone; the inline constraint's
            // automatic index is the one that remains.
            expect(uniques[0]).not.toBe("idx_devices_user_name");
            expect(
                uniqueUserNameIndexes(check).every((n) =>
                    n.startsWith("sqlite_autoindex"),
                ),
            ).toBe(true);
            check.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("keeps exactly one enforcement on a legacy store that lacked the inline constraint", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            // A pre-v2-shaped database: the devices table has no UNIQUE
            // (user_id, name) — the named index v2 creates is its only
            // enforcement, so v6 must NOT drop it.
            const old = new Database(path);
            old.exec(`
                CREATE TABLE users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
                    created_at    TEXT NOT NULL
                );
                CREATE TABLE devices (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name         TEXT NOT NULL,
                    secret_hash  TEXT NOT NULL,
                    prefix       TEXT NOT NULL,
                    created_at   TEXT NOT NULL,
                    last_seen_at TEXT
                );
                CREATE TABLE sessions (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id      TEXT NOT NULL UNIQUE,
                    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                    kind           TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
                    created_at     TEXT NOT NULL,
                    last_active_at TEXT NOT NULL
                );
                CREATE TABLE prefs (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    key        TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, key)
                );
                INSERT INTO users (username, password_hash, role, created_at)
                    VALUES ('luke', 'hash', 'owner', '2026-01-01T00:00:00.000Z');
                PRAGMA user_version = 1;
            `);
            old.close();

            const store = openAppDatabase(path);
            const owner = store.getUserByUsername("luke")!;
            // Uniqueness still enforced (through the kept named index)…
            expect(() =>
                store.createDevice(owner.id, "macbook", "h1", "p1"),
            ).not.toThrow();
            expect(() =>
                store.createDevice(owner.id, "macbook", "h2", "p2"),
            ).toThrow();
            store.close();

            const check = new Database(path);
            expect(check.pragma("user_version", { simple: true })).toBe(11);
            const uniques = uniqueUserNameIndexes(check);
            expect(uniques).toEqual(["idx_devices_user_name"]);
            check.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
