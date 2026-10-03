/**
 * Test-support helpers for consumers of `@lukestanbery/jarvis-auth`.
 *
 * Reachable only through the `@lukestanbery/jarvis-auth/testing` subpath
 * export, which keeps these helpers off the package's production entry point:
 * nothing that ships an app should reach for an in-memory database.
 */
import Database from "better-sqlite3";
import { SqliteAppDatabase, type AppDatabase } from "./store";

/**
 * Creates a migrated, in-memory app database for tests.
 *
 * Returns a fully-migrated store backed by SQLite's `:memory:`, so a suite
 * gets the real schema and the real {@link SqliteAppDatabase} implementation
 * without touching the filesystem. Each call yields an independent database,
 * so suites that need a clean ledger per test call this per test rather than
 * reusing one store.
 *
 * Deliberately skips {@link openAppDatabase}'s `0700`/`0600` filesystem
 * posture: it is meaningless for an in-memory database, and applying it would
 * pre-create files in the developer's real `~/.jarvis`. Suites that must
 * verify the on-disk posture belong in `packages/auth/test/store.test.ts`,
 * which asserts it against real temp files.
 *
 * The return type is the {@link AppDatabase} interface rather than
 * `SqliteAppDatabase`, so callers cannot reach past the seam into
 * implementation details.
 *
 * @returns A migrated {@link AppDatabase} backed by `:memory:`. Call
 * `close()` when the test finishes.
 */
export function createInMemoryAppDatabase(): AppDatabase {
    return new SqliteAppDatabase(new Database(":memory:"));
}
