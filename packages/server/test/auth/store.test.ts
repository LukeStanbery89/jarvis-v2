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
} from "../../src/auth";

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

describe("openAppDatabase", () => {
    it("reopens an existing database without error (migration is idempotent)", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            const first = openAppDatabase(path);
            first.createUser("luke", "hash", "owner");
            first.close();

            const second = openAppDatabase(path);
            expect(second.getUserByUsername("luke")?.role).toBe("owner");
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
