import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
    createCookieSessionProvider,
    hashDeviceToken,
    SqliteAppDatabase,
    type AppDatabase,
    type CookieSessionProvider,
} from "../src";

let store: AppDatabase;
let provider: CookieSessionProvider;

/** Fixed clock so expiry checks are deterministic. */
let nowMs: number;

beforeEach(() => {
    store = new SqliteAppDatabase(new Database(":memory:"));
    nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    provider = createCookieSessionProvider(store, { now: () => nowMs });
});

afterEach(() => {
    store.close();
});

describe("CookieSessionProvider", () => {
    it("issues a session and verifies it back", () => {
        const user = store.createUser("luke", "hash", "owner");

        const session = provider.issue(user.id);
        expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Date.parse(session.expiresAt)).toBe(
            nowMs + 30 * 24 * 60 * 60_000,
        );

        const resolved = provider.verify(session.token);
        expect(resolved).toEqual({
            userId: user.id,
            csrfToken: session.csrfToken,
        });
    });

    it("persists only the token hash (hash-at-rest)", () => {
        const user = store.createUser("luke", "hash", "owner");
        const session = provider.issue(user.id);

        const row = store.getWebSessionByHash(hashDeviceToken(session.token));
        expect(row).not.toBeNull();
        expect(row!.secretHash).not.toBe(session.token);
    });

    it("issues distinct tokens per call", () => {
        const user = store.createUser("luke", "hash", "owner");
        const a = provider.issue(user.id);
        const b = provider.issue(user.id);
        expect(a.token).not.toBe(b.token);
        expect(a.csrfToken).not.toBe(b.csrfToken);
    });

    it("returns null for an unknown token", () => {
        expect(provider.verify("not-a-real-token")).toBeNull();
    });

    it("returns null for an expired session and garbage-collects its row", () => {
        const user = store.createUser("luke", "hash", "owner");
        const ttlMs = 60_000;
        const shortLived = createCookieSessionProvider(store, {
            ttlMs,
            now: () => nowMs,
        });
        const session = shortLived.issue(user.id);

        nowMs += 59_999;
        expect(shortLived.verify(session.token)).not.toBeNull();

        nowMs += 2;
        expect(shortLived.verify(session.token)).toBeNull();
        expect(
            store.getWebSessionByHash(hashDeviceToken(session.token)),
        ).toBeNull();
    });

    it("revoke invalidates the session immediately", () => {
        const user = store.createUser("luke", "hash", "owner");
        const session = provider.issue(user.id);
        expect(provider.verify(session.token)).not.toBeNull();

        provider.revoke(session.token);
        expect(provider.verify(session.token)).toBeNull();
    });

    it("deleteAllForUser signs out every session of that user", () => {
        const user = store.createUser("luke", "hash", "owner");
        const other = store.createUser("zoe", "hash", "user");
        const a = provider.issue(user.id);
        const b = provider.issue(user.id);
        const c = provider.issue(other.id);

        provider.deleteAllForUser(user.id);
        expect(provider.verify(a.token)).toBeNull();
        expect(provider.verify(b.token)).toBeNull();
        expect(provider.verify(c.token)).not.toBeNull();
    });
});
