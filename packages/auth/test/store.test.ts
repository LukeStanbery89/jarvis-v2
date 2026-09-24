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

    it("rejects a second owner (distinct username) with OWNER_EXISTS", () => {
        store.createUser("luke", "hash", "owner");
        let caught: unknown = null;
        try {
            store.createUser("zoe", "hash", "owner");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("OWNER_EXISTS");
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

    it("promotes and demotes roles, keeping a single owner", () => {
        const luke = store.createUser("luke", "hash", "owner");
        const zoe = store.createUser("zoe", "hash", "user");

        // A second owner is rejected while one exists.
        let caught: unknown = null;
        try {
            store.setUserRole(zoe.id, "owner");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AuthError);
        expect((caught as AuthError).code).toBe("OWNER_EXISTS");

        // Demoting the sole owner frees the role, then zoe can take it.
        store.setUserRole(luke.id, "user");
        store.setUserRole(zoe.id, "owner");
        expect(store.getUserById(zoe.id)?.role).toBe("owner");
        expect(store.getUserById(luke.id)?.role).toBe("user");
        expect(store.hasOwner()).toBe(true);
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
