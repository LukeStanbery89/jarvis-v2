/**
 * The app database: SQLite-backed ledger of users, devices, sessions, and prefs.
 *
 * This is the `AppDatabase` seam from the auth design: the {@link AppDatabase}
 * type — an intersection of the three ledger roles {@link UserLedger},
 * {@link DeviceLedger}, {@link SessionLedger} — plus {@link SqliteAppDatabase},
 * its better-sqlite3 implementation, so a future portal can swap storage or
 * the package can grow a second backend without churning the REST/WS layers.
 * `openAppDatabase(path)` creates the parent directory and runs schema
 * migrations; tests construct `SqliteAppDatabase` over `:memory:` directly.
 *
 * Device tokens are persisted only as SHA-256 hashes (see `crypto.ts`); raw
 * secrets never touch the database.
 */
import Database from "better-sqlite3";
import { ensurePrivateFile, ensurePrivateStorage } from "./fs";
import { AuthError } from "./errors";
import type {
    AppDevice,
    AppSession,
    AppUser,
    ResolvedIdentity,
    Role,
    SessionKind,
    WebSessionRow,
} from "./types";

const WEB_SESSIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS web_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    csrf_token  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
    disabled      INTEGER NOT NULL DEFAULT 0,
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
${WEB_SESSIONS_SCHEMA}
`;

/**
 * Account-rows ledger: users, their stored password hashes, and owner state.
 *
 * `getPasswordHash` exists for the credential-verifier seam only
 * (`authRoutes.ts` / `CredentialVerifier`) — no caller may read stored hashes
 * for any other purpose.
 *
 * Methods throw {@link AuthError} where a domain rule is broken
 * (`USERNAME_TAKEN`) and return `null` where a row simply does not exist.
 */
export interface UserLedger {
    createUser(username: string, passwordHash: string, role: Role): AppUser;
    getUserByUsername(username: string): AppUser | null;
    getPasswordHash(username: string): string | null;
    getUserById(id: number): AppUser | null;
    hasOwner(): boolean;
    /**
     * Re-role an account promoted/demoted by an owner. Creating a second owner
     * violates the partial single-owner index and throws `OWNER_EXISTS`.
     */
    setUserRole(id: number, role: Role): void;
    /** Flag an account disabled (revoked-by-disable) or re-enable it. */
    setUserDisabled(id: number, disabled: boolean): void;
    listUsers(): AppUser[];
}

/**
 * Device-rows ledger: device credentials and token resolution.
 *
 * Only the SHA-256 hash of a device token is ever stored or compared — the
 * raw secret exists solely on the wire.
 */
export interface DeviceLedger {
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
    revokeDevice(id: number): void;
    touchDevice(id: number): void;
    /**
     * Renames a device and returns the updated row. A name already used by
     * another of the same user's devices (`(user_id, name)` UNIQUE) throws
     * `BAD_REQUEST`; a missing id throws `NOT_FOUND`.
     */
    renameDevice(id: number, name: string): AppDevice;
    resolveTokenHash(tokenHash: string): ResolvedIdentity | null;
}

/**
 * Browser cookie-session ledger.
 *
 * Created by the server's `CookieSessionProvider` — one row per issued cookie,
 * keyed by the SHA-256 hash of the cookie's raw token (hash-at-rest, like
 * device credentials). The store serves lookups and deletion only; expiry and
 * token generation live in the provider (`cookie.ts`).
 */
export interface WebSessionLedger {
    createWebSession(
        userId: number,
        secretHash: string,
        csrfToken: string,
        expiresAt: string,
    ): void;
    getWebSessionByHash(secretHash: string): WebSessionRow | null;
    deleteWebSession(secretHash: string): void;
    /** Deletes every session for a user (disable / sign-out-everywhere). */
    deleteWebSessionsForUser(userId: number): void;
}

/**
 * Per-user integration-prefs ledger over the `prefs` table.
 *
 * Values are arbitrary JSON, validated by the REST layer (`zod`) before they
 * reach the store; the ledger only round-trips `value_json`. The home for the
 * per-user integration state the web portal (#24) manages.
 */
export interface PrefLedger {
    /** All keys + parsed JSON values for a user (empty object when none). */
    getPrefs(userId: number): Record<string, unknown>;
    /** Upsert the given key/value pairs (existing keys keep their row, update value). */
    setPrefs(userId: number, records: { key: string; value: unknown }[]): void;
    /** Delete the given keys for a user (missing keys are silently ignored). */
    deletePrefKeys(userId: number, keys: string[]): void;
}

/**
 * Session-rows ledger: the WS chat sessions (one per `thread_id`).
 */
export interface SessionLedger {
    claimSession(
        threadId: string,
        opts: {
            userId: number | null;
            deviceId: number | null;
            kind: SessionKind;
        },
    ): { session: AppSession; created: boolean };
    getSessionByThread(threadId: string): AppSession | null;
    /** Bumps a thread's `last_active_at`; called at the end of every turn. */
    touchSession(threadId: string): void;
    /** Removes a session row (guest cleanup on socket close, or explicit REST delete). */
    deleteSession(threadId: string): void;
    /** Owned sessions for a user, newest-active first (powers `GET /api/sessions`). */
    listOwnedSessions(userId: number): AppSession[];
    /** Every session across all users, newest-active first (owner-wide admin view). */
    listAllSessions(): AppSession[];
}

/**
 * The complete app store: every ledger role plus lifecycle.
 *
 * Consumers narrow to the role they need (`createSessionManager` takes a
 * {@link SessionLedger}, `requireAuth` calls device + user methods…); this is
 * the full surface `createApp`/`attachChatServer` receive.
 */
export type AppDatabase = UserLedger &
    DeviceLedger &
    WebSessionLedger &
    PrefLedger &
    SessionLedger & {
        /** Releases the underlying connection. */
        close(): void;
    };

function now(): string {
    return new Date().toISOString();
}

function mapUser(row: {
    id: number;
    username: string;
    role: Role;
    disabled: number;
    createdAt: string;
}): AppUser {
    return {
        id: row.id,
        username: row.username,
        role: row.role,
        disabled: row.disabled === 1,
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
    if (version < 3) {
        // v3: at most one owner account (bootstrapping is one-time even under
        // concurrent requests), plus a lookup index for device-token
        // resolution (every authenticated REST request / WS handshake).
        db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner
                ON users (role) WHERE role = 'owner';
            CREATE INDEX IF NOT EXISTS idx_devices_secret_hash
                ON devices (secret_hash);
        `);
        db.pragma("user_version = 3");
    }
    if (version < 4) {
        // v4: the web-cookie session ledger plus the account `disabled` flag
        // used by the portal's user management. The column ALTER is guarded so
        // both fresh databases (which already have it via SCHEMA) and existing
        // v1-v3 stores (which don't) converge on the same v4 shape.
        const columns = db.pragma("table_info(users)") as { name: string }[];
        if (!columns.some((c) => c.name === "disabled")) {
            db.exec(
                "ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
            );
        }
        // The index below needs the ledger to exist. Fresh stores get the
        // table from SCHEMA, but a pre-v4 database does not — `CREATE INDEX
        // … ON web_sessions` would fail with "no such table" (IF NOT EXISTS
        // only guards the index, not the table), so create the table first.
        db.exec(`${WEB_SESSIONS_SCHEMA}
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions (user_id);`);
        db.pragma("user_version = 4");
    }
}

export function openAppDatabase(dbPath: string): AppDatabase {
    ensurePrivateStorage(dbPath);
    const store = new SqliteAppDatabase(new Database(dbPath));
    // Belt-and-suspenders chmod: the file was pre-created at 0600, but a
    // library migration that reopens it stays safe even on odd filesystems.
    ensurePrivateFile(dbPath);
    return store;
}

export class SqliteAppDatabase implements AppDatabase {
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
        listAllSessions: Database.Statement;
        updateUserRole: Database.Statement;
        updateUserDisabled: Database.Statement;
        updateDeviceName: Database.Statement;
        insertWebSession: Database.Statement;
        selectWebSessionByHash: Database.Statement;
        deleteWebSession: Database.Statement;
        deleteWebSessionsForUser: Database.Statement;
        upsertPref: Database.Statement;
        selectPrefs: Database.Statement;
        deletePrefKey: Database.Statement;
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
                "SELECT id, username, role, disabled, created_at AS createdAt FROM users WHERE username = ?",
            ),
            selectUserPasswordHash: db.prepare(
                "SELECT password_hash AS passwordHash FROM users WHERE username = ?",
            ),
            selectUserById: db.prepare(
                "SELECT id, username, role, disabled, created_at AS createdAt FROM users WHERE id = ?",
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
                "SELECT d.id AS deviceId, d.user_id AS deviceUserId, d.name AS deviceName, d.prefix AS devicePrefix, d.created_at AS deviceCreatedAt, d.last_seen_at AS deviceLastSeenAt, u.id AS userId, u.username AS username, u.role AS role, u.disabled AS userDisabled, u.created_at AS userCreatedAt FROM devices d JOIN users u ON u.id = d.user_id WHERE d.secret_hash = ? AND u.disabled = 0",
            ),
            listDevicesByUser: db.prepare(
                "SELECT id, user_id AS userId, name, prefix, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE user_id = ? ORDER BY created_at DESC",
            ),
            listUsers: db.prepare(
                "SELECT id, username, role, disabled, created_at AS createdAt FROM users ORDER BY id ASC",
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
            listAllSessions: db.prepare(
                "SELECT id, thread_id AS threadId, user_id AS userId, device_id AS deviceId, kind, created_at AS createdAt, last_active_at AS lastActiveAt FROM sessions ORDER BY last_active_at DESC",
            ),
            updateUserRole: db.prepare(
                "UPDATE users SET role = ? WHERE id = ?",
            ),
            updateUserDisabled: db.prepare(
                "UPDATE users SET disabled = ? WHERE id = ?",
            ),
            updateDeviceName: db.prepare(
                "UPDATE devices SET name = ? WHERE id = ?",
            ),
            insertWebSession: db.prepare(
                "INSERT INTO web_sessions (user_id, secret_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            ),
            selectWebSessionByHash: db.prepare(
                "SELECT id, user_id AS userId, secret_hash AS secretHash, csrf_token AS csrfToken, created_at AS createdAt, expires_at AS expiresAt FROM web_sessions WHERE secret_hash = ?",
            ),
            deleteWebSession: db.prepare(
                "DELETE FROM web_sessions WHERE secret_hash = ?",
            ),
            deleteWebSessionsForUser: db.prepare(
                "DELETE FROM web_sessions WHERE user_id = ?",
            ),
            upsertPref: db.prepare(
                "INSERT INTO prefs (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            ),
            selectPrefs: db.prepare(
                "SELECT key, value_json AS valueJson FROM prefs WHERE user_id = ?",
            ),
            deletePrefKey: db.prepare(
                "DELETE FROM prefs WHERE user_id = ? AND key = ?",
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
                // Classify structurally instead of sniffing the (engine- and
                // version-fragile) error message — a precedence policy, not an
                // inference about which constraint SQLite reported: when a row
                // for this username already exists, USERNAME_TAKEN is the more
                // specific, caller-actionable error even if the conflicting
                // insert was an owner and the owner index fired instead.
                // Only when no such row exists could the failure be the
                // partial single-owner index — the atomic backstop for a
                // concurrent double-bootstrap — so that means OWNER_EXISTS.
                if (this.getUserByUsername(username)) {
                    throw new AuthError(
                        "USERNAME_TAKEN",
                        `the username '${username}' is already taken`,
                    );
                }
                throw new AuthError(
                    "OWNER_EXISTS",
                    "an owner already exists; bootstrap is a one-time step",
                );
            }
            throw err;
        }
        const row = this.statements.selectUserByUsername.get(username) as {
            id: number;
            username: string;
            role: Role;
            disabled: number;
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
                  disabled: number;
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
                  disabled: number;
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
            disabled: number;
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

    renameDevice(id: number, name: string): AppDevice {
        try {
            const result = this.statements.updateDeviceName.run(name, id);
            if (result.changes === 0) {
                throw new AuthError("NOT_FOUND", "device not found");
            }
        } catch (err: unknown) {
            if (
                typeof err === "object" &&
                err !== null &&
                (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
            ) {
                throw new AuthError(
                    "BAD_REQUEST",
                    `a device named '${name}' already exists for this user`,
                );
            }
            throw err;
        }
        return this.getDeviceById(id)!;
    }

    setUserRole(id: number, role: Role): void {
        try {
            this.statements.updateUserRole.run(role, id);
        } catch (err: unknown) {
            if (
                typeof err === "object" &&
                err !== null &&
                (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
            ) {
                // The partial single-owner index rejected a second `owner` row.
                throw new AuthError(
                    "OWNER_EXISTS",
                    "an owner already exists; only one owner account is allowed",
                );
            }
            throw err;
        }
    }

    setUserDisabled(id: number, disabled: boolean): void {
        this.statements.updateUserDisabled.run(disabled ? 1 : 0, id);
    }

    createWebSession(
        userId: number,
        secretHash: string,
        csrfToken: string,
        expiresAt: string,
    ): void {
        this.statements.insertWebSession.run(
            userId,
            secretHash,
            csrfToken,
            now(),
            expiresAt,
        );
    }

    getWebSessionByHash(secretHash: string): WebSessionRow | null {
        const row = this.statements.selectWebSessionByHash.get(secretHash) as
            | {
                  id: number;
                  userId: number;
                  secretHash: string;
                  csrfToken: string;
                  createdAt: string;
                  expiresAt: string;
              }
            | undefined;
        return row ?? null;
    }

    deleteWebSession(secretHash: string): void {
        this.statements.deleteWebSession.run(secretHash);
    }

    deleteWebSessionsForUser(userId: number): void {
        this.statements.deleteWebSessionsForUser.run(userId);
    }

    getPrefs(userId: number): Record<string, unknown> {
        const rows = this.statements.selectPrefs.all(userId) as {
            key: string;
            valueJson: string;
        }[];
        const prefs: Record<string, unknown> = {};
        for (const row of rows) {
            try {
                prefs[row.key] = JSON.parse(row.valueJson);
            } catch {
                // A corrupt stored value survives as its raw string rather
                // than vanishing silently; the REST layer validates on write.
                prefs[row.key] = row.valueJson;
            }
        }
        return prefs;
    }

    setPrefs(userId: number, records: { key: string; value: unknown }[]): void {
        const tx = this.db.transaction(
            (entries: { key: string; value: unknown }[]) => {
                for (const { key, value } of entries) {
                    this.statements.upsertPref.run(
                        userId,
                        key,
                        JSON.stringify(value),
                        now(),
                    );
                }
            },
        );
        tx(records);
    }

    deletePrefKeys(userId: number, keys: string[]): void {
        const tx = this.db.transaction((entries: string[]) => {
            for (const key of entries) {
                this.statements.deletePrefKey.run(userId, key);
            }
        });
        tx(keys);
    }

    resolveTokenHash(tokenHash: string): ResolvedIdentity | null {
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
                  userDisabled: number;
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
                disabled: row.userDisabled === 1,
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

    listAllSessions(): AppSession[] {
        const rows = this.statements.listAllSessions.all() as {
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
