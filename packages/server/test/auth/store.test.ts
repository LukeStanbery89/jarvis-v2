import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AuthError,
    SqliteAppStore,
    generateDeviceToken,
    openAppStore,
    type AppStore,
} from "../../src/auth";

let store: AppStore;
let db: Database.Database;

beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteAppStore(db);
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

        const identity = store.resolveToken(material.tokenHash);
        expect(identity).not.toBeNull();
        expect(identity!.user).toEqual(user);
        expect(identity!.device.id).toBe(device.id);
        expect(identity!.device.name).toBe("macbook");

        expect(
            store.resolveToken(
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
        expect(store.resolveToken(material.tokenHash)).not.toBeNull();

        store.revokeDevice(device.id);
        expect(store.getDeviceById(device.id)).toBeNull();
        expect(store.resolveToken(material.tokenHash)).toBeNull();
    });
});

describe("openAppStore", () => {
    it("reopens an existing database without error (migration is idempotent)", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-store-"));
        const path = join(dir, "app.sqlite");
        try {
            const first = openAppStore(path);
            first.createUser("luke", "hash", "owner");
            first.close();

            const second = openAppStore(path);
            expect(second.getUserByUsername("luke")?.role).toBe("owner");
            second.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
