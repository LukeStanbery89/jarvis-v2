/**
 * The app store: SQLite-backed ledger of users, devices, sessions, and prefs.
 *
 * This is the `AppStore` seam from the auth design: an {@link AppStore}
 * interface plus {@link SqliteAppStore}, its better-sqlite3 implementation,
 * so a future portal can swap storage or the package can grow a second
 * backend without churning the REST/WS layers. `openAppStore(path)` creates
 * the parent directory and runs schema migrations; tests construct
 * `SqliteAppStore` over `:memory:` directly.
 *
 * Device tokens are persisted only as SHA-256 hashes (see `crypto.ts`); raw
 * secrets never touch the database.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AuthError } from "./errors";
import type {
    AppDevice,
    AppSession,
    AppUser,
    ResolvedIdentity,
    Role,
    SessionKind,
} from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    secret_hash  TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT,
    UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id      TEXT NOT NULL UNIQUE,
    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
    created_at     TEXT NOT NULL,
    last_active_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prefs (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
`;

/**
 * Accounts, devices, sessions, and prefs ledger access.
 *
 * Methods throw {@link AuthError} where a domain rule is broken
 * (`USERNAME_TAKEN`) and return `null` where a row simply does not exist.
 */
export interface AppStore {
    createUser(username: string, passwordHash: string, role: Role): AppUser;
    getUserByUsername(username: string): AppUser | null;
    getPasswordHash(username: string): string | null;
    getUserById(id: number): AppUser | null;
    hasOwner(): boolean;
    createDevice(
        userId: number,
        name: string,
        secretHash: string,
        prefix: string,
    ): AppDevice;
    provisionDevice(
        userId: number,
        name: string,
        secretHash: string,
        prefix: string,
    ): AppDevice;
    getDeviceById(id: number): AppDevice | null;
    listDevicesByUser(userId: number): AppDevice[];
    listUsers(): AppUser[];
    revokeDevice(id: number): void;
    touchDevice(id: number): void;
    resolveToken(tokenHash: string): ResolvedIdentity | null;
    claimSession(
        threadId: string,
        opts: {
            userId: number | null;
            deviceId: number | null;
            kind: SessionKind;
        },
    ): { session: AppSession; created: boolean };
    getSessionByThread(threadId: string): AppSession | null;
    touchSession(threadId: string): void;
    deleteSession(threadId: string): void;
    listOwnedSessions(userId: number): AppSession[];
    close(): void;
}

function now(): string {
    return new Date().toISOString();
}

function mapUser(row: {
    id: number;
    username: string;
    role: Role;
    createdAt: string;
}): AppUser {
    return {
        id: row.id,
        username: row.username,
        role: row.role,
        createdAt: row.createdAt,
    };
}

function mapDevice(row: {
    id: number;
    userId: number;
    name: string;
    prefix: string;
    createdAt: string;
    lastSeenAt: string | null;
}): AppDevice {
    return {
        id: row.id,
        userId: row.userId,
        name: row.name,
        prefix: row.prefix,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
    };
}

function mapSession(row: {
    id: number;
    threadId: string;
    userId: number | null;
    deviceId: number | null;
    kind: SessionKind;
    createdAt: string;
    lastActiveAt: string;
}): AppSession {
    return {
        id: row.id,
        threadId: row.threadId,
        userId: row.userId,
        deviceId: row.deviceId,
        kind: row.kind,
        createdAt: row.createdAt,
        lastActiveAt: row.lastActiveAt,
    };
}

function migrate(db: Database.Database): void {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version < 1) {
        db.exec(SCHEMA);
        db.pragma("user_version = 1");
    }
    if (version < 2) {
        // v2: one device row per (user, name) so re-login re-issues rather
        // than growing the device list endlessly.
        db.exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_name ON devices (user_id, name)",
        );
        db.pragma("user_version = 2");
    }
}

export function openAppStore(dbPath: string): AppStore {
    mkdirSync(dirname(dbPath), { recursive: true });
    return new SqliteAppStore(new Database(dbPath));
}

export class SqliteAppStore implements AppStore {
    private readonly db: Database.Database;
    private readonly statements: {
        insertUser: Database.Statement;
        selectUserByUsername: Database.Statement;
        selectUserPasswordHash: Database.Statement;
        selectUserById: Database.Statement;
        selectOwnerCount: Database.Statement;
        insertDevice: Database.Statement;
        upsertDevice: Database.Statement;
        selectDeviceById: Database.Statement;
        selectDeviceByUserAndName: Database.Statement;
        selectDeviceByHash: Database.Statement;
        listDevicesByUser: Database.Statement;
        listUsers: Database.Statement;
        deleteDevice: Database.Statement;
        updateDeviceLastSeen: Database.Statement;
        insertSession: Database.Statement;
        selectSessionByThread: Database.Statement;
        updateSessionLastActive: Database.Statement;
        deleteSession: Database.Statement;
        listSessionsByUser: Database.Statement;
    };

    constructor(db: Database.Database) {
        this.db = db;
        db.pragma("foreign_keys = ON");
        migrate(db);
        this.statements = {
            insertUser: db.prepare(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
            ),
            selectUserByUsername: db.prepare(
                "SELECT id, username, role, created_at AS createdAt FROM users WHERE username = ?",
            ),
            selectUserPasswordHash: db.prepare(
                "SELECT password_hash AS passwordHash FROM users WHERE username = ?",
            ),
            selectUserById: db.prepare(
                "SELECT id, username, role, created_at AS createdAt FROM users WHERE id = ?",
            ),
            selectOwnerCount: db.prepare(
                "SELECT COUNT(*) AS n FROM users WHERE role = 'owner'",
            ),
            insertDevice: db.prepare(
                "INSERT INTO devices (user_id, name, secret_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)",
            ),
            upsertDevice: db.prepare(
                "INSERT INTO devices (user_id, name, secret_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET secret_hash = excluded.secret_hash, prefix = excluded.prefix, created_at = excluded.created_at, last_seen_at = NULL",
            ),
            selectDeviceById: db.prepare(
                "SELECT id, user_id AS userId, name, prefix, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE id = ?",
            ),
            selectDeviceByUserAndName: db.prepare(
                "SELECT id, user_id AS userId, name, prefix, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE user_id = ? AND name = ?",
            ),
            selectDeviceByHash: db.prepare(
                "SELECT d.id AS deviceId, d.user_id AS deviceUserId, d.name AS deviceName, d.prefix AS devicePrefix, d.created_at AS deviceCreatedAt, d.last_seen_at AS deviceLastSeenAt, u.id AS userId, u.username AS username, u.role AS role, u.created_at AS userCreatedAt FROM devices d JOIN users u ON u.id = d.user_id WHERE d.secret_hash = ?",
            ),
            listDevicesByUser: db.prepare(
                "SELECT id, user_id AS userId, name, prefix, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE user_id = ? ORDER BY created_at DESC",
            ),
            listUsers: db.prepare(
                "SELECT id, username, role, created_at AS createdAt FROM users ORDER BY id ASC",
            ),
            deleteDevice: db.prepare("DELETE FROM devices WHERE id = ?"),
            updateDeviceLastSeen: db.prepare(
                "UPDATE devices SET last_seen_at = ? WHERE id = ?",
            ),
            insertSession: db.prepare(
                "INSERT INTO sessions (thread_id, user_id, device_id, kind, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO NOTHING",
            ),
            selectSessionByThread: db.prepare(
                "SELECT id, thread_id AS threadId, user_id AS userId, device_id AS deviceId, kind, created_at AS createdAt, last_active_at AS lastActiveAt FROM sessions WHERE thread_id = ?",
            ),
            updateSessionLastActive: db.prepare(
                "UPDATE sessions SET last_active_at = ? WHERE thread_id = ?",
            ),
            deleteSession: db.prepare(
                "DELETE FROM sessions WHERE thread_id = ?",
            ),
            listSessionsByUser: db.prepare(
                "SELECT id, thread_id AS threadId, user_id AS userId, device_id AS deviceId, kind, created_at AS createdAt, last_active_at AS lastActiveAt FROM sessions WHERE user_id = ? ORDER BY last_active_at DESC",
            ),
        };
    }

    createUser(username: string, passwordHash: string, role: Role): AppUser {
        try {
            this.statements.insertUser.run(username, passwordHash, role, now());
        } catch (err: unknown) {
            if (
                typeof err === "object" &&
                err !== null &&
                (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
            ) {
                throw new AuthError(
                    "USERNAME_TAKEN",
                    `the username '${username}' is already taken`,
                );
            }
            throw err;
        }
        const row = this.statements.selectUserByUsername.get(username) as {
            id: number;
            username: string;
            role: Role;
            createdAt: string;
        };
        return mapUser(row);
    }

    getUserByUsername(username: string): AppUser | null {
        const row = this.statements.selectUserByUsername.get(username) as
            | {
                  id: number;
                  username: string;
                  role: Role;
                  createdAt: string;
              }
            | undefined;
        return row ? mapUser(row) : null;
    }

    /**
     * Returns a user's stored password hash (for verification).
     *
     * Deliberately not part of {@link AppUser}: the hash is a credential, so
     * API/WS layers request it only in the login flow.
     */
    getPasswordHash(username: string): string | null {
        const row = this.statements.selectUserPasswordHash.get(username) as
            { passwordHash: string } | undefined;
        return row?.passwordHash ?? null;
    }

    getUserById(id: number): AppUser | null {
        const row = this.statements.selectUserById.get(id) as
            | {
                  id: number;
                  username: string;
                  role: Role;
                  createdAt: string;
              }
            | undefined;
        return row ? mapUser(row) : null;
    }

    hasOwner(): boolean {
        const row = this.statements.selectOwnerCount.get() as { n: number };
        return row.n > 0;
    }

    createDevice(
        userId: number,
        name: string,
        secretHash: string,
        prefix: string,
    ): AppDevice {
        const result = this.statements.insertDevice.run(
            userId,
            name,
            secretHash,
            prefix,
            now(),
        );
        return this.getDeviceById(Number(result.lastInsertRowid))!;
    }

    getDeviceById(id: number): AppDevice | null {
        const row = this.statements.selectDeviceById.get(id) as
            | {
                  id: number;
                  userId: number;
                  name: string;
                  prefix: string;
                  createdAt: string;
                  lastSeenAt: string | null;
              }
            | undefined;
        return row ? mapDevice(row) : null;
    }

    /**
     * Re-issues a named device credential for a user.
     *
     * Crucially different from `createDevice`: the row is keyed by
     * `(user_id, name)`, so logging in again on the same device name rotates
     * the secret instead of accumulating orphan rows. The previous token is
     * immediately invalid.
     */
    provisionDevice(
        userId: number,
        name: string,
        secretHash: string,
        prefix: string,
    ): AppDevice {
        this.statements.upsertDevice.run(
            userId,
            name,
            secretHash,
            prefix,
            now(),
        );
        const rows = this.statements.selectDeviceByUserAndName.all(
            userId,
            name,
        ) as {
            id: number;
            userId: number;
            name: string;
            prefix: string;
            createdAt: string;
            lastSeenAt: string | null;
        }[];
        const row = rows[0];
        if (!row) {
            throw new AuthError(
                "NOT_FOUND",
                "device row vanished after provisioning",
            );
        }
        return mapDevice(row);
    }

    listDevicesByUser(userId: number): AppDevice[] {
        const rows = this.statements.listDevicesByUser.all(userId) as {
            id: number;
            userId: number;
            name: string;
            prefix: string;
            createdAt: string;
            lastSeenAt: string | null;
        }[];
        return rows.map(mapDevice);
    }

    listUsers(): AppUser[] {
        const rows = this.statements.listUsers.all() as {
            id: number;
            username: string;
            role: Role;
            createdAt: string;
        }[];
        return rows.map(mapUser);
    }

    revokeDevice(id: number): void {
        this.statements.deleteDevice.run(id);
    }

    touchDevice(id: number): void {
        this.statements.updateDeviceLastSeen.run(now(), id);
    }

    resolveToken(tokenHash: string): ResolvedIdentity | null {
        const row = this.statements.selectDeviceByHash.get(tokenHash) as
            | {
                  deviceId: number;
                  deviceUserId: number;
                  deviceName: string;
                  devicePrefix: string;
                  deviceCreatedAt: string;
                  deviceLastSeenAt: string | null;
                  userId: number;
                  username: string;
                  role: Role;
                  userCreatedAt: string;
              }
            | undefined;
        if (!row) {
            return null;
        }
        return {
            user: {
                id: row.userId,
                username: row.username,
                role: row.role,
                createdAt: row.userCreatedAt,
            },
            device: {
                id: row.deviceId,
                userId: row.deviceUserId,
                name: row.deviceName,
                prefix: row.devicePrefix,
                createdAt: row.deviceCreatedAt,
                lastSeenAt: row.deviceLastSeenAt,
            },
        };
    }

    claimSession(
        threadId: string,
        opts: {
            userId: number | null;
            deviceId: number | null;
            kind: SessionKind;
        },
    ): { session: AppSession; created: boolean } {
        const result = this.statements.insertSession.run(
            threadId,
            opts.userId,
            opts.deviceId,
            opts.kind,
            now(),
            now(),
        );
        const session = this.getSessionByThread(threadId)!;
        return { session, created: result.changes > 0 };
    }

    getSessionByThread(threadId: string): AppSession | null {
        const row = this.statements.selectSessionByThread.get(threadId) as
            | {
                  id: number;
                  threadId: string;
                  userId: number | null;
                  deviceId: number | null;
                  kind: SessionKind;
                  createdAt: string;
                  lastActiveAt: string;
              }
            | undefined;
        return row ? mapSession(row) : null;
    }

    touchSession(threadId: string): void {
        this.statements.updateSessionLastActive.run(now(), threadId);
    }

    deleteSession(threadId: string): void {
        this.statements.deleteSession.run(threadId);
    }

    listOwnedSessions(userId: number): AppSession[] {
        const rows = this.statements.listSessionsByUser.all(userId) as {
            id: number;
            threadId: string;
            userId: number | null;
            deviceId: number | null;
            kind: SessionKind;
            createdAt: string;
            lastActiveAt: string;
        }[];
        return rows.map(mapSession);
    }

    close(): void {
        this.db.close();
    }
}
