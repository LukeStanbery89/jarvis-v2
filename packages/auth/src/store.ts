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

/**
 * The notification states a row can never leave (#139, #90 phases 6c, 9c).
 *
 * `read` and `answered` are a user's terminal answers; `snoozed` joined them in
 * #90 phase 6c, when a reminder could be *deferred* rather than merely read or
 * ignored — the deferral settles the announcement it came from, so a late
 * duplicate acknowledgement cannot resurrect the row.
 *
 * `dismissed` used to be a fourth, and left in **9c**: dismissal now deletes the
 * row, because a dismissal means the user is finished with it and a row kept for
 * the record of a shrug is a row nobody reads. A state nothing can write is
 * better absent than documented, so the vocabulary narrowed here and the v16
 * migration deletes the rows that were already in it.
 *
 * Declared up here, above the schema strings, because they are *built* from it:
 * the table's CHECK names these states, and a `const` read from a template
 * literal evaluated earlier in the module would throw in its temporal dead zone
 * at import time. Everything that has to know is derived from this one list —
 * the CHECK, the settle statement's guard, its `settled_at` stamp, and the unread
 * count — so widening the set is one edit rather than four.
 */
export const NOTIFICATION_TERMINAL_STATES = [
    "read",
    "answered",
    "snoozed",
] as const;

/** One of the states a notification can never leave. */
export type NotificationTerminalState =
    (typeof NOTIFICATION_TERMINAL_STATES)[number];

/** The terminal states as SQL literals, for the statements built from them. */
const NOTIFICATION_TERMINAL_SQL = NOTIFICATION_TERMINAL_STATES.map(
    (state) => `'${state}'`,
).join(", ");

const WEB_SESSIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS web_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    csrf_token  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);`;

/**
 * The scheduler's tables (#90): one row per scheduled job, one per run.
 *
 * A constant rather than an inline string because it is needed twice — by
 * {@link SCHEMA} for a fresh database and by the v8 migration for an existing
 * one — and the two must agree on the shape (the same reason
 * {@link WEB_SESSIONS_SCHEMA} is one).
 *
 * `job_runs` is the job's *observable* history: what a run produced, when, and
 * why it failed. The model's own context does not live here — it lives in the
 * LangGraph checkpoint, under a `job:<id>` thread that never enters the
 * chat-thread ledger, which is what keeps a job's runs from appearing as
 * conversations.
 *
 * The `kind` CHECK is the table refusing to hold a job that could never run: a
 * prompt job without a prompt, or a tool job without a tool.
 */
/**
 * The `jobs` table's columns and constraints, parameterized by table name.
 *
 * A function rather than a literal because the v10 migration has to *rebuild*
 * this table — SQLite cannot alter a CHECK in place — and the copy lands in a
 * table that must have exactly this shape. Written once here, both the fresh
 * schema and the rebuild ask for it, so they cannot drift.
 *
 * `class` is the delivery class the job's announcement will carry (2b);
 * `message` is the payload a reminder or timer actually needs — text with
 * nothing to run, neither a model nor a tool.
 */
function jobsTable(name: string): string {
    return `CREATE TABLE IF NOT EXISTS ${name} (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    class       TEXT NOT NULL DEFAULT 'notification' CHECK (class IN ('notification', 'reminder', 'timer')),
    kind        TEXT NOT NULL CHECK (kind IN ('prompt', 'tool', 'message')),
    prompt      TEXT,
    tool_name   TEXT,
    tool_args   TEXT,
    message     TEXT,
    run_at      TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled', 'missed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    settled_at  TEXT,
    last_error  TEXT,
    repeat      TEXT,
    gate        TEXT,
    CHECK (
        (kind = 'prompt' AND prompt IS NOT NULL AND tool_name IS NULL AND message IS NULL) OR
        (kind = 'tool' AND tool_name IS NOT NULL AND prompt IS NULL AND message IS NULL) OR
        (kind = 'message' AND message IS NOT NULL AND prompt IS NULL AND tool_name IS NULL)
    )
)`;
}

/**
 * The `notifications` table (#139), parameterized by table name.
 *
 * A function for the same reason {@link jobsTable} is one: the v12 migration has
 * to *rebuild* this table — SQLite cannot widen a `CHECK` in place, and #90 phase
 * 6c added `snoozed` to the state set — and the copy has to land in a table with
 * exactly this shape. Written once, both ask for it, so they cannot drift.
 *
 * `job_id` sits last because that is where the v11 `ALTER TABLE` put it: a
 * rebuilt table lists its columns in this order on the way in, so a migrated
 * database and a fresh one converge on the same shape rather than merely the
 * same columns.
 */
function notificationsTable(
    name: string,
    options: { codingJobLink?: boolean } = {},
): string {
    return `CREATE TABLE IF NOT EXISTS ${name} (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    class           TEXT NOT NULL DEFAULT 'notification' CHECK (class IN ('notification', 'reminder', 'timer')),
    priority        TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    title           TEXT NOT NULL,
    body            TEXT,
    state           TEXT NOT NULL CHECK (state IN ('pending', 'delivered', ${NOTIFICATION_TERMINAL_SQL})),
    requires_answer INTEGER NOT NULL DEFAULT 0,
    dedupe_key      TEXT,
    answer          TEXT,
    created_at      TEXT NOT NULL,
    delivered_at    TEXT,
    settled_at      TEXT,
    job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL${
        options.codingJobLink === false
            ? ""
            : `,
    coding_job_id   TEXT REFERENCES coding_jobs(id) ON DELETE SET NULL`
    }
)`;
}

/**
 * The `notifications` index, kept separate from the table because the v12 rebuild
 * drops the table (taking its index with it) and must put it back — the same
 * reason {@link JOB_INDEXES} exists.
 */
const NOTIFICATION_INDEXES = `CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications (user_id, created_at DESC);`;

/**
 * The `jobs` indexes, kept separate from the table because the v10 rebuild
 * drops the table (taking its indexes with it) and must put them back after the
 * swap — a `CREATE INDEX IF NOT EXISTS` run before the drop would be undone by
 * it, and silently leave the queue unindexed.
 */
const JOB_INDEXES = `CREATE INDEX IF NOT EXISTS idx_jobs_due
    ON jobs (run_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_jobs_user
    ON jobs (user_id, created_at DESC);`;

/**
 * The day's model-run count (#90 phase 8c): one row per account per local day.
 *
 * A *budget* rather than a throttle, which is why it is a row here and not an
 * in-memory limiter like the server's: the question is "how much model work has
 * this account's schedule asked for today", and a restart must not hand the
 * day's allowance back — exactly when a runaway job would spend it again. The
 * server owns the limit and the meaning of a day; this table owns the count.
 *
 * Never pruned: one row per day is 365 rows a year.
 */
const JOB_MODEL_RUNS_TABLE = `CREATE TABLE IF NOT EXISTS job_model_runs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    runs    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
)`;

/**
 * The `job_runs` table (#90), parameterized by name.
 *
 * A function for the same reason {@link jobsTable} is one: the v15 migration has
 * to *rebuild* this table — SQLite cannot widen a `CHECK` in place, and `skipped`
 * widens the state set — and the copy has to land in a table with exactly this
 * shape. Written once, both ask for it.
 *
 * `gate_output` and `gate_key` are the gate's memory (#90 phase 8f): what the
 * check read, and *which* check read it. The key matters because a gate whose
 * tool or arguments changed is a different question, and comparing its answer to
 * a previous gate's would be comparing two things.
 */
function jobRunsTable(name: string): string {
    return `CREATE TABLE IF NOT EXISTS ${name} (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    state       TEXT NOT NULL CHECK (state IN ('running', 'ok', 'failed', 'skipped')),
    output      TEXT,
    error       TEXT,
    gate_output TEXT,
    gate_key    TEXT
)`;
}

const JOBS_SCHEMA = `${jobsTable("jobs")};
${JOB_INDEXES}
${jobRunsTable("job_runs")};
CREATE INDEX IF NOT EXISTS idx_job_runs_job
    ON job_runs (job_id, started_at DESC);
${JOB_MODEL_RUNS_TABLE};`;

/**
 * The coding-agent jobs (#141): one row per job, not a queue entry.
 *
 * Deliberately separate from `jobs` rather than another `kind` on it. A
 * scheduled job is a *moment* the scheduler fires and settles; a coding job is
 * a workspace, a container and a branch, with a lifecycle that outlives the
 * process watching it. Folding it into `jobs` would mean widening a CHECK to
 * add payload columns most jobs never use, and teaching the scheduler to skip
 * rows whose payload it does not own.
 *
 * `crash_policy` is the per-job answer to "the server died mid-run" — `prune`
 * (the default) or `resume` — chosen when the job is created (#141).
 * `container_id` is what makes `resume` possible at all: the boot reaper finds
 * the container by label, the row by id, and adopts one from the other.
 */
/**
 * The coding-job table (#141), as a function because the v19 migration has to
 * **rebuild** it: SQLite cannot widen a `CHECK` in place, and `awaiting-answer`
 * (#94) is a new state.
 *
 * @param name - The table name; a rebuild writes `coding_jobs_v19` first.
 * @returns The `CREATE TABLE` statement.
 */
function codingJobsTable(name: string): string {
    return `CREATE TABLE IF NOT EXISTS ${name} (
    id                   TEXT PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo                 TEXT NOT NULL,
    branch               TEXT NOT NULL,
    prompt               TEXT NOT NULL,
    state                TEXT NOT NULL CHECK (state IN ('queued', 'running', 'awaiting-answer', 'ok', 'failed', 'cancelled')),
    crash_policy         TEXT NOT NULL DEFAULT 'prune' CHECK (crash_policy IN ('prune', 'resume')),
    container_id         TEXT,
    workspace_path       TEXT NOT NULL,
    model                TEXT,
    log_tail             TEXT NOT NULL DEFAULT '',
    diff_summary         TEXT,
    pr_url               TEXT,
    issue_number         INTEGER,
    question_comment_id  INTEGER,
    plan                 TEXT,
    last_seen_comment_id INTEGER,
    attempts             INTEGER NOT NULL DEFAULT 0,
    last_error           TEXT,
    created_at           TEXT NOT NULL,
    started_at           TEXT,
    finished_at          TEXT,
    session_id           TEXT,
    questions_json       TEXT
)`;
}

/** The coding-job indexes; re-created after a v19 rebuild. */
const CODING_JOB_INDEXES = `CREATE INDEX IF NOT EXISTS idx_coding_jobs_user
    ON coding_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coding_jobs_running
    ON coding_jobs (state) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS idx_coding_jobs_awaiting
    ON coding_jobs (state) WHERE state = 'awaiting-answer';`;

const CODING_JOBS_SCHEMA = `${codingJobsTable("coding_jobs")};
${CODING_JOB_INDEXES}`;

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
${notificationsTable("notifications")};
${NOTIFICATION_INDEXES}
${JOBS_SCHEMA}
${CODING_JOBS_SCHEMA}
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
     * Re-role an account. Promoting creates a *new* owner alongside any
     * existing one (multiple owners may coexist); demoting an owner is refused
     * with `LAST_OWNER` when no other **enabled** owner would remain (that
     * invariant lives here since the v5 migration dropped the partial
     * single-owner index).
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
    /**
     * Deletes every expired session row (housekeeping — expired tokens
     * already fail verification, so this only reclaims the rows). Called by
     * the provider's `issue` so the table self-cleans without a timer.
     *
     * @returns The number of rows removed.
     */
    deleteExpiredWebSessions(): number;
}

/**
 * Per-user integration-prefs ledger over the `prefs` table.
 *
 * Values are arbitrary JSON, validated by the REST layer's `prefsFrom`
 * (`packages/server/src/http/authRoutes.ts`) before they reach the store;
 * the ledger only round-trips `value_json`. The home for the per-user
 * integration state the web portal (#24) manages.
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
 * The urgency levels a notification may carry, in ascending order.
 *
 * Structurally mirrors the protocol's `NOTIFICATION_PRIORITIES`
 * (`@lukestanbery/jarvis-protocol`) the same way {@link SessionKind} mirrors the
 * wire's chat modes: the server passes values straight through, so the two
 * packages stay independent of each other. Keep the tuples in step.
 */
export const NOTIFICATION_PRIORITIES = [
    "low",
    "normal",
    "high",
    "urgent",
] as const;

/** How much a notification is allowed to disturb the user. */
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/**
 * What kind of attention a notification asks for (#90), in rising order of how
 * much it may insist.
 *
 * Structurally mirrors the protocol's `NOTIFICATION_CLASSES` the same way
 * {@link NOTIFICATION_PRIORITIES} mirrors the wire's priorities — the server
 * passes values straight through, so the two packages stay independent. Keep
 * the tuples in step. The row's CHECK is what actually enforces the set.
 */
export const NOTIFICATION_CLASSES = [
    "notification",
    "reminder",
    "timer",
] as const;

/** What kind of attention a notification asks for. */
export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];

/**
 * Where a notification is in its life (#139, #90 phase 6c).
 *
 * `pending` — recorded but never pushed to a live client (nobody was
 * connected, the delivery cap was reached, or quiet hours suppressed it), so a
 * client that connects later finds it through the list. `delivered` — pushed
 * to at least one live socket. Then the terminal states, from the one list that
 * owns them ({@link NOTIFICATION_TERMINAL_STATES}): `read` is the user having
 * seen it, `answered` is the retirement path for a `requiresAnswer` notification
 * (a reply, not an acknowledgement, is what settles it), and `snoozed` is what a
 * reminder the user deferred becomes. **Dismissal is not a state**: it deletes
 * the row (#90 phase 9c) — see `deleteNotification`.
 *
 * Note that `pending` → `read` is a legal transition: a user who finds the
 * notification in the list and reads it there never needs it delivered.
 */
export const NOTIFICATION_STATES = [
    "pending",
    "delivered",
    ...NOTIFICATION_TERMINAL_STATES,
] as const;

/** A notification's lifecycle state. */
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

/**
 * One persisted notification (#139) as the store returns it.
 *
 * Times are ISO-8601 UTC strings, matching every other row in this database.
 */
export interface AppNotification {
    id: string;
    userId: number;
    /** Producer-defined category ("job.finished", "reminder", …). */
    kind: string;
    /**
     * What kind of attention this asks for (#90). Defaults to `notification`
     * at the table, so a producer that has no opinion (today: every producer
     * but the scheduler) stores the quiet class rather than a null.
     */
    class: NotificationClass;
    priority: NotificationPriority;
    title: string;
    body: string | null;
    state: NotificationState;
    /** Whether the user's reply (not an acknowledgement) retires it. */
    requiresAnswer: boolean;
    /**
     * Producer-supplied coalescing key: two notifications with the same
     * `(userId, dedupeKey)` while the first is unsettled replace each other
     * rather than stacking. `null` means "always deliver separately".
     */
    dedupeKey: string | null;
    /** The user's reply, for an answered notification. */
    answer: string | null;
    /**
     * The job whose run produced this notification (#90 phase 5), or `null`.
     *
     * An announcement about a job is the only notification anything can *act*
     * on beyond reading it — a reminder banner's snooze needs to name the
     * reminder it came from — so the link is stored rather than re-derived from
     * the title. `ON DELETE SET NULL`: jobs are pruned as history, while a
     * notification the user already received stays true.
     */
    jobId: string | null;
    /**
     * The coding job whose questions this notification carries (#94), or
     * `null`. An answer to the notification resumes that job; `ON DELETE SET
     * NULL` because the job is history once pruned, while the notification the
     * user received stays true.
     */
    codingJobId: string | null;
    createdAt: string;
    deliveredAt: string | null;
    /** When the notification reached a terminal state. */
    settledAt: string | null;
}

/** The producer-supplied half of a notification; identity and times are the store's. */
export interface CreateNotificationInput {
    kind: string;
    /**
     * What kind of attention it asks for; the table's default is
     * `notification` (quiet), so a caller that has no opinion omits it.
     */
    class?: NotificationClass;
    priority: NotificationPriority;
    title: string;
    body?: string | null;
    requiresAnswer?: boolean;
    dedupeKey?: string | null;
    /** The job this notification is about (#90 phase 5), when there is one. */
    jobId?: string | null;
    /**
     * The coding job an answer resumes (#94), when this notification asks the
     * user a question. `jobId` is the scheduler's table; this is the sandbox's.
     */
    codingJobId?: string | null;
}

/**
 * Notification-rows ledger: JARVIS's outbound messages to a user (#139).
 *
 * Every method scopes by `userId` — a notification is private to one account,
 * so there is no cross-user read to authorize: the REST layer passes the
 * authenticated id and a mismatched id simply does not resolve
 * ({@link getNotification} returns `null`), which is what makes "someone
 * else's notification id" indistinguishable from "no such id".
 *
 * The ledger stores and transitions; the *policy* (when to push, quiet hours,
 * delivery caps, coalescing) lives in the server's notification service.
 */
export interface NotificationLedger {
    /** Inserts a notification and returns the stored row. */
    createNotification(
        userId: number,
        input: CreateNotificationInput & { id: string; createdAt: string },
    ): AppNotification;
    /** One notification, or `null` when it is missing or another user's. */
    getNotification(userId: number, id: string): AppNotification | null;
    /**
     * Retires the unsettled question notifications linked to a coding job
     * (#94), as `read`.
     *
     * The job resuming is what makes the question moot, and it may have been
     * answered outside the REST route (a GitHub comment, the chat tool). The
     * route's own row is excluded so it can keep the answer text.
     *
     * @param userId - The job's owner.
     * @param codingJobId - The job that resumed.
     * @param exceptId - A notification id to leave untouched, or `null`.
     * @param at - The settlement instant.
     * @returns How many rows changed.
     */
    settleCodingQuestionNotifications(
        userId: number,
        codingJobId: string,
        exceptId: string | null,
        at: string,
    ): number;
    /**
     * A user's notifications, newest first. `limit` caps the page.
     *
     * There is no "include the dismissed ones" switch any more (#90 phase 9c):
     * dismissing deletes the row, so the list is simply what the user has.
     */
    listNotifications(
        userId: number,
        options?: { limit?: number },
    ): AppNotification[];
    /**
     * A user's notifications about one job, newest first (#90 phase 6c).
     *
     * A job announces once per run, so this is normally exactly one row — but
     * the caller settling "the announcement for this job" should ask the link
     * rather than assume an id it does not have, and there is no upper bound the
     * ledger can promise (a re-created reminder's predecessor announced too).
     * Unsettled and settled rows both come back; the settle rules are
     * {@link setNotificationState}'s.
     */
    listNotificationsForJob(userId: number, jobId: string): AppNotification[];
    /** How many of a user's notifications are unsettled (the badge count). */
    countUnreadNotifications(userId: number): number;
    /**
     * Moves a notification to `state`, stamping `delivered_at` / `settled_at`
     * as that state implies, optionally recording the user's `answer`.
     *
     * Terminal states are terminal — `read`, `answered` and `snoozed` — and a
     * transition out of one is refused, returning the existing row unchanged: a
     * late duplicate ack cannot resurrect a settled notification, and neither
     * can a snooze that arrives after the user read the reminder. Dismissal is
     * not a transition at all: it deletes the row
     * ({@link deleteNotification}, #90 phase 9c).
     *
     * @returns The row after the attempt, or `null` when no such notification
     * belongs to `userId`.
     */
    setNotificationState(
        userId: number,
        id: string,
        state: NotificationState,
        options?: { answer?: string },
    ): AppNotification | null;
    /**
     * Deletes a notification outright (#90 phase 9c) — what dismissing one
     * means, and the only caller it has.
     *
     * A dismissal is the user saying they are finished with the row, so there is
     * nothing left to list, count or report about it. The removed row comes back
     * rather than a boolean, so a route can answer with what it took away.
     *
     * @returns The row as it was, or `null` when no such notification belongs to
     * `userId` (the same indistinguishability {@link setNotificationState}
     * keeps).
     */
    deleteNotification(userId: number, id: string): AppNotification | null;
    /**
     * Trims a user's notifications to the newest `keep`, so a long-lived
     * instance cannot grow the table without bound.
     *
     * Settled rows are evicted first — they are the ones the user is finished
     * with — and only if that is not enough does the oldest survivor go,
     * whatever its state. The ceiling therefore holds for the *table*, which
     * is the point: `pending` rows are created precisely when nobody is
     * listening, so a rule that only trimmed settled rows would let an offline
     * client grow a user's table without bound.
     *
     * @returns The number of rows deleted.
     */
    pruneNotifications(userId: number, keep: number): number;
}

/**
 * What a job runs when it fires (#90).
 *
 * `prompt` runs an agent turn — anything needing judgement ("send me a weather
 * and news summary"). `tool` invokes one tool directly and never touches the
 * model, which is what makes a "turn the light on" a job rather than a
 * conversation. `message` has no payload to *run* at all: the job's own text is
 * the whole point, and the runner's announcement is what delivers it — which is
 * what a reminder or a timer actually is, needing neither a model nor a tool.
 */
export const JOB_KINDS = ["prompt", "tool", "message"] as const;

/** What a job runs. */
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Where a job is in its life.
 *
 * `pending` is the only state a job is *owed* in — it is the queue. `running`
 * is claimed and in flight; `done`, `failed`, `cancelled` and `missed` are
 * terminal. `missed` is distinct from `failed` on purpose: a job whose moment
 * passed while the server was down did not fail, it was never attempted, and
 * the two want different words in front of the user.
 */
export const JOB_STATES = [
    "pending",
    "running",
    "done",
    "failed",
    "cancelled",
    "missed",
] as const;

/** A job's lifecycle state. */
export type JobState = (typeof JOB_STATES)[number];

/** How one attempt at a job ended. */
/**
 * The states one attempt can end in (#90 phases 1, 8f).
 *
 * `skipped` is a firing that happened and declined — a gate's check said there
 * was nothing to do — which is why it is a *run* rather than silence: the
 * invariant this ledger serves is one run row per firing, so a firing that
 * reached its payload check leaves the same trace as one that went further.
 */
export const JOB_RUN_STATES = ["running", "ok", "failed", "skipped"] as const;

/** A run's state. */
export type JobRunState = (typeof JOB_RUN_STATES)[number];

/**
 * One scheduled job (#90) as the store returns it.
 *
 * `toolArgs` is the tool call's arguments, already parsed, or `null` for a
 * prompt job — the ledger round-trips `tool_args` the way `PrefLedger` does
 * `value_json`, so the server validates the arguments and the store only holds
 * them.
 */
export interface AppJob {
    id: string;
    userId: number;
    /** User-facing name ("AC filter"), used in the announcement. */
    label: string;
    /**
     * What kind of attention the job asks for (#90) — the delivery class its
     * announcement carries, which is what decides whether quiet hours may
     * hold it back. The same closed set as a notification's, because the
     * announcement *is* one.
     */
    class: NotificationClass;
    kind: JobKind;
    /** The instruction, for `kind: "prompt"`. */
    prompt: string | null;
    /** The tool to call, for `kind: "tool"`. */
    toolName: string | null;
    /** That tool's arguments (parsed JSON), or `null`. */
    toolArgs: unknown;
    /** The text to deliver, for `kind: "message"`. */
    message: string | null;
    /** When it wants to run, ISO-8601 UTC. */
    runAt: string;
    state: JobState;
    /** How many times it has been claimed (a claim is an attempt). */
    attempts: number;
    createdAt: string;
    /** When it reached a terminal state. */
    settledAt: string | null;
    /** Why the last attempt failed, for a `failed` job. */
    lastError: string | null;
    /**
     * The recurrence rule, as parsed JSON (#90 phase 8), or `null` for a
     * one-shot job.
     *
     * Deliberately `unknown` rather than `JobRepeat`: this package owns row
     * shapes and stays free of the protocol package, so the *rule's* type and
     * its validator live in `@lukestanbery/jarvis-protocol` and the server
     * names them. What the store guarantees is that the JSON parsed — and that
     * a value which would not is handed back as its raw text (see
     * {@link parseJsonColumn}), so the scheduler can say what it could not read
     * instead of silently treating the job as a one-shot.
     */
    repeat: unknown;
    /**
     * The deterministic check a firing must pass before its payload runs (#90
     * phase 8f), as parsed JSON, or `null` for a job that runs unconditionally.
     *
     * `unknown` for the same reason `repeat` is: the shape is the protocol's and
     * the server names it, while this package owns the row.
     */
    gate: unknown;
}

/** One attempt at one job, as the store returns it. */
export interface AppJobRun {
    id: string;
    jobId: string;
    startedAt: string;
    finishedAt: string | null;
    state: JobRunState;
    /** What the run produced (the reply, or the tool's result text). */
    output: string | null;
    /** Why the run failed, when it did. */
    error: string | null;
    /**
     * What the gate's check read, when the job has one (#90 phase 8f), or `null`.
     *
     * It is on the *run* rather than the job because it is what that firing saw:
     * the comparison reads the newest run's pair, and a payload run records it
     * too — a baseline that only skips recorded would reset on every firing that
     * did something.
     */
    gateOutput: string | null;
    /** Which check read it: the gate's tool and arguments, as one string. */
    gateKey: string | null;
}

/** The producer-supplied half of a job; identity and times are the store's. */
export interface CreateJobInput {
    label: string;
    /** What kind of attention it asks for; the table's default is the quiet class. */
    class?: NotificationClass;
    kind: JobKind;
    /** Required for `kind: "prompt"`; refused by the table's CHECK otherwise. */
    prompt?: string | null;
    /** Required for `kind: "tool"`. */
    toolName?: string | null;
    toolArgs?: unknown;
    /** Required for `kind: "message"`: the text the announcement delivers. */
    message?: string | null;
    /** The recurrence rule (#90 phase 8); omitted for a one-shot job. */
    repeat?: unknown;
    /** The gate a firing must pass (#90 phase 8f); omitted to run always. */
    gate?: unknown;
    runAt: string;
}

/**
 * One firing's ending, as {@link JobLedger.settleJobRun} records it (#90 phase
 * 8b).
 *
 * A union on the job's state, because the two cases need different things: a
 * re-arm needs the moment the next occurrence falls on, and a terminal settle
 * must not be given one.
 */
export interface SettleFiringInput {
    jobId: string;
    runId: string;
    /** What the attempt did, and what it produced or why it failed. */
    run: {
        state: Exclude<JobRunState, "running">;
        output?: string;
        error?: string;
        gateOutput?: string;
        gateKey?: string;
    };
    /**
     * What becomes of the job: `pending` when it repeats and has a next
     * occurrence (with the moment), or a terminal state when it does not.
     */
    job:
        | { state: "pending"; runAt: string; error?: string }
        | { state: Exclude<JobState, "pending" | "running">; error?: string };
    /** When the firing ended. */
    at: string;
}

/**
 * Job-rows ledger: the scheduler's queue and history (#90).
 *
 * Unlike {@link NotificationLedger} — whose every method scopes by `userId`,
 * because a notification is only ever read for its owner — this ledger has two
 * deliberate surfaces:
 *
 * - **User-scoped** ({@link getJob} / {@link listJobs} / {@link cancelJob} /
 *   {@link moveJob} /
 *   {@link listJobRuns}): what the REST layer and the pages use. A foreign id
 *   is indistinguishable from a missing one, as everywhere else.
 * - **Scheduler-scoped** ({@link listDueJobs} / {@link claimJob} /
 *   {@link rescheduleJob} / {@link settleJob} / {@link settleJobRun} /
 *   {@link startJobRun} / {@link finishJobRun}): the
 *   process acts *for every user*, so it selects due work across accounts and
 *   settles it by the id it claimed. Nothing here is reachable from a request
 *   handler; the scheduler is the only caller.
 *
 * The store owns rows and transitions; the *policy* (what may be scheduled,
 * what a run means, retention, deferral) lives in the server's scheduler.
 */
export interface JobLedger {
    /**
     * Inserts a job and returns the stored row.
     *
     * The caller has already validated the payload; the table's CHECK rejects a
     * mismatched `kind`/`prompt`/`tool_name` combination rather than storing a
     * job that could never run.
     */
    createJob(
        userId: number,
        input: CreateJobInput & { id: string; createdAt: string },
    ): AppJob;
    /** One job, or `null` when it is missing or another user's. */
    getJob(userId: number, id: string): AppJob | null;
    /**
     * A user's jobs, newest-created first. Settled jobs are hidden by default
     * (they are history); `limit` caps the page.
     */
    listJobs(
        userId: number,
        options?: { limit?: number; includeSettled?: boolean },
    ): AppJob[];
    /**
     * Every user's `pending` jobs whose `run_at` has arrived, oldest first —
     * the scheduler's claim feed. Cross-user by design (see the interface doc).
     */
    listDueJobs(at: string, limit: number): AppJob[];
    /**
     * Every job currently `running`, across users — the recovery feed.
     *
     * A job is `running` only while a claim holds it, and a claim lives in the
     * claiming process's memory, so at boot any `running` row was left behind
     * by a process that died mid-run. What to do about that is the scheduler's
     * policy (phase 1: fail it and say so), which is why the store only
     * reports them.
     */
    listRunningJobs(limit: number): AppJob[];
    /**
     * Closes every still-open run of a job, recording why. This is the trace of
     * an attempt that never finished — the process making it died — and a run
     * row left saying `running` forever would be a lie about a dead process.
     *
     * @returns The number of run rows closed.
     */
    failOpenJobRuns(jobId: string, error: string, at: string): number;
    /**
     * Claims one job for this process: `pending` → `running`, counting the
     * attempt. The transition is in the WHERE clause, so a second claim — from
     * another tick, or from a process that restarted mid-run — touches no row.
     *
     * @returns `true` when *this* caller won the job.
     */
    claimJob(id: string): boolean;
    /**
     * Records the start of one attempt.
     *
     * Called after {@link claimJob}, so a claimed job always has a run row: an
     * attempt that leaves no trace would be the "nothing happened" this whole
     * area exists to remove.
     */
    startJobRun(input: { id: string; jobId: string; startedAt: string }): void;
    /**
     * Finishes one attempt, recording what it produced, why it failed, or — for
     * a firing a gate declined — what the check read (#90 phase 8f).
     */
    finishJobRun(
        runId: string,
        state: Exclude<JobRunState, "running">,
        result: {
            output?: string;
            error?: string;
            gateOutput?: string;
            gateKey?: string;
        },
        at: string,
    ): void;
    /**
     * Moves a claimed job to a terminal state, stamping `settled_at`.
     *
     * Scheduler-scoped: it takes an id, not a user, because the caller holds a
     * claim on that id. Terminal states are terminal — a settle of an already
     * settled job returns the existing row unchanged — so a late duplicate
     * cannot rewrite history.
     */
    settleJob(
        id: string,
        state: Exclude<JobState, "pending" | "running">,
        options: { error?: string },
        at: string,
    ): AppJob | null;
    /**
     * Records a firing's ending: the attempt's row and the job's next state, in
     * one transaction (#90 phase 8b).
     *
     * The pair is one fact — an attempt finished, and the job is either owed
     * again or settled — so they commit together. A process that died between the
     * two writes would otherwise leave a job `running` with no open run to
     * explain it, or, once a job repeats, a series whose successor was never
     * scheduled. The announcement and the prune stay outside: a better-sqlite3
     * transaction is synchronous, and the announcement is a network round trip.
     *
     * Scheduler-scoped, like {@link settleJob}: the caller holds the claim. The
     * re-arm is guarded on the row still being `running`, so a job cancelled
     * mid-run is not brought back to life by the firing that was already in
     * flight.
     *
     * @returns The row after the write — unchanged when the job was cancelled
     * under the caller — or `null` when the id is gone.
     */
    settleJobRun(input: SettleFiringInput): AppJob | null;
    /**
     * Puts a *claimed* job back in the queue at a new moment, unchanged in every
     * other way (#90 phase 8c).
     *
     * The sibling of {@link rescheduleJob} for the one case that one cannot
     * cover: a repeating job whose slot passed while nobody was looking, where a
     * claim is already held. No run row, because nothing was attempted — the same
     * honesty a quiet-hours deferral keeps. Guarded on `running` like the re-arm
     * inside {@link settleJobRun}, so a job cancelled mid-run stays cancelled and
     * a stale caller cannot move a finished one.
     *
     * @returns The row after the attempt — unchanged when it was not `running`
     * — or `null` when the id is gone.
     */
    rearmJob(id: string, runAt: string, error?: string): AppJob | null;
    /**
     * How much model work this account's schedule has spent today (#90 phase
     * 8c), for the daily budget.
     *
     * `day` is the caller's local calendar day (`YYYY-MM-DD`): the budget is a
     * human's day, not UTC's.
     */
    countModelRuns(userId: number, day: string): number;
    /**
     * Charges one model-calling run to the day's budget. Called after the payload
     * actually ran — a gate skip or a deferred firing spends nothing.
     */
    recordModelRun(userId: number, day: string): void;
    /**
     * Moves a still-pending job's moment — how a reminder defers itself out of
     * quiet hours (#90 2b).
     *
     * Only a `pending` job can be moved, and that is the whole safety property:
     * a claimed job is being worked on, so its moment is history. The caller
     * re-reads the row either way, so a refused move shows up as an unchanged
     * `runAt` rather than as an exception.
     */
    rescheduleJob(id: string, runAt: string): AppJob | null;
    /**
     * Cancels one of the caller's own jobs (the only user-reachable state
     * change).
     *
     * A `pending` job, always. A **repeating** one also while it runs (#90 phase
     * 8b), because what the user is stopping is the series: the firing in flight
     * is already paid for and will report when it ends, and the re-arm refuses to
     * schedule a successor for a row that has stopped being `running`. A one-shot
     * mid-run is not cancellable — its result is the whole job, and it is on its
     * way.
     *
     * @returns The row after the attempt — unchanged when it was not
     * cancellable — or `null` when no such job belongs to `userId`.
     */
    cancelJob(userId: number, id: string): AppJob | null;
    /**
     * Moves one of the caller's own pending jobs to a new moment — what a
     * snooze does to a reminder that has not fired yet (#90 phase 3).
     *
     * The user-scoped sibling of {@link rescheduleJob}, and separate from it on
     * purpose: that one is the scheduler's (it acts on an id it has claimed),
     * while this one acts on the caller's own row and refuses anything that is
     * not `pending` (a running job is being worked on; a settled one is
     * history). The `user_id` predicate is the ownership check, in the same
     * statement as the state check, so there is no read-then-write window.
     *
     * @returns The row after the attempt — unchanged when it could not move —
     * or `null` when no such job belongs to `userId`.
     */
    moveJob(userId: number, id: string, runAt: string): AppJob | null;
    /**
     * Edits one of the caller's own pending jobs — the REST `PATCH` (#90 phase
     * 5). Only the label, the message payload's text and the moment are
     * editable: the class and the kind are what the job *is*, so changing
     * either is a different job (and a class change is how loudly the user gets
     * interrupted, which is not something to mutate in place).
     *
     * As with {@link moveJob}, the `user_id` predicate is the ownership check
     * and `state = 'pending'` the state check, in the same statement as the
     * write — so a foreign id, a claimed job and a settled one all change
     * nothing.
     *
     * `repeat` has **three** states rather than two, and they are the wire's
     * own: a rule to write, `null` to stop repeating, or `undefined` to leave the
     * stored rule alone. JSON cannot spell `undefined`, so a request body's
     * absent field and its explicit `null` already mean exactly these — no
     * sentinel is needed to tell them apart.
     *
     * @returns The row after the attempt — unchanged when it could not be
     * edited — or `null` when no such job belongs to `userId`.
     */
    editJob(
        userId: number,
        id: string,
        patch: { label?: string; message?: string; runAt?: string },
    ): AppJob | null;
    /**
     * A job's runs, newest first, for the pages and for tests.
     */
    listJobRuns(jobId: string, options?: { limit?: number }): AppJobRun[];
    /**
     * Trims a user's jobs to the newest `keep`, so a long-lived instance cannot
     * grow the table without bound.
     *
     * A **repeating** job that is still owed is exempt, and that exemption is the
     * reason this is one statement rather than the two the comment used to
     * describe: `created_at` is when the user asked and a series' never moves, so
     * age alone would eventually make a live series the next row the prune took.
     * Creation caps a user's pending rows below this ceiling, so what is taken is
     * overwhelmingly settled history.
     *
     * @returns The number of rows deleted.
     */
    pruneJobs(userId: number, keep: number): number;
    /**
     * Trims one job's runs to the newest `keep` (#90 phase 8b) — the other half
     * of retention.
     *
     * A job that fires every few minutes writes a run row each time, so the runs
     * table would grow without bound while the job count stayed small. The
     * default is comfortably above the detail endpoint's page, so a caller that
     * does not care still serves whole pages.
     *
     * @returns The number of rows deleted.
     */
    pruneJobRuns(jobId: string, keep?: number): number;
}

/** The coding-job lifecycle (#141). */
export const CODING_JOB_STATES = [
    "queued",
    "running",
    "awaiting-answer",
    "ok",
    "failed",
    "cancelled",
] as const;

/**
 * A coding job's state: queued, one attempt running, waiting for the user to
 * answer questions, or one of three endings.
 *
 * `awaiting-answer` is **non-terminal** (#94): the job keeps its workspace and
 * can be reopened with the answers; only the three endings are settled.
 */
export type CodingJobState = (typeof CODING_JOB_STATES)[number];

/**
 * What happens to a coding job whose server died mid-run (#141).
 *
 * A per-job decision, made when the job is created: `prune` reaps the container
 * and records a failure, `resume` adopts the still-running container. `prune`
 * is the default because it is always safe; `resume` is opt-in.
 */
export const CODING_JOB_CRASH_POLICIES = ["prune", "resume"] as const;

/** The per-job crash policy (see {@link CODING_JOB_CRASH_POLICIES}). */
export type CodingJobCrashPolicy = (typeof CODING_JOB_CRASH_POLICIES)[number];

/** One coding job, as the store returns it. */
export interface AppCodingJob {
    id: string;
    userId: number;
    /** `owner/name`; the server validates it against its allowlist. */
    repo: string;
    /** The branch the agent works on, created by the host before the run. */
    branch: string;
    /** The instruction handed to the agent. */
    prompt: string;
    state: CodingJobState;
    crashPolicy: CodingJobCrashPolicy;
    /**
     * The model id the agent was told to use, or `null` for a row written
     * before the column existed.
     *
     * Recorded per job rather than inferred from config at read time: the
     * config can change between runs, and "which model wrote this diff" is a
     * question about the run, not about the server's current settings.
     */
    model: string | null;
    /** The container this attempt runs in, once it has been claimed. */
    containerId: string | null;
    /** The host directory mounted into the container as its only writable path. */
    workspacePath: string;
    /** The bounded tail of the container's output, written when the job settles. */
    logTail: string;
    /** The diff summary collected after the run (`git diff --stat`). */
    diffSummary: string | null;
    /** The pull request the job opened, when a later step did. */
    prUrl: string | null;
    /** The issue this job implements, when it was started from one (#94). */
    issueNumber: number | null;
    /**
     * The comment that carries this job's questions (#94), when it is
     * `awaiting-answer`. The poller reads the thread after it.
     */
    questionCommentId: number | null;
    /** The agent's plan, posted with the questions or carried into the PR. */
    plan: string | null;
    /**
     * The chat session that started this job (#94), when a chat tool did.
     *
     * The in-session ask relay reads it: a parked job's questions are only
     * relevant to the conversation that asked for the work. A job started from
     * the API or a scheduler has no session, and its questions reach the user
     * through the notification instead.
     */
    sessionId: string | null;
    /**
     * The questions the agent is parked on (#94), or `null` when it is not
     * awaiting an answer. Stored at park time because the workspace may be
     * swept and the relay must not read a job's files on every turn.
     */
    questions: string[] | null;
    /**
     * The newest comment this job has accounted for (#94).
     *
     * For an awaiting job it is the question comment; for a PR follow-up it is
     * the newest human review comment the follow-up was started for. The
     * poller compares against it so one comment cannot start two jobs.
     */
    lastSeenCommentId: number | null;
    /** How many times it has been claimed; a claim is an attempt. */
    attempts: number;
    /** Why the last attempt failed, for a `failed` job. */
    lastError: string | null;
    createdAt: string;
    /** When the attempt was claimed (the container started). */
    startedAt: string | null;
    /** When the job reached a terminal state. */
    finishedAt: string | null;
}

/** The producer-supplied half of a coding job; identity and times are the store's. */
export interface CreateCodingJobInput {
    repo: string;
    branch: string;
    prompt: string;
    workspacePath: string;
    /** The model the run will use; recorded for later audit. */
    model?: string;
    /**
     * The pull request a follow-up job continues (#140).
     *
     * A job that opens its own leaves this unset and learns the URL when it
     * publishes; a follow-up starts *at* one, so the row carries it from the
     * first write and a resumed job still knows which PR it is updating.
     */
    prUrl?: string | null;
    /** The issue this job implements, when it was started from one (#94). */
    issueNumber?: number | null;
    /** The newest comment this job already accounts for, for the poller. */
    lastSeenCommentId?: number | null;
    /** Omitted means `prune` — the column's default, made explicit here. */
    crashPolicy?: CodingJobCrashPolicy;
    /**
     * The chat session that asked for the job (#94), when a chat tool did.
     * The in-session ask relay keys on it.
     */
    sessionId?: string | null;
}

/** What a settled coding job records beyond its state. */
export interface SettleCodingJobInput {
    /** `git diff --stat` collected from the workspace after the run. */
    diffSummary?: string | null;
    /** A pull request opened for the branch, when there is one. */
    prUrl?: string | null;
    /** The bounded output tail; omitted leaves the stored one in place. */
    logTail?: string;
    /** Why it failed, when it did. */
    error?: string | null;
}

/**
 * Coding-job rows (#141), in the same two-surface shape as {@link JobLedger}.
 *
 * - **User-scoped** ({@link getCodingJob} / {@link listCodingJobs} /
 *   {@link cancelCodingJob} / {@link pruneCodingJobs}): what a page or a tool
 *   reaching for the caller's own work uses. A foreign id is indistinguishable
 *   from a missing one.
 * - **Process-scoped** ({@link getCodingJobById} / {@link listRunningCodingJobs}
 *   / {@link claimCodingJob} / {@link settleCodingJob} /
 *   {@link setCodingJobLogTail}): the supervisor acts on an id it claimed, and
 *   the boot reaper acts on rows found by container label rather than by owner.
 *
 * The store owns rows and transitions; the server's sandbox service owns the
 * policy (which repos, what a run means, retention, what happens to an orphan).
 */
export interface CodingJobLedger {
    /**
     * Inserts a job in `queued` and returns the stored row.
     *
     * A coding job is created only after its workspace exists: the caller
     * prepares the clone first, so a row never promises a directory that is
     * not there.
     */
    createCodingJob(
        userId: number,
        input: CreateCodingJobInput & { id: string; createdAt: string },
    ): AppCodingJob;
    /** One job, or `null` when it is missing or another user's. */
    getCodingJob(userId: number, id: string): AppCodingJob | null;
    /**
     * One job by id alone — the reaper's read, because a container's label
     * carries the job id and no owner.
     */
    getCodingJobById(id: string): AppCodingJob | null;
    /**
     * A user's jobs, newest-created first. Settled jobs are hidden by default
     * (they are history); `limit` caps the page.
     */
    listCodingJobs(
        userId: number,
        options?: { limit?: number; includeSettled?: boolean },
    ): AppCodingJob[];
    /**
     * Every `running` job across users — the recovery feed.
     *
     * A claim lives in the claiming process's memory, so at boot every
     * `running` row belongs to a process that died. What to do about that is
     * the sandbox service's policy (prune or resume, per the row), which is why
     * the store only reports them.
     */
    listRunningCodingJobs(limit: number): AppCodingJob[];
    /**
     * A job's questions were posted; it is waiting for answers (#94).
     *
     * `running` → `awaiting-answer`, recording the plan, the comment that
     * carries the questions and the newest comment already accounted for (the
     * question itself). The state is in the WHERE clause, so a duplicate call
     * is a no-op and returns the row as it is.
     *
     * @returns The row after the attempt, or `null` for a missing id.
     */
    awaitCodingJob(
        id: string,
        input: {
            plan: string;
            questionCommentId?: number | null;
            lastSeenCommentId?: number | null;
        },
    ): AppCodingJob | null;
    /**
     * Reopens an awaiting job for another attempt:
     * `awaiting-answer` → `queued`. The transition is the claim, so two
     * pollers cannot start two runs; the next {@link claimCodingJob} owns the
     * container id and the attempt count.
     *
     * @param lastSeenCommentId - The newest comment now accounted for.
     * @returns The reopened row, or `null` when it was not awaiting.
     */
    reopenCodingJob(
        id: string,
        lastSeenCommentId?: number | null,
    ): AppCodingJob | null;
    /** Every `awaiting-answer` job across users — the poller's feed. */
    listAwaitingCodingJobs(limit: number): AppCodingJob[];
    /**
     * The parked jobs started from one chat session (#94), oldest first.
     *
     * The in-session ask relay reads this before a turn: only the conversation
     * that asked for the work is told the job is waiting.
     *
     * @param userId - The session's owner; a foreign session matches nothing.
     * @param sessionId - The chat session (the graph's thread id).
     * @param limit - A bound on how many parked jobs one turn is told about.
     * @returns The rows, each with its stored `questions`.
     */
    listAwaitingCodingJobsBySession(
        userId: number,
        sessionId: string,
        limit: number,
    ): AppCodingJob[];
    /**
     * Records the questions a job parked on (#94).
     *
     * @param id - The job.
     * @param questions - The agent's questions, already bounded by the
     * supervisor's artifact reader.
     */
    setCodingJobQuestions(id: string, questions: readonly string[]): void;
    /**
     * Recent jobs that name a pull request, newest first — the PR-feedback
     * feed (#94). The caller dedupes by URL: the first row for a PR is its
     * latest attempt and carries the watermark.
     */
    listCodingJobsWithPr(limit: number): AppCodingJob[];
    /**
     * Claims a `queued` job for this process: `queued` → `running`, recording
     * the container and counting the attempt.
     *
     * The state is in the WHERE clause, so a second claim — a duplicate start,
     * or a process that restarted mid-run — touches no row. The container id is
     * written here rather than later because it is what `resume` needs after a
     * crash: a row that named its container only on success would be
     * unrecoverable exactly when recovery matters.
     *
     * @returns The claimed row, or `null` when this caller did not win it.
     */
    claimCodingJob(
        id: string,
        containerId: string,
        at: string,
    ): AppCodingJob | null;
    /**
     * Cancels one of the caller's own **queued** or **awaiting-answer** jobs.
     *
     * A running job is not cancellable through this path: stopping its
     * container is the supervisor's act, not a row edit, and a row marked
     * cancelled while the agent kept writing would be a lie. (The service's
     * stop path owns that race.)
     *
     * @returns The row after the attempt — unchanged when it could not be
     * cancelled — or `null` when no such job belongs to `userId`.
     */
    cancelCodingJob(
        userId: number,
        id: string,
        at: string,
    ): AppCodingJob | null;
    /**
     * Replaces the stored output tail. Called by the supervisor when the run
     * ends (and by the reaper's prune path, from the logs it read first) — not
     * per line, because a SQLite write per log line would cost more than the
     * log is worth.
     */
    setCodingJobLogTail(id: string, tail: string): void;
    /**
     * Moves a `running` job to a terminal state, stamping `finished_at`.
     *
     * Terminal states are terminal: a settle of an already settled job returns
     * the existing row unchanged, so a late duplicate cannot rewrite history.
     * A `queued` row — never claimed, so no container ever ran — is left alone
     * **unless** the state is `failed`: that is the one ending a job can reach
     * before a container exists (a clone or a start that threw), and refusing
     * it would leave the row queued forever.
     */
    settleCodingJob(
        id: string,
        state: Exclude<
            CodingJobState,
            "queued" | "running" | "awaiting-answer"
        >,
        result: SettleCodingJobInput,
        at: string,
    ): AppCodingJob | null;
    /**
     * Trims a user's settled coding jobs to the newest `keep`, so a long-lived
     * instance cannot grow the table without bound. Queued and running rows are
     * never pruned.
     *
     * @returns The number of rows deleted.
     */
    pruneCodingJobs(userId: number, keep: number): number;
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
    SessionLedger &
    NotificationLedger &
    JobLedger &
    CodingJobLedger & {
        /** Releases the underlying connection. */
        close(): void;
    };

function now(): string {
    return new Date().toISOString();
}

/** A `users` table row as the SELECTs alias it (see {@link mapUser}). */
interface UserRow {
    id: number;
    username: string;
    role: Role;
    disabled: number;
    createdAt: string;
}

/** A `devices` table row as the SELECTs alias it (see {@link mapDevice}). */
interface DeviceRow {
    id: number;
    userId: number;
    name: string;
    prefix: string;
    createdAt: string;
    lastSeenAt: string | null;
}

/** A `sessions` table row as the SELECTs alias it (see {@link mapSession}). */
interface SessionRow {
    id: number;
    threadId: string;
    userId: number | null;
    deviceId: number | null;
    kind: SessionKind;
    createdAt: string;
    lastActiveAt: string;
}

/** The device⊕user join row `resolveTokenHash` reads (user columns `u_`-aliased). */
type DeviceIdentityRow = DeviceRow & {
    u_id: number;
    u_username: string;
    u_role: Role;
    u_disabled: number;
    u_created_at: string;
};

/** A `notifications` table row as the SELECTs alias it (see {@link mapNotification}). */
interface NotificationRow {
    id: string;
    userId: number;
    kind: string;
    class: NotificationClass;
    priority: NotificationPriority;
    title: string;
    body: string | null;
    state: NotificationState;
    requiresAnswer: number;
    dedupeKey: string | null;
    answer: string | null;
    jobId: string | null;
    codingJobId: string | null;
    createdAt: string;
    deliveredAt: string | null;
    settledAt: string | null;
}

/**
 * The notification SELECT list, shared by every read so a new column cannot
 * reach one query and miss another (`mapNotification` is the other half).
 */
const NOTIFICATION_COLUMNS = `SELECT id, user_id AS userId, kind, class, priority, title, body, state, requires_answer AS requiresAnswer, dedupe_key AS dedupeKey, answer, job_id AS jobId, coding_job_id AS codingJobId, created_at AS createdAt, delivered_at AS deliveredAt, settled_at AS settledAt FROM notifications`;

/** A `jobs` table row as the SELECTs alias it (see {@link mapJob}). */
interface JobRow {
    id: string;
    userId: number;
    label: string;
    class: NotificationClass;
    kind: JobKind;
    prompt: string | null;
    toolName: string | null;
    toolArgs: string | null;
    message: string | null;
    runAt: string;
    state: JobState;
    attempts: number;
    createdAt: string;
    settledAt: string | null;
    lastError: string | null;
    repeat: string | null;
    gate: string | null;
}

/** A `job_runs` table row (see {@link mapJobRun}). */
interface JobRunRow {
    id: string;
    jobId: string;
    startedAt: string;
    finishedAt: string | null;
    state: JobRunState;
    output: string | null;
    error: string | null;
    gateOutput: string | null;
    gateKey: string | null;
}

/** The job SELECT list, shared by every read (`mapJob` is the other half). */
const JOB_COLUMNS = `SELECT id, user_id AS userId, label, class, kind, prompt, tool_name AS toolName, tool_args AS toolArgs, message, run_at AS runAt, state, attempts, created_at AS createdAt, settled_at AS settledAt, last_error AS lastError, repeat, gate FROM jobs`;

/** The run SELECT list (`mapJobRun` is the other half). */
const JOB_RUN_COLUMNS = `SELECT id, job_id AS jobId, started_at AS startedAt, finished_at AS finishedAt, state, output, error, gate_output AS gateOutput, gate_key AS gateKey FROM job_runs`;

/** The states a job never returns from — settled, in the ledger's terms. */
const SETTLED_JOB_STATES = `('done', 'failed', 'cancelled', 'missed')`;

/** A `coding_jobs` row as the SELECTs alias it (see {@link mapCodingJob}). */
interface CodingJobRow {
    id: string;
    userId: number;
    repo: string;
    branch: string;
    prompt: string;
    state: CodingJobState;
    crashPolicy: CodingJobCrashPolicy;
    model: string | null;
    containerId: string | null;
    workspacePath: string;
    logTail: string;
    diffSummary: string | null;
    prUrl: string | null;
    issueNumber: number | null;
    questionCommentId: number | null;
    plan: string | null;
    lastSeenCommentId: number | null;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    sessionId: string | null;
    questionsJson: string | null;
}

/** The coding-job SELECT list (`mapCodingJob` is the other half). */
const CODING_JOB_COLUMNS = `SELECT id, user_id AS userId, repo, branch, prompt, state, crash_policy AS crashPolicy, model, container_id AS containerId, workspace_path AS workspacePath, log_tail AS logTail, diff_summary AS diffSummary, pr_url AS prUrl, issue_number AS issueNumber, question_comment_id AS questionCommentId, plan, last_seen_comment_id AS lastSeenCommentId, attempts, last_error AS lastError, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, session_id AS sessionId, questions_json AS questionsJson FROM coding_jobs`;

/** The states a coding job never returns from. */
const SETTLED_CODING_JOB_STATES = `('ok', 'failed', 'cancelled')`;

/**
 * Whether a rejected statement is better-sqlite3's UNIQUE-constraint
 * violation — the one case `createUser` (duplicate username) and
 * `renameDevice` (duplicate `(user_id, name)`) translate into an
 * {@link AuthError} (#107 P5: the two hand-rolled checks were identical).
 *
 * @param err - The thrown value.
 * @returns True when the failure is a unique-constraint violation.
 */
function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    );
}

function mapUser(row: UserRow): AppUser {
    return {
        id: row.id,
        username: row.username,
        role: row.role,
        disabled: row.disabled === 1,
        createdAt: row.createdAt,
    };
}

function mapDevice(row: DeviceRow): AppDevice {
    return {
        id: row.id,
        userId: row.userId,
        name: row.name,
        prefix: row.prefix,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
    };
}

function mapSession(row: SessionRow): AppSession {
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

/** Maps a `notifications` row onto the ledger's public shape. */
function mapNotification(row: NotificationRow): AppNotification {
    return {
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        class: row.class,
        priority: row.priority,
        title: row.title,
        body: row.body,
        state: row.state,
        requiresAnswer: row.requiresAnswer === 1,
        dedupeKey: row.dedupeKey,
        answer: row.answer,
        jobId: row.jobId,
        codingJobId: row.codingJobId,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
        settledAt: row.settledAt,
    };
}

/**
 * Parses a stored `tool_args` blob.
 *
 * A value that will not parse comes back as its raw text rather than as
 * `null`, the way `getPrefs` treats a corrupt `value_json`: a run has to be
 * able to say *why* it could not proceed, and a silent `null` would turn a
 * corrupt row into "this job needs no arguments".
 *
 * Shared with the `repeat` column (#90 phase 8b), which is read the same way
 * and for the same reason: an unreadable rule has to survive as itself, so the
 * scheduler can tell the user what it could not read rather than presenting a
 * job that quietly stopped repeating.
 */
function parseJsonColumn(value: string | null): unknown {
    if (value === null) {
        return null;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}

/** Maps a `jobs` row onto the ledger's public shape. */
function mapJob(row: JobRow): AppJob {
    return {
        id: row.id,
        userId: row.userId,
        label: row.label,
        class: row.class,
        kind: row.kind,
        prompt: row.prompt,
        toolName: row.toolName,
        toolArgs: parseJsonColumn(row.toolArgs),
        message: row.message,
        runAt: row.runAt,
        state: row.state,
        attempts: row.attempts,
        createdAt: row.createdAt,
        settledAt: row.settledAt,
        lastError: row.lastError,
        repeat: parseJsonColumn(row.repeat),
        gate: parseJsonColumn(row.gate),
    };
}

/** Maps a `job_runs` row onto the ledger's public shape. */
function mapJobRun(row: JobRunRow): AppJobRun {
    return {
        id: row.id,
        jobId: row.jobId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        state: row.state,
        output: row.output,
        error: row.error,
        gateOutput: row.gateOutput,
        gateKey: row.gateKey,
    };
}

/**
 * Parses a coding job's stored questions (#94).
 *
 * A row is written only from a validated artifact, so the array is the normal
 * shape. A corrupt value degrades to `null` (not `[]`) — "the questions are
 * unreadable" is different from "there were none", and the relay must not tell
 * the agent a job is waiting on nothing.
 *
 * @param value - The stored JSON, or `null`.
 * @returns The question strings, or `null` when there is no readable list.
 */
function parseQuestions(value: string | null): string[] | null {
    if (value === null) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return null;
        }
        const questions = parsed.filter(
            (entry): entry is string => typeof entry === "string",
        );
        return questions.length > 0 ? questions : null;
    } catch {
        return null;
    }
}

/** Maps a `coding_jobs` row onto the ledger's public shape. */
function mapCodingJob(row: CodingJobRow): AppCodingJob {
    return {
        id: row.id,
        userId: row.userId,
        repo: row.repo,
        branch: row.branch,
        prompt: row.prompt,
        state: row.state,
        crashPolicy: row.crashPolicy,
        model: row.model,
        containerId: row.containerId,
        workspacePath: row.workspacePath,
        logTail: row.logTail,
        diffSummary: row.diffSummary,
        prUrl: row.prUrl,
        issueNumber: row.issueNumber,
        questionCommentId: row.questionCommentId,
        plan: row.plan,
        lastSeenCommentId: row.lastSeenCommentId,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        sessionId: row.sessionId,
        questions: parseQuestions(row.questionsJson),
    };
}

/** The named `(user_id, name)` index the v2 migration creates on legacy stores. */
const DEVICE_NAME_INDEX = "idx_devices_user_name";
/**
 * How many notifications a list call returns when the caller does not say.
 *
 * Small enough that a badge/list load stays cheap, large enough to cover a
 * busy day of background work.
 */
const DEFAULT_NOTIFICATION_PAGE = 50;

/**
 * How many jobs a list call returns when the caller does not say.
 *
 * The same order of magnitude as a notification page: enough for an active
 * account's scheduled work, small enough to render in one go.
 */
const DEFAULT_JOB_PAGE = 50;

/**
 * How many coding jobs a list call returns when the caller does not say.
 *
 * Smaller than the scheduled-job page: a coding job is a minutes-to-hours
 * affair, so a page of twenty is already a long history, and each row carries a
 * log tail the scheduled-job rows do not.
 */
const DEFAULT_CODING_JOB_PAGE = 20;

/**
 * How many runs of one job a history call returns.
 *
 * A job is a repeating thing by nature (recurrence is phase 8), so the run
 * history is the one list here that genuinely grows per job.
 */
const DEFAULT_JOB_RUN_PAGE = 20;

/**
 * How many runs of one job the store keeps (#90 phase 8b).
 *
 * Comfortably above {@link DEFAULT_JOB_RUN_PAGE}: the page is a view of the
 * history, so the history has to be bigger than the page for the trim never to
 * be the reason a detail view looks short.
 */
const DEFAULT_JOB_RUN_KEEP = 50;

/**
 * Whether `table` already has a column named `column`.
 *
 * An additive migration (`ALTER TABLE … ADD COLUMN`) is not idempotent the way
 * `CREATE TABLE IF NOT EXISTS` is — SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * and running it twice is an error — so the step that adds a column must ask
 * first, because it also runs against a fresh database that already has the
 * column from SCHEMA.
 */
function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
): boolean {
    const columns = db.pragma(`table_info('${table}')`) as { name: string }[];
    return columns.some((c) => c.name === column);
}

/**
 * How many rows anywhere in the database reference a row that does not exist.
 *
 * `PRAGMA foreign_key_check` reports every violation in every table, which is the
 * right scope when the caller wants to know whether *it* introduced one: a
 * migration compares this count before and after its own work rather than
 * demanding a database that is already clean.
 */
function countForeignKeyViolations(db: Database.Database): number {
    return (db.pragma("foreign_key_check") as unknown[]).length;
}

/**
 * Whether a table's stored DDL mentions `fragment`.
 *
 * `hasColumn` answers "does this column exist"; this answers "does this
 * *constraint* exist", which is what a CHECK rebuild has to guard on — the state
 * set is not a column of its own. Reading `sqlite_master` is the direct question:
 * the table's own SQL either names the value or it does not.
 */
function tableSqlHas(
    db: Database.Database,
    table: string,
    fragment: string,
): boolean {
    const row = db
        .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table) as { sql: string | null } | undefined;
    return row?.sql?.includes(fragment) ?? false;
}

/**
 * Whether `devices` already carries a UNIQUE index over exactly
 * `(user_id, name)` — either the named {@link DEVICE_NAME_INDEX} (v2's
 * legacy-store migration) or the inline table constraint's automatic index
 * (every database created from the current SCHEMA). Only indexes whose
 * columns are exactly that pair count, so unrelated unique indexes never
 * satisfy the check.
 */
function hasDeviceNameUniqueIndex(db: Database.Database): boolean {
    const indexes = db.pragma("index_list(devices)") as {
        name: string;
        unique: number;
    }[];
    for (const index of indexes) {
        if (index.unique !== 1) {
            continue;
        }
        const columns = (
            db.pragma(`index_info('${index.name}')`) as { name: string }[]
        ).map((c) => c.name);
        if (
            columns.length === 2 &&
            columns.includes("user_id") &&
            columns.includes("name")
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Whether `devices` carries a UNIQUE `(user_id, name)` enforcement *other
 * than* the named {@link DEVICE_NAME_INDEX} — the inline constraint's
 * automatic index on any current-schema database.
 */
function hasInlineDeviceNameUniqueIndex(db: Database.Database): boolean {
    const indexes = db.pragma("index_list(devices)") as {
        name: string;
        unique: number;
    }[];
    for (const index of indexes) {
        if (index.unique !== 1 || index.name === DEVICE_NAME_INDEX) {
            continue;
        }
        const columns = (
            db.pragma(`index_info('${index.name}')`) as { name: string }[]
        ).map((c) => c.name);
        if (
            columns.length === 2 &&
            columns.includes("user_id") &&
            columns.includes("name")
        ) {
            return true;
        }
    }
    return false;
}

/**
 * What a migration had to change to bring an existing store up to date (#90
 * phase 6c).
 *
 * Reported rather than logged, because the store has no logger: it records facts,
 * and the process that opened it decides whether to say them (the server does, at
 * `warn`, because a silent repair is the kind of thing that is only ever learned
 * the hard way).
 */
export interface MigrationReport {
    /**
     * Notifications whose `job_id` pointed at a job that no longer exists, nulled
     * before the v12 rebuild copied them.
     *
     * This is the action `ON DELETE SET NULL` would have taken, applied late. It
     * happens when a job was deleted without foreign keys enforced — the
     * `sqlite3` CLI leaves them off by default — so the row outlived the thing it
     * named.
     */
    repairedNotificationJobLinks: number;
    /**
     * Notifications deleted because their account no longer exists: rows no
     * account can reach, and what `ON DELETE CASCADE` would have done.
     */
    droppedOrphanedNotifications: number;
    /**
     * Notifications deleted because they were dismissed (#90 phase 9c) — rows
     * the v16 migration removes now that nothing writes that state and a
     * dismissal means "I am finished with this".
     */
    droppedDismissedNotifications: number;
    /**
     * Runs deleted because the job they belong to is gone (#90 phase 8f).
     *
     * Dropped rather than repaired: a run *is* its job's history, so a run with
     * no job has nothing to be history *of* — and unlike a notification's link,
     * the column cannot be nulled. The same cause as
     * {@link repairedNotificationJobLinks}: a delete performed with foreign keys
     * off, which the `sqlite3` CLI does by default.
     */
    droppedOrphanedJobRuns: number;
}

/** Options for opening or constructing a store. */
export interface AppDatabaseOptions {
    /**
     * Called once per open, and only when a migration had to repair something —
     * a clean database reports nothing at all.
     */
    onMigrationRepair?(report: MigrationReport): void;
}

/**
 * Deletes the notifications that were dismissed (#90 phase 9c).
 *
 * Not a repair of corruption but of a **decision that changed**: dismissal used
 * to be a terminal state a row sat in, and it now deletes the row outright, so
 * the rows already in it are the vestige. They are counted rather than silently
 * swept, because a migration that removes rows a user could still have been
 * shown should say how many it removed.
 *
 * Runs inside the caller's transaction — v16 rebuilds the table with the narrowed
 * CHECK, which could not carry them anyway — and counts only what it dropped.
 *
 * @param db - The connection being migrated (foreign keys on).
 * @returns How many rows the purge touched, in the report's own fields.
 */
function purgeDismissedNotifications(db: Database.Database): MigrationReport {
    const dropped = db
        .prepare("DELETE FROM notifications WHERE state = 'dismissed'")
        .run().changes;
    return {
        repairedNotificationJobLinks: 0,
        droppedOrphanedNotifications: 0,
        droppedDismissedNotifications: dropped,
        droppedOrphanedJobRuns: 0,
    };
}

/**
 * Drops the runs whose job no longer exists (#90 phase 8f).
 *
 * The run-row sibling of {@link repairNotificationReferences}, and it *deletes*
 * where that one nulls a link: `job_runs.job_id` is `NOT NULL`, and a run is
 * only ever an attempt at its job, so there is no row left to keep.
 *
 * This exists because the v15 rebuild validates its copy with foreign keys on —
 * the same choice v12 made, and the same lesson: a migration that refuses to open
 * a store it could have carried is worse than one that repairs it. Left in place
 * these rows refuse the boot; removed and reported, the store opens and the
 * operator is told.
 *
 * Runs inside the caller's transaction, and counts only what it dropped.
 *
 * @param db - The connection being migrated (foreign keys on).
 * @returns How many rows the repair touched, in the report's own fields.
 */
function repairJobRunReferences(db: Database.Database): MigrationReport {
    const dropped = db
        .prepare(
            "DELETE FROM job_runs WHERE job_id NOT IN (SELECT id FROM jobs)",
        )
        .run().changes;
    return {
        repairedNotificationJobLinks: 0,
        droppedOrphanedNotifications: 0,
        droppedDismissedNotifications: 0,
        droppedOrphanedJobRuns: dropped,
    };
}

/**
 * Repairs the notification references a bypassed delete left behind (#90 phase
 * 6c).
 *
 * A migration carries rows forward, so it cannot assume they are sound: a job
 * deleted by hand with `foreign_keys` off leaves a `job_id` pointing at nothing,
 * and an account deleted the same way leaves a row nobody can read. Both are
 * repaired to what the schema already promises rather than treated as a failure —
 * the alternative is a server that refuses to boot on data it could have carried,
 * which is exactly what happened the first time this shipped.
 *
 * Runs inside the caller's transaction. Removing a violation is always legal with
 * foreign keys enforced, which is why the copy can then be validated with them on.
 *
 * @param db - The connection being migrated (foreign keys on).
 * @returns How many rows each repair touched.
 */
function repairNotificationReferences(db: Database.Database): MigrationReport {
    const repaired = db
        .prepare(
            `UPDATE notifications SET job_id = NULL
              WHERE job_id IS NOT NULL
                AND job_id NOT IN (SELECT id FROM jobs)`,
        )
        .run();
    const dropped = db
        .prepare(
            `DELETE FROM notifications
              WHERE user_id NOT IN (SELECT id FROM users)`,
        )
        .run();
    return {
        repairedNotificationJobLinks: repaired.changes,
        droppedOrphanedNotifications: dropped.changes,
        droppedDismissedNotifications: 0,
        droppedOrphanedJobRuns: 0,
    };
}

function migrate(db: Database.Database, options?: AppDatabaseOptions): void {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version < 1) {
        db.exec(SCHEMA);
        db.pragma("user_version = 1");
    }
    if (version < 2) {
        // v2: one device row per (user, name) so re-login re-issues rather
        // than growing the device list endlessly. Created only when no
        // unique (user_id, name) enforcement exists yet (a current-schema
        // database already has the inline table constraint), so v6's
        // convergence never re-creates work this step just did.
        if (!hasDeviceNameUniqueIndex(db)) {
            db.exec(
                `CREATE UNIQUE INDEX IF NOT EXISTS ${DEVICE_NAME_INDEX} ON devices (user_id, name)`,
            );
        }
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
    if (version < 5) {
        // v5: multiple owner accounts may coexist — an owner can promote a new
        // owner (handover) and only demote an owner while another enabled one
        // remains. The "at least one owner" invariant moves from this partial
        // index into `setUserRole`'s LAST_OWNER guard, so existing single-
        // owner stores and fresh databases converge on the same v5 shape.
        db.exec("DROP INDEX IF EXISTS idx_users_single_owner");
        db.pragma("user_version = 5");
    }
    if (version < 6) {
        // v6: converge on exactly ONE unique (user_id, name) enforcement.
        // Fresh databases carry the inline table constraint (an automatic
        // index); legacy stores got the named idx_devices_user_name from v2.
        // Where the inline enforcement exists, the named index is redundant —
        // drop it. Legacy stores (whose only enforcement is the named index)
        // keep it, so both shapes end at one unique index.
        if (hasInlineDeviceNameUniqueIndex(db)) {
            db.exec(`DROP INDEX IF EXISTS ${DEVICE_NAME_INDEX}`);
        }
        db.pragma("user_version = 6");
    }
    if (version < 7) {
        // v7: notifications (#139). A fresh database gets the table from
        // SCHEMA; this branch brings an existing one to the same shape. The
        // DDL is repeated rather than extracted because it runs once per
        // store in its own right — and the table, not the string, is what
        // must match SCHEMA.
        db.exec(`CREATE TABLE IF NOT EXISTS notifications (
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
CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications (user_id, created_at DESC);`);
        db.pragma("user_version = 7");
    }
    if (version < 8) {
        // v8: the scheduler's tables (#90). A fresh database gets them from
        // SCHEMA; this branch brings an existing one to the same shape. The
        // DDL comes from the same constant SCHEMA interpolates, so the two
        // cannot drift.
        db.exec(JOBS_SCHEMA);
        db.pragma("user_version = 8");
    }
    if (version < 9) {
        // v9: the notification class (#90). Additive rather than a table
        // rebuild, because the default makes the migration total: every
        // existing notification becomes the quiet class, so nothing a user
        // already received changes meaning (and nothing is dropped).
        //
        // Guarded because ADD COLUMN is the one step in this function that is
        // not idempotent — a fresh database already has the column from
        // SCHEMA, and SQLite has no `ADD COLUMN IF NOT EXISTS`.
        if (!hasColumn(db, "notifications", "class")) {
            db.exec(
                `ALTER TABLE notifications ADD COLUMN class TEXT NOT NULL DEFAULT 'notification' CHECK (class IN ('notification', 'reminder', 'timer'))`,
            );
        }
        db.pragma("user_version = 9");
    }
    if (version < 10) {
        // v10: a job's delivery class, and the `message` payload (#90 phase 2b).
        //
        // SQLite cannot alter a CHECK constraint in place, so the table is
        // rebuilt the way it documents — and with **foreign keys off** for the
        // duration, because `job_runs` references `jobs`: dropping the old
        // table with enforcement on would cascade a user's entire run history
        // away, and an INSERT ... SELECT cannot save it (the cascade fires on
        // the DROP). Guarded on the column, so a fresh database — which already
        // has the new shape from SCHEMA — skips the rebuild entirely.
        if (!hasColumn(db, "jobs", "message")) {
            // The database's own violation count, before the swap: a migration
            // carries rows forward and cannot assume they are sound, so what it
            // must prove is that it added nothing — not that everything is
            // perfect (the v12 rebuild learned this the expensive way, #90 phase
            // 6c: a job deleted by hand with foreign keys off left an orphan, and
            // the check below refused to open the store at all).
            const violationsBefore = countForeignKeyViolations(db);
            db.pragma("foreign_keys = OFF");
            try {
                db.exec(`${jobsTable("jobs_v10")};
INSERT INTO jobs_v10 (
    id, user_id, label, class, kind, prompt, tool_name, tool_args, message,
    run_at, state, attempts, created_at, settled_at, last_error
)
SELECT id, user_id, label, 'notification', kind, prompt, tool_name, tool_args,
       NULL, run_at, state, attempts, created_at, settled_at, last_error
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_v10 RENAME TO jobs;
${JOB_INDEXES}`);
                // The documented last step, now a comparison: a rebuild that
                // silently orphaned runs would be worse than a loud failure, and a
                // pre-existing orphan is not this step's to fix.
                const violationsAfter = countForeignKeyViolations(db);
                if (violationsAfter > violationsBefore) {
                    throw new Error(
                        `the jobs rebuild added ${violationsAfter - violationsBefore} foreign-key violation(s)`,
                    );
                }
            } finally {
                // Restored even when the rebuild throws: the connection must
                // not be left in the permissive state borrowed for one step.
                db.pragma("foreign_keys = ON");
            }
        }
        db.pragma("user_version = 10");
    }
    if (version < 11) {
        // v11: the notification → job link (#90 phase 5). Additive rather than
        // a rebuild, because NULL is the total default: every notification a
        // user already received simply has no job behind it.
        //
        // Guarded for the usual reason — ADD COLUMN is the one step here that
        // is not idempotent, and SCHEMA already carries the column on a fresh
        // database. The FK is added by ALTER rather than by a table rebuild, so
        // the column lands last, which is where SCHEMA puts it too: the two
        // shapes converge exactly. `ON DELETE SET NULL` because jobs are
        // pruned as history while a notification the user was already shown
        // stays true — a dangling link would be worse than none.
        if (!hasColumn(db, "notifications", "job_id")) {
            db.exec(
                `ALTER TABLE notifications ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL`,
            );
        }
        db.pragma("user_version = 11");
    }
    if (version < 12) {
        // v12: `snoozed` as a terminal notification state (#90 phase 6c).
        //
        // A rebuild, because SQLite cannot widen a CHECK in place — the same
        // *shape* of step as v10's, guarded differently: there is no column to
        // test for (the state set is not a column), so the guard reads the
        // table's own SQL from `sqlite_master`. Without it a fresh database,
        // which already has the wider CHECK from SCHEMA, would drop and re-create
        // an empty table on every open.
        //
        // Foreign keys stay **on**, which v10 could not do (its table had a
        // child, so the DROP would have cascaded) and this one can: nothing
        // references `notifications`, so the DROP cascades nothing and the INSERT
        // is validated on the way through. That only works because the references
        // are repaired *first* — see `repairNotificationReferences`. A migration
        // carries rows forward and cannot assume they are sound; letting a
        // dangling link from an unenforced delete refuse the open is how this
        // shipped broken the first time.
        if (!tableSqlHas(db, "notifications", "'snoozed'")) {
            let report: MigrationReport = {
                repairedNotificationJobLinks: 0,
                droppedOrphanedNotifications: 0,
                droppedDismissedNotifications: 0,
                droppedOrphanedJobRuns: 0,
            };
            // One transaction: SQLite makes DDL transactional, so a failure
            // anywhere in this sequence — the repairs included — leaves the old
            // table exactly as it was. A half-swapped notification list is the one
            // outcome this step must not produce.
            const rebuild = db.transaction((): void => {
                report = repairNotificationReferences(db);
                db.exec(`${notificationsTable("notifications_v12", {
                    // v12 predates coding_jobs (#94): a FK to a table that
                    // does not exist yet makes the copy fail under
                    // `foreign_keys=ON`. v20 adds the column once it does.
                    codingJobLink: false,
                })};
INSERT INTO notifications_v12 (
    id, user_id, kind, class, priority, title, body, state, requires_answer,
    dedupe_key, answer, created_at, delivered_at, settled_at, job_id
)
SELECT id, user_id, kind, class, priority, title, body, state, requires_answer,
       dedupe_key, answer, created_at, delivered_at, settled_at, job_id
  FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_v12 RENAME TO notifications;
${NOTIFICATION_INDEXES}`);
                // A self-check, not a data check: the repairs above are supposed
                // to leave every reference resolvable, so a violation here means
                // this migration is wrong rather than the store is corrupt. Scoped
                // to this table on purpose — the database may hold violations
                // elsewhere that predate it and are not its business.
                const dangling = db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM notifications n
                          WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = n.user_id)
                             OR (n.job_id IS NOT NULL
                                 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = n.job_id))`,
                    )
                    .get() as { n: number };
                if (dangling.n > 0) {
                    throw new Error(
                        `the notifications rebuild left ${dangling.n} dangling reference(s)`,
                    );
                }
            });
            rebuild();
            if (
                report.repairedNotificationJobLinks > 0 ||
                report.droppedOrphanedNotifications > 0
            ) {
                options?.onMigrationRepair?.(report);
            }
        }
        db.pragma("user_version = 12");
    }
    if (version < 13) {
        // v13: the recurrence rule (#90 phase 8b). Additive, so the guard is the
        // column check every ALTER in this chain uses — a fresh database already
        // has it through `jobsTable`, and an existing one has never seen it.
        //
        // Nothing is repaired here on purpose. The rule is JSON, read defensively
        // (`parseJsonColumn`): a value that will not parse is reported by the
        // scheduler as a rule it cannot read, which is a better answer than a
        // migration silently rewriting a user's schedule — and there is no
        // constraint to widen, because the shape is validated where it is used.
        if (!hasColumn(db, "jobs", "repeat")) {
            db.exec("ALTER TABLE jobs ADD COLUMN repeat TEXT");
        }
        db.pragma("user_version = 13");
    }
    if (version < 14) {
        // v14: the daily model-run budget (#90 phase 8c). A table rather than a
        // column, so unlike the ALTERs above it is idempotent on its own —
        // `IF NOT EXISTS` is the guard, and a fresh database already has it
        // through `SCHEMA`.
        db.exec(JOB_MODEL_RUNS_TABLE);
        db.pragma("user_version = 14");
    }
    if (version < 15) {
        // v15: the gate (#90 phase 8f) — a firing that can decline, and what its
        // check read.
        //
        // Two steps with one cause. `jobs.gate` is additive, with the usual
        // guard. `job_runs` has to be **rebuilt**, because `skipped` widens a
        // CHECK that SQLite cannot alter in place — and this rebuild can keep
        // foreign keys **on**, like v12's and unlike v10's: nothing references
        // `job_runs`, so the DROP cascades nothing and the INSERT is validated on
        // the way through.
        //
        // That only holds because the orphan rows are removed *first*.
        // `job_runs.job_id` is NOT NULL, so a run whose job was deleted with
        // enforcement off cannot be carried forward — it is dropped and reported,
        // rather than refusing the open. This database really did hold thirteen
        // of them, and the v12 incident is why the repair exists at all: a store
        // that will not boot on data it could have carried is worse than one that
        // says what it repaired.
        if (!hasColumn(db, "jobs", "gate")) {
            db.exec("ALTER TABLE jobs ADD COLUMN gate TEXT");
        }
        if (!tableSqlHas(db, "job_runs", "'skipped'")) {
            let report: MigrationReport = {
                repairedNotificationJobLinks: 0,
                droppedOrphanedNotifications: 0,
                droppedDismissedNotifications: 0,
                droppedOrphanedJobRuns: 0,
            };
            // One transaction, for the reason v12 gives: SQLite makes DDL
            // transactional, so a failure anywhere — the repair included — leaves
            // the old table exactly as it was.
            const rebuild = db.transaction((): void => {
                report = repairJobRunReferences(db);
                db.exec(`${jobRunsTable("job_runs_v15")};
INSERT INTO job_runs_v15 (
    id, job_id, started_at, finished_at, state, output, error, gate_output,
    gate_key
)
SELECT id, job_id, started_at, finished_at, state, output, error, NULL, NULL
  FROM job_runs;
DROP TABLE job_runs;
ALTER TABLE job_runs_v15 RENAME TO job_runs;
CREATE INDEX IF NOT EXISTS idx_job_runs_job
    ON job_runs (job_id, started_at DESC);`);
                // A self-check, not a data check: the repair above is supposed to
                // leave every reference resolvable, so a violation here means this
                // migration is wrong rather than the store is corrupt.
                const dangling = db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM job_runs r
                          WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = r.job_id)`,
                    )
                    .get() as { n: number };
                if (dangling.n > 0) {
                    throw new Error(
                        `the job_runs rebuild left ${dangling.n} dangling reference(s)`,
                    );
                }
            });
            rebuild();
            if (report.droppedOrphanedJobRuns > 0) {
                options?.onMigrationRepair?.(report);
            }
        }
        db.pragma("user_version = 15");
    }
    if (version < 16) {
        // v16: dismissal deletes the row, so `dismissed` leaves the state
        // vocabulary (#90 phase 9c).
        //
        // The purge comes first for the reason v12 and v15 both learned: the
        // rebuild copies with foreign keys **on** and a narrowed CHECK, so a row
        // still in the removed state would fail the insert and refuse the open.
        // Nothing references `notifications`, so the DROP cascades nothing, and
        // the table's index comes back through `NOTIFICATION_INDEXES` — the same
        // shape as the v12 rebuild, without the repairs it does not need.
        //
        // Guarded on the table's SQL, and the polarity is the *opposite* of
        // v12's: there the fragment named a state the old table lacked, here it
        // names the one it still allows. A fresh database already has the narrow
        // CHECK from `notificationsTable`, so this must refuse to rebuild it on
        // every open.
        if (tableSqlHas(db, "notifications", "'dismissed'")) {
            let report: MigrationReport = {
                repairedNotificationJobLinks: 0,
                droppedOrphanedNotifications: 0,
                droppedDismissedNotifications: 0,
                droppedOrphanedJobRuns: 0,
            };
            const rebuild = db.transaction((): void => {
                report = purgeDismissedNotifications(db);
                db.exec(`${notificationsTable("notifications_v16", {
                    codingJobLink: false,
                })};
INSERT INTO notifications_v16 (
    id, user_id, kind, class, priority, title, body, state, requires_answer,
    dedupe_key, answer, created_at, delivered_at, settled_at, job_id
)
SELECT id, user_id, kind, class, priority, title, body, state, requires_answer,
       dedupe_key, answer, created_at, delivered_at, settled_at, job_id
  FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_v16 RENAME TO notifications;
${NOTIFICATION_INDEXES}`);
                // A self-check, not a data check: the purge is supposed to leave
                // nothing in the removed state, so a surviving row means this
                // migration is wrong rather than the store is corrupt.
                const vestigial = db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM notifications WHERE state = 'dismissed'",
                    )
                    .get() as { n: number };
                if (vestigial.n > 0) {
                    throw new Error(
                        `the notifications rebuild left ${vestigial.n} dismissed row(s)`,
                    );
                }
            });
            rebuild();
            if (report.droppedDismissedNotifications > 0) {
                options?.onMigrationRepair?.(report);
            }
        }
        db.pragma("user_version = 16");
    }

    if (version < 17) {
        // The coding-job table (#141) is new, not rebuilt: nothing has to be
        // carried forward, and `CREATE TABLE IF NOT EXISTS` keeps a fresh
        // database — which already has it from `SCHEMA` — a no-op.
        db.exec(CODING_JOBS_SCHEMA);
        db.pragma("user_version = 17");
    }

    if (version < 18) {
        // v18: the model a coding job ran with (#141). Additive, because the
        // question is about a run and existing rows have no answer — `null`
        // says exactly that. Guarded like the other ALTERs: a fresh database
        // already has the column from `SCHEMA`.
        if (!hasColumn(db, "coding_jobs", "model")) {
            db.exec("ALTER TABLE coding_jobs ADD COLUMN model TEXT");
        }
        db.pragma("user_version = 18");
    }

    if (version < 19) {
        // v19: `awaiting-answer` joins the coding-job states (#94), and the row
        // learns where its questions were posted. SQLite cannot widen a CHECK
        // in place, so rebuild — the same shape as v16. The four new columns
        // are filled with NULL for existing rows; the guard keeps a fresh
        // database (which already has the new table from `SCHEMA`) untouched.
        if (!tableSqlHas(db, "coding_jobs", "'awaiting-answer'")) {
            const rebuild = db.transaction((): void => {
                db.exec(`${codingJobsTable("coding_jobs_v19")};
INSERT INTO coding_jobs_v19 (
    id, user_id, repo, branch, prompt, state, crash_policy, container_id,
    workspace_path, model, log_tail, diff_summary, pr_url, attempts,
    last_error, created_at, started_at, finished_at
)
SELECT id, user_id, repo, branch, prompt, state, crash_policy, container_id,
       workspace_path, model, log_tail, diff_summary, pr_url, attempts,
       last_error, created_at, started_at, finished_at
  FROM coding_jobs;
DROP TABLE coding_jobs;
ALTER TABLE coding_jobs_v19 RENAME TO coding_jobs;
${CODING_JOB_INDEXES}`);
            });
            rebuild();
        }
        db.pragma("user_version = 19");
    }

    if (version < 20) {
        // v20: the answerable ask (#94). A notification that asks a question
        // names the coding job the answer resumes, and a job remembers the
        // chat session that asked for it plus the questions it parked on.
        // Additive like the other ALTERs — every existing row means "no link",
        // which is exactly true.
        if (!hasColumn(db, "notifications", "coding_job_id")) {
            db.exec(
                "ALTER TABLE notifications ADD COLUMN coding_job_id TEXT REFERENCES coding_jobs(id) ON DELETE SET NULL",
            );
        }
        if (!hasColumn(db, "coding_jobs", "session_id")) {
            db.exec("ALTER TABLE coding_jobs ADD COLUMN session_id TEXT");
        }
        if (!hasColumn(db, "coding_jobs", "questions_json")) {
            db.exec("ALTER TABLE coding_jobs ADD COLUMN questions_json TEXT");
        }
        db.pragma("user_version = 20");
    }
}

export function openAppDatabase(
    dbPath: string,
    options?: AppDatabaseOptions,
): AppDatabase {
    ensurePrivateStorage(dbPath);
    const store = new SqliteAppDatabase(new Database(dbPath), options);
    // Belt-and-suspenders chmod: the file was pre-created at 0600, but a
    // library migration that reopens it stays safe even on odd filesystems.
    ensurePrivateFile(dbPath);
    return store;
}

export class SqliteAppDatabase implements AppDatabase {
    private readonly db: Database.Database;
    /** The run-ending + job-settling pair, compiled once (see the constructor). */
    private readonly settleFiring: (input: SettleFiringInput) => void;
    private readonly statements: {
        insertUser: Database.Statement;
        selectUserByUsername: Database.Statement;
        selectUserPasswordHash: Database.Statement;
        selectUserById: Database.Statement;
        selectOwnerCount: Database.Statement;
        selectOtherEnabledOwners: Database.Statement;
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
        deleteExpiredWebSessions: Database.Statement;
        upsertPref: Database.Statement;
        selectPrefs: Database.Statement;
        deletePrefKey: Database.Statement;
        insertNotification: Database.Statement;
        selectNotification: Database.Statement;
        selectNotifications: Database.Statement;
        deleteNotification: Database.Statement;
        settleCodingQuestionNotifications: Database.Statement;
        selectNotificationsForJob: Database.Statement;
        countUnreadNotifications: Database.Statement;
        settleNotification: Database.Statement;
        pruneSettledNotifications: Database.Statement;
        pruneNotifications: Database.Statement;
        insertJob: Database.Statement;
        selectJob: Database.Statement;
        selectJobById: Database.Statement;
        selectJobs: Database.Statement;
        selectJobsWithSettled: Database.Statement;
        selectDueJobs: Database.Statement;
        selectRunningJobs: Database.Statement;
        claimJob: Database.Statement;
        rescheduleJob: Database.Statement;
        settleJob: Database.Statement;
        cancelJob: Database.Statement;
        moveJob: Database.Statement;
        editJob: Database.Statement;
        insertJobRun: Database.Statement;
        finishJobRun: Database.Statement;
        failOpenJobRuns: Database.Statement;
        selectJobRuns: Database.Statement;
        pruneJobs: Database.Statement;
        pruneJobRuns: Database.Statement;
        rearmJob: Database.Statement;
        countModelRuns: Database.Statement;
        recordModelRun: Database.Statement;
        insertCodingJob: Database.Statement;
        selectCodingJob: Database.Statement;
        selectCodingJobById: Database.Statement;
        selectCodingJobs: Database.Statement;
        selectCodingJobsWithSettled: Database.Statement;
        selectRunningCodingJobs: Database.Statement;
        selectAwaitingCodingJobs: Database.Statement;
        selectAwaitingCodingJobsBySession: Database.Statement;
        selectCodingJobsWithPr: Database.Statement;
        awaitCodingJob: Database.Statement;
        reopenCodingJob: Database.Statement;
        setCodingJobQuestions: Database.Statement;
        claimCodingJob: Database.Statement;
        settleCodingJob: Database.Statement;
        cancelCodingJob: Database.Statement;
        setCodingJobLogTail: Database.Statement;
        pruneCodingJobs: Database.Statement;
    };

    constructor(db: Database.Database, options?: AppDatabaseOptions) {
        this.db = db;
        db.pragma("foreign_keys = ON");
        migrate(db, options);
        // One firing's ending, in one transaction: the run's row and the job's
        // state are a single fact, and a process that died between them would
        // leave a job claiming to run a job that is over (or, worse, a series
        // with no successor). `announce` and the prune stay outside it — a
        // better-sqlite3 transaction is synchronous, and the announcement is a
        // network round trip.
        this.settleFiring = db.transaction((input: SettleFiringInput) => {
            this.statements.finishJobRun.run(
                input.run.state,
                input.run.output ?? null,
                input.run.error ?? null,
                input.run.gateOutput ?? null,
                input.run.gateKey ?? null,
                input.at,
                input.runId,
            );
            if (input.job.state === "pending") {
                this.statements.rearmJob.run(
                    input.job.runAt,
                    input.job.error ?? null,
                    input.jobId,
                );
                return;
            }
            this.statements.settleJob.run(
                input.job.state,
                input.job.error ?? null,
                input.at,
                input.jobId,
            );
        });
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
            selectOtherEnabledOwners: db.prepare(
                "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?",
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
                "SELECT d.id AS id, d.user_id AS userId, d.name AS name, d.prefix AS prefix, d.created_at AS createdAt, d.last_seen_at AS lastSeenAt, u.id AS u_id, u.username AS u_username, u.role AS u_role, u.disabled AS u_disabled, u.created_at AS u_created_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.secret_hash = ? AND u.disabled = 0",
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
            deleteExpiredWebSessions: db.prepare(
                "DELETE FROM web_sessions WHERE expires_at <= ?",
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
            insertNotification: db.prepare(
                "INSERT INTO notifications (id, user_id, kind, class, priority, title, body, state, requires_answer, dedupe_key, job_id, coding_job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
            ),
            selectNotification: db.prepare(
                `${NOTIFICATION_COLUMNS} WHERE user_id = ? AND id = ?`,
            ),
            selectNotifications: db.prepare(
                `${NOTIFICATION_COLUMNS} WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            // Dismissal deletes the row (#90 phase 9c), so there is no second
            // "include the dismissed ones" read: a row is either there or gone.
            deleteNotification: db.prepare(
                "DELETE FROM notifications WHERE user_id = ? AND id = ?",
            ),
            // A coding job that resumed has moved past its question (#94).
            // `exceptId` lets the REST answer keep its own row so the route can
            // store the answer text on it.
            settleCodingQuestionNotifications: db.prepare(
                "UPDATE notifications SET state = 'read', settled_at = ? WHERE user_id = ? AND coding_job_id = ? AND requires_answer = 1 AND state IN ('pending', 'delivered') AND (? IS NULL OR id != ?)",
            ),
            // The announcements a job produced (#90 phase 6c). A job announces
            // once per run, so this is normally one row — but "normally one" is
            // not a reason to guess an id: the link is the durable fact.
            selectNotificationsForJob: db.prepare(
                `${NOTIFICATION_COLUMNS} WHERE user_id = ? AND job_id = ? ORDER BY created_at DESC, rowid DESC`,
            ),
            countUnreadNotifications: db.prepare(
                `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND state NOT IN (${NOTIFICATION_TERMINAL_SQL})`,
            ),
            // One statement covers every transition: the terminal guard lives
            // in the WHERE clause, so a late duplicate ack touches no row and
            // the caller re-reads the settled one instead. `delivered_at` and
            // `settled_at` are stamped only by the states that imply them.
            settleNotification: db.prepare(
                `UPDATE notifications SET state = ?, answer = COALESCE(?, answer), delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, settled_at = CASE WHEN ? IN (${NOTIFICATION_TERMINAL_SQL}) THEN ? ELSE settled_at END WHERE user_id = ? AND id = ? AND state NOT IN (${NOTIFICATION_TERMINAL_SQL})`,
            ),
            // Two passes, because the ceiling has to hold for the table and
            // not merely for its settled rows: a client that is repeatedly
            // offline creates `pending` rows no user has seen, and a rule that
            // only trimmed settled rows would let those grow without bound.
            // The first pass evicts settled rows that fall outside the newest
            // `keep` rows *overall*, so an unsettled row is only reached by the
            // second pass when unsettled rows alone exceed the ceiling — i.e.
            // exactly when there is no alternative.
            pruneSettledNotifications: db.prepare(
                "DELETE FROM notifications WHERE user_id = ? AND state != 'pending' AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)",
            ),
            pruneNotifications: db.prepare(
                "DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)",
            ),
            insertJob: db.prepare(
                "INSERT INTO jobs (id, user_id, label, class, kind, prompt, tool_name, tool_args, message, run_at, state, created_at, repeat, gate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
            ),
            selectJob: db.prepare(
                `${JOB_COLUMNS} WHERE user_id = ? AND id = ?`,
            ),
            selectJobById: db.prepare(`${JOB_COLUMNS} WHERE id = ?`),
            selectJobs: db.prepare(
                `${JOB_COLUMNS} WHERE user_id = ? AND state NOT IN ${SETTLED_JOB_STATES} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            selectJobsWithSettled: db.prepare(
                `${JOB_COLUMNS} WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            // The claim feed: due work across every account, oldest first, so
            // the scheduler works through a backlog in the order it arrived.
            selectDueJobs: db.prepare(
                `${JOB_COLUMNS} WHERE state = 'pending' AND run_at <= ? ORDER BY run_at ASC, rowid ASC LIMIT ?`,
            ),
            // The recovery feed: any `running` row belongs to a process that
            // died (a claim is in-memory), so the loop's boot pass asks for
            // them and decides what they mean.
            selectRunningJobs: db.prepare(
                `${JOB_COLUMNS} WHERE state = 'running' ORDER BY run_at ASC, rowid ASC LIMIT ?`,
            ),
            // A deferral is not a claim: the job keeps its attempt count and
            // its pending state, and only its moment moves.
            rescheduleJob: db.prepare(
                "UPDATE jobs SET run_at = ? WHERE id = ? AND state = 'pending'",
            ),
            // The claim *is* the transition: `state = 'pending'` in the WHERE
            // clause means a second claim — another tick, or a process that
            // restarted mid-run — touches no row and cannot double-fire a job.
            claimJob: db.prepare(
                "UPDATE jobs SET state = 'running', attempts = attempts + 1 WHERE id = ? AND state = 'pending'",
            ),
            // Terminal states are terminal, so a late duplicate settle cannot
            // rewrite history; the caller re-reads the settled row instead.
            settleJob: db.prepare(
                `UPDATE jobs SET state = ?, last_error = ?, settled_at = ? WHERE id = ? AND state NOT IN ${SETTLED_JOB_STATES}`,
            ),
            // A pending job is cancellable, and only its owner's — plus a
            // *repeating* one that a claim is holding (#90 phase 8b). The firing
            // in flight is already paid for and will report when it ends; what
            // the user is stopping is the series. It cannot come back, because
            // the re-arm below only fires on a row still `running`, and this
            // leaves it `cancelled`. A one-shot mid-run stays uncancellable: its
            // result is the whole job.
            cancelJob: db.prepare(
                "UPDATE jobs SET state = 'cancelled', settled_at = ? WHERE user_id = ? AND id = ? AND (state = 'pending' OR (state = 'running' AND repeat IS NOT NULL))",
            ),
            // Snoozing a reminder that has not fired: the owner's pending row
            // only, in one statement — no attempt counted, nothing announced.
            moveJob: db.prepare(
                "UPDATE jobs SET run_at = ? WHERE user_id = ? AND id = ? AND state = 'pending'",
            ),
            // The REST edit (#90 phase 5): ownership and pending-only state in
            // the WHERE clause, and COALESCE so a field the caller did not
            // mention keeps its value. `message` on a tool job would violate the
            // table's kind CHECK — the caller refuses that before it gets here,
            // and the CHECK is the backstop.
            editJob: db.prepare(
                `UPDATE jobs SET label = COALESCE(?, label), message = COALESCE(?, message), run_at = COALESCE(?, run_at),
                    repeat = CASE WHEN ? THEN ? ELSE repeat END
                 WHERE user_id = ? AND id = ? AND state = 'pending'`,
            ),
            insertJobRun: db.prepare(
                "INSERT INTO job_runs (id, job_id, started_at, state) VALUES (?, ?, ?, 'running')",
            ),
            finishJobRun: db.prepare(
                "UPDATE job_runs SET state = ?, output = ?, error = ?, gate_output = ?, gate_key = ?, finished_at = ? WHERE id = ?",
            ),
            // A series' next occurrence (#90 phase 8b): the firing is over and
            // the job is owed again, so `settled_at` is cleared — the row is not
            // history. Guarded on `running`: a job the user cancelled mid-run is
            // `cancelled` by the time this runs, so a re-arm cannot resurrect it.
            rearmJob: db.prepare(
                "UPDATE jobs SET state = 'pending', run_at = ?, settled_at = NULL, last_error = ? WHERE id = ? AND state = 'running'",
            ),
            failOpenJobRuns: db.prepare(
                "UPDATE job_runs SET state = 'failed', error = ?, finished_at = ? WHERE job_id = ? AND state = 'running'",
            ),
            selectJobRuns: db.prepare(
                `${JOB_RUN_COLUMNS} WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            ),
            // Retention, in one statement: the newest `keep` rows survive and
            // the rest are history. The `rowid` tiebreak matches the read
            // ordering, so "the newest keep" means the same rows the pages list
            // when two jobs share a timestamp.
            //
            // The exemption is the whole reason this stopped being two passes:
            // `created_at` is when the user asked, and a *repeating* row's never
            // moves, so age alone would eventually make a series that is still
            // owed the next row the prune took. Creation caps a user's pending
            // rows below this ceiling (`JARVIS_JOB_MAX_PER_USER`), so the rows
            // taken here are overwhelmingly settled ones — which is what the old
            // two-pass comment claimed and could not deliver, because its first
            // pass deleted *unsettled* rows (`state NOT IN` the settled set) and
            // was therefore a strict subset of its second.
            pruneJobs: db.prepare(
                `DELETE FROM jobs WHERE user_id = ? AND id NOT IN (SELECT id FROM jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) AND (repeat IS NULL OR state IN ${SETTLED_JOB_STATES})`,
            ),
            // Runs are history too, and a gated job firing every five minutes
            // writes 288 of them a day: the newest survive.
            countModelRuns: db.prepare(
                "SELECT runs FROM job_model_runs WHERE user_id = ? AND day = ?",
            ),
            recordModelRun: db.prepare(
                "INSERT INTO job_model_runs (user_id, day, runs) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET runs = runs + 1",
            ),
            pruneJobRuns: db.prepare(
                `DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`,
            ),
            insertCodingJob: db.prepare(
                "INSERT INTO coding_jobs (id, user_id, repo, branch, prompt, state, crash_policy, workspace_path, model, pr_url, issue_number, last_seen_comment_id, created_at, session_id) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
            selectCodingJob: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE user_id = ? AND id = ?`,
            ),
            selectCodingJobById: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE id = ?`,
            ),
            selectCodingJobs: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE user_id = ? AND state NOT IN ${SETTLED_CODING_JOB_STATES} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            selectCodingJobsWithSettled: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            // The recovery feed: a claim is in-memory, so any `running` row at
            // boot belongs to a process that died. The sandbox service decides
            // what that means, per the row's own crash policy.
            selectRunningCodingJobs: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE state = 'running' ORDER BY started_at ASC, rowid ASC LIMIT ?`,
            ),
            // The poller's feed (#94): jobs waiting for an answer, oldest
            // first so a long queue cannot starve the first one.
            selectAwaitingCodingJobs: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE state = 'awaiting-answer' ORDER BY created_at ASC, rowid ASC LIMIT ?`,
            ),
            // The in-session ask relay (#94): the parked jobs that belong to
            // this conversation, so a turn can carry their questions.
            selectAwaitingCodingJobsBySession: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE user_id = ? AND session_id = ? AND state = 'awaiting-answer' ORDER BY created_at ASC, rowid ASC LIMIT ?`,
            ),
            // The PR-feedback feed (#94): newest first, so the first row for a
            // URL is the latest attempt and its watermark is authoritative.
            selectCodingJobsWithPr: db.prepare(
                `${CODING_JOB_COLUMNS} WHERE pr_url IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            // The question was posted: settle the non-terminal waiting state.
            // `running` in the WHERE clause makes a duplicate a no-op.
            awaitCodingJob: db.prepare(
                "UPDATE coding_jobs SET state = 'awaiting-answer', plan = ?, question_comment_id = ?, last_seen_comment_id = COALESCE(?, last_seen_comment_id), last_error = NULL WHERE id = ? AND state = 'running'",
            ),
            // The reopen *is* the claim for an answer: only one poller can move
            // the row out of `awaiting-answer`, and the next claim starts the
            // container. Clear the previous attempt's fields.
            reopenCodingJob: db.prepare(
                "UPDATE coding_jobs SET state = 'queued', container_id = NULL, started_at = NULL, finished_at = NULL, last_error = NULL, last_seen_comment_id = COALESCE(?, last_seen_comment_id), questions_json = NULL WHERE id = ? AND state = 'awaiting-answer'",
            ),
            // The questions are stored when the job parks (#94): the workspace
            // is the only other copy and the relay must not read files on a
            // turn. Reopening clears them, so a stale set cannot be relayed.
            setCodingJobQuestions: db.prepare(
                "UPDATE coding_jobs SET questions_json = ? WHERE id = ?",
            ),
            // The claim *is* the transition, as for a scheduled job: `queued`
            // in the WHERE clause makes a second claimant touch no row. The
            // container id lands here, at the start, because `resume` needs it
            // precisely when the process that wrote it is gone.
            claimCodingJob: db.prepare(
                "UPDATE coding_jobs SET state = 'running', container_id = ?, started_at = ?, attempts = attempts + 1 WHERE id = ? AND state = 'queued'",
            ),
            // One statement covers every ending: the terminal guard lives in
            // the WHERE clause, so a late duplicate settles nothing and the
            // caller re-reads the row it already had. A `queued` row may only
            // be settled `failed` — the one ending a job can reach before a
            // container exists (a clone or a start that threw).
            settleCodingJob: db.prepare(
                "UPDATE coding_jobs SET state = ?, diff_summary = COALESCE(?, diff_summary), pr_url = COALESCE(?, pr_url), log_tail = COALESCE(?, log_tail), last_error = ?, finished_at = ? WHERE id = ? AND (state = 'running' OR (state = 'queued' AND ? = 'failed'))",
            ),
            cancelCodingJob: db.prepare(
                "UPDATE coding_jobs SET state = 'cancelled', finished_at = ? WHERE user_id = ? AND id = ? AND state IN ('queued', 'awaiting-answer')",
            ),
            setCodingJobLogTail: db.prepare(
                "UPDATE coding_jobs SET log_tail = ? WHERE id = ?",
            ),
            // The window is over *settled* rows, not all rows: a job in flight
            // is not history, and counting it against the history budget would
            // let one long run evict more history than the caller asked to keep.
            pruneCodingJobs: db.prepare(
                `DELETE FROM coding_jobs WHERE user_id = ? AND state IN ${SETTLED_CODING_JOB_STATES} AND id NOT IN (SELECT id FROM coding_jobs WHERE user_id = ? AND state IN ${SETTLED_CODING_JOB_STATES} ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
            ),
        };
    }

    createUser(username: string, passwordHash: string, role: Role): AppUser {
        try {
            this.statements.insertUser.run(username, passwordHash, role, now());
        } catch (err: unknown) {
            if (isUniqueViolation(err)) {
                // The username column (UNIQUE COLLATE NOCASE) is the only
                // remaining uniqueness constraint on users since v5 dropped
                // the single-owner index — so a unique violation is a
                // duplicate username, not a duplicate owner.
                throw new AuthError(
                    "USERNAME_TAKEN",
                    `the username '${username}' is already taken`,
                );
            }
            throw err;
        }
        const row = this.statements.selectUserByUsername.get(
            username,
        ) as UserRow;
        return mapUser(row);
    }

    getUserByUsername(username: string): AppUser | null {
        const row = this.statements.selectUserByUsername.get(username) as
            UserRow | undefined;
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
            UserRow | undefined;
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
            DeviceRow | undefined;
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
        // (user_id, name) is UNIQUE, so the lookup is a `.get()` — exactly
        // the row this upsert wrote or updated.
        const row = this.statements.selectDeviceByUserAndName.get(
            userId,
            name,
        ) as DeviceRow | undefined;
        if (!row) {
            throw new AuthError(
                "NOT_FOUND",
                "device row vanished after provisioning",
            );
        }
        return mapDevice(row);
    }

    listDevicesByUser(userId: number): AppDevice[] {
        const rows = this.statements.listDevicesByUser.all(
            userId,
        ) as DeviceRow[];
        return rows.map(mapDevice);
    }

    listUsers(): AppUser[] {
        const rows = this.statements.listUsers.all() as UserRow[];
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
            if (isUniqueViolation(err)) {
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
        // Check-then-act runs in one transaction (issue #107 P5): a demote
        // racing another owner's demotion can no longer both pass the
        // enabled-owner guard and strip the last owner.
        const tx = this.db.transaction((targetId: number, nextRole: Role) => {
            const target = this.getUserById(targetId);
            if (!target) {
                throw new AuthError("NOT_FOUND", "user not found");
            }
            // Demoting an owner must leave at least one other *enabled*
            // owner — a disabled owner can't administer the server, so it
            // can't be the remaining one. This keeps a zero-owner lockout
            // unreachable.
            if (target.role === "owner" && nextRole !== "owner") {
                const row = this.statements.selectOtherEnabledOwners.get(
                    targetId,
                ) as { n: number };
                if (row.n === 0) {
                    throw new AuthError(
                        "LAST_OWNER",
                        "cannot demote the last enabled owner; promote another owner first",
                    );
                }
            }
            this.statements.updateUserRole.run(nextRole, targetId);
        });
        tx(id, role);
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

    deleteExpiredWebSessions(): number {
        const result = this.statements.deleteExpiredWebSessions.run(now());
        return result.changes;
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
            DeviceIdentityRow | undefined;
        if (!row) {
            return null;
        }
        // The user and device halves build through the same mappers as every
        // other read path — the disabled→boolean coercion lives once (#107 P5).
        return {
            user: mapUser({
                id: row.u_id,
                username: row.u_username,
                role: row.u_role,
                disabled: row.u_disabled,
                createdAt: row.u_created_at,
            }),
            device: mapDevice(row),
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
        // One stamp for both timestamps (issue #107 P5): the row's created_at
        // and last_active_at mean the same instant on a fresh claim, and two
        // separate now() calls could straddle a clock boundary.
        const stamp = now();
        const result = this.statements.insertSession.run(
            threadId,
            opts.userId,
            opts.deviceId,
            opts.kind,
            stamp,
            stamp,
        );
        const session = this.getSessionByThread(threadId)!;
        return { session, created: result.changes > 0 };
    }

    getSessionByThread(threadId: string): AppSession | null {
        const row = this.statements.selectSessionByThread.get(threadId) as
            SessionRow | undefined;
        return row ? mapSession(row) : null;
    }

    touchSession(threadId: string): void {
        this.statements.updateSessionLastActive.run(now(), threadId);
    }

    deleteSession(threadId: string): void {
        this.statements.deleteSession.run(threadId);
    }

    listOwnedSessions(userId: number): AppSession[] {
        const rows = this.statements.listSessionsByUser.all(
            userId,
        ) as SessionRow[];
        return rows.map(mapSession);
    }

    listAllSessions(): AppSession[] {
        const rows = this.statements.listAllSessions.all() as SessionRow[];
        return rows.map(mapSession);
    }

    createNotification(
        userId: number,
        input: CreateNotificationInput & { id: string; createdAt: string },
    ): AppNotification {
        this.statements.insertNotification.run(
            input.id,
            userId,
            input.kind,
            // The write path is explicit rather than leaning on the column's
            // default: that default exists to make the v9 migration total (an
            // existing row becomes the quiet class), and a store whose write
            // behaviour depended on DDL would be a second place to look.
            input.class ?? "notification",
            input.priority,
            input.title,
            input.body ?? null,
            input.requiresAnswer === true ? 1 : 0,
            input.dedupeKey ?? null,
            input.jobId ?? null,
            input.codingJobId ?? null,
            input.createdAt,
        );
        // The row was just written, so a re-read cannot miss; the assertion
        // documents that rather than papering over a null with a fake row.
        const created = this.getNotification(userId, input.id);
        if (created === null) {
            throw new Error("notification insert vanished");
        }
        return created;
    }

    getNotification(userId: number, id: string): AppNotification | null {
        const row = this.statements.selectNotification.get(userId, id) as
            NotificationRow | undefined;
        return row ? mapNotification(row) : null;
    }

    settleCodingQuestionNotifications(
        userId: number,
        codingJobId: string,
        exceptId: string | null,
        at: string,
    ): number {
        return this.statements.settleCodingQuestionNotifications.run(
            at,
            userId,
            codingJobId,
            exceptId,
            exceptId,
        ).changes;
    }

    listNotifications(
        userId: number,
        options: { limit?: number } = {},
    ): AppNotification[] {
        const limit = Math.max(1, options.limit ?? DEFAULT_NOTIFICATION_PAGE);
        const rows = this.statements.selectNotifications.all(
            userId,
            limit,
        ) as NotificationRow[];
        return rows.map(mapNotification);
    }

    /**
     * Removes a notification (#90 phase 9c).
     *
     * Read first, because the caller wants the row it removed: a `DELETE` that
     * reports only `changes` cannot tell a route what it took away, and the
     * scoped read also keeps a foreign id indistinguishable from a missing one.
     */
    deleteNotification(userId: number, id: string): AppNotification | null {
        const existing = this.getNotification(userId, id);
        if (existing === null) {
            return null;
        }
        this.statements.deleteNotification.run(userId, id);
        return existing;
    }

    listNotificationsForJob(userId: number, jobId: string): AppNotification[] {
        const rows = this.statements.selectNotificationsForJob.all(
            userId,
            jobId,
        ) as NotificationRow[];
        return rows.map(mapNotification);
    }

    countUnreadNotifications(userId: number): number {
        const row = this.statements.countUnreadNotifications.get(userId) as {
            n: number;
        };
        return row.n;
    }

    setNotificationState(
        userId: number,
        id: string,
        state: NotificationState,
        options: { answer?: string } = {},
    ): AppNotification | null {
        const stamp = now();
        this.statements.settleNotification.run(
            state,
            options.answer ?? null,
            state,
            stamp,
            state,
            stamp,
            userId,
            id,
        );
        return this.getNotification(userId, id);
    }

    pruneNotifications(userId: number, keep: number): number {
        const limit = Math.max(0, keep);
        const settled = this.statements.pruneSettledNotifications.run(
            userId,
            userId,
            limit,
        );
        const excess = this.statements.pruneNotifications.run(
            userId,
            userId,
            limit,
        );
        return settled.changes + excess.changes;
    }

    createJob(
        userId: number,
        input: CreateJobInput & { id: string; createdAt: string },
    ): AppJob {
        this.statements.insertJob.run(
            input.id,
            userId,
            input.label,
            // Explicit rather than leaning on the column default, as for a
            // notification: the default exists so the v10 rebuild can widen an
            // existing table, not so the write path has a second home.
            input.class ?? "notification",
            input.kind,
            input.prompt ?? null,
            input.toolName ?? null,
            input.toolArgs === undefined || input.toolArgs === null
                ? null
                : JSON.stringify(input.toolArgs),
            input.message ?? null,
            input.runAt,
            input.createdAt,
            input.repeat === undefined || input.repeat === null
                ? null
                : JSON.stringify(input.repeat),
            input.gate === undefined || input.gate === null
                ? null
                : JSON.stringify(input.gate),
        );
        // Just written, so a re-read cannot miss; the assertion documents that
        // rather than papering over a null with a fake row.
        const created = this.getJob(userId, input.id);
        if (created === null) {
            throw new Error("job insert vanished");
        }
        return created;
    }

    getJob(userId: number, id: string): AppJob | null {
        const row = this.statements.selectJob.get(userId, id) as
            JobRow | undefined;
        return row ? mapJob(row) : null;
    }

    listJobs(
        userId: number,
        options: { limit?: number; includeSettled?: boolean } = {},
    ): AppJob[] {
        const limit = Math.max(1, options.limit ?? DEFAULT_JOB_PAGE);
        const statement = options.includeSettled
            ? this.statements.selectJobsWithSettled
            : this.statements.selectJobs;
        const rows = statement.all(userId, limit) as JobRow[];
        return rows.map(mapJob);
    }

    listDueJobs(at: string, limit: number): AppJob[] {
        const rows = this.statements.selectDueJobs.all(
            at,
            Math.max(1, limit),
        ) as JobRow[];
        return rows.map(mapJob);
    }

    listRunningJobs(limit: number): AppJob[] {
        const rows = this.statements.selectRunningJobs.all(
            Math.max(1, limit),
        ) as JobRow[];
        return rows.map(mapJob);
    }

    failOpenJobRuns(jobId: string, error: string, at: string): number {
        return this.statements.failOpenJobRuns.run(error, at, jobId).changes;
    }

    claimJob(id: string): boolean {
        return this.statements.claimJob.run(id).changes === 1;
    }

    rescheduleJob(id: string, runAt: string): AppJob | null {
        this.statements.rescheduleJob.run(runAt, id);
        return this.jobById(id);
    }

    startJobRun(input: { id: string; jobId: string; startedAt: string }): void {
        this.statements.insertJobRun.run(
            input.id,
            input.jobId,
            input.startedAt,
        );
    }

    finishJobRun(
        runId: string,
        state: Exclude<JobRunState, "running">,
        result: {
            output?: string;
            error?: string;
            gateOutput?: string;
            gateKey?: string;
        },
        at: string,
    ): void {
        this.statements.finishJobRun.run(
            state,
            result.output ?? null,
            result.error ?? null,
            result.gateOutput ?? null,
            result.gateKey ?? null,
            at,
            runId,
        );
    }

    settleJob(
        id: string,
        state: Exclude<JobState, "pending" | "running">,
        options: { error?: string },
        at: string,
    ): AppJob | null {
        this.statements.settleJob.run(state, options.error ?? null, at, id);
        return this.jobById(id);
    }

    cancelJob(userId: number, id: string): AppJob | null {
        this.statements.cancelJob.run(now(), userId, id);
        return this.getJob(userId, id);
    }

    moveJob(userId: number, id: string, runAt: string): AppJob | null {
        this.statements.moveJob.run(runAt, userId, id);
        return this.getJob(userId, id);
    }

    editJob(
        userId: number,
        id: string,
        patch: {
            label?: string;
            message?: string;
            runAt?: string;
            repeat?: unknown | null;
        },
    ): AppJob | null {
        this.statements.editJob.run(
            patch.label ?? null,
            patch.message ?? null,
            patch.runAt ?? null,
            patch.repeat === undefined ? 0 : 1,
            patch.repeat === null ? null : JSON.stringify(patch.repeat),
            userId,
            id,
        );
        return this.getJob(userId, id);
    }

    listJobRuns(jobId: string, options: { limit?: number } = {}): AppJobRun[] {
        const rows = this.statements.selectJobRuns.all(
            jobId,
            Math.max(1, options.limit ?? DEFAULT_JOB_RUN_PAGE),
        ) as JobRunRow[];
        return rows.map(mapJobRun);
    }

    pruneJobs(userId: number, keep: number): number {
        return this.statements.pruneJobs.run(userId, userId, Math.max(0, keep))
            .changes;
    }

    pruneJobRuns(jobId: string, keep: number = DEFAULT_JOB_RUN_KEEP): number {
        return this.statements.pruneJobRuns.run(jobId, jobId, Math.max(0, keep))
            .changes;
    }

    createCodingJob(
        userId: number,
        input: CreateCodingJobInput & { id: string; createdAt: string },
    ): AppCodingJob {
        this.statements.insertCodingJob.run(
            input.id,
            userId,
            input.repo,
            input.branch,
            input.prompt,
            // Explicit rather than leaning on the column default, as for a job's
            // class: the default exists so the column has one home, not so the
            // write path has a second.
            input.crashPolicy ?? "prune",
            input.workspacePath,
            input.model ?? null,
            input.prUrl ?? null,
            input.issueNumber ?? null,
            input.lastSeenCommentId ?? null,
            input.createdAt,
            input.sessionId ?? null,
        );
        // Just written, so a re-read cannot miss; the assertion documents that
        // rather than papering over a null with a fake row.
        const created = this.getCodingJob(userId, input.id);
        if (created === null) {
            throw new Error("coding job insert vanished");
        }
        return created;
    }

    getCodingJob(userId: number, id: string): AppCodingJob | null {
        const row = this.statements.selectCodingJob.get(userId, id) as
            CodingJobRow | undefined;
        return row ? mapCodingJob(row) : null;
    }

    getCodingJobById(id: string): AppCodingJob | null {
        const row = this.statements.selectCodingJobById.get(id) as
            CodingJobRow | undefined;
        return row ? mapCodingJob(row) : null;
    }

    listCodingJobs(
        userId: number,
        options: { limit?: number; includeSettled?: boolean } = {},
    ): AppCodingJob[] {
        const limit = Math.max(1, options.limit ?? DEFAULT_CODING_JOB_PAGE);
        const statement = options.includeSettled
            ? this.statements.selectCodingJobsWithSettled
            : this.statements.selectCodingJobs;
        const rows = statement.all(userId, limit) as CodingJobRow[];
        return rows.map(mapCodingJob);
    }

    listRunningCodingJobs(limit: number): AppCodingJob[] {
        const rows = this.statements.selectRunningCodingJobs.all(
            Math.max(1, limit),
        ) as CodingJobRow[];
        return rows.map(mapCodingJob);
    }

    listAwaitingCodingJobs(limit: number): AppCodingJob[] {
        const rows = this.statements.selectAwaitingCodingJobs.all(
            Math.max(1, limit),
        ) as CodingJobRow[];
        return rows.map(mapCodingJob);
    }

    listAwaitingCodingJobsBySession(
        userId: number,
        sessionId: string,
        limit: number,
    ): AppCodingJob[] {
        const rows = this.statements.selectAwaitingCodingJobsBySession.all(
            userId,
            sessionId,
            Math.max(1, limit),
        ) as CodingJobRow[];
        return rows.map(mapCodingJob);
    }

    setCodingJobQuestions(id: string, questions: readonly string[]): void {
        this.statements.setCodingJobQuestions.run(
            questions.length > 0 ? JSON.stringify(questions) : null,
            id,
        );
    }

    listCodingJobsWithPr(limit: number): AppCodingJob[] {
        const rows = this.statements.selectCodingJobsWithPr.all(
            Math.max(1, limit),
        ) as CodingJobRow[];
        return rows.map(mapCodingJob);
    }

    awaitCodingJob(
        id: string,
        input: {
            plan: string;
            questionCommentId?: number | null;
            lastSeenCommentId?: number | null;
        },
    ): AppCodingJob | null {
        this.statements.awaitCodingJob.run(
            input.plan,
            input.questionCommentId ?? null,
            input.lastSeenCommentId ?? null,
            id,
        );
        return this.getCodingJobById(id);
    }

    reopenCodingJob(
        id: string,
        lastSeenCommentId?: number | null,
    ): AppCodingJob | null {
        this.statements.reopenCodingJob.run(lastSeenCommentId ?? null, id);
        return this.getCodingJobById(id);
    }

    claimCodingJob(
        id: string,
        containerId: string,
        at: string,
    ): AppCodingJob | null {
        const claimed = this.statements.claimCodingJob.run(containerId, at, id);
        return claimed.changes === 0 ? null : this.getCodingJobById(id);
    }

    cancelCodingJob(
        userId: number,
        id: string,
        at: string,
    ): AppCodingJob | null {
        this.statements.cancelCodingJob.run(at, userId, id);
        return this.getCodingJob(userId, id);
    }

    setCodingJobLogTail(id: string, tail: string): void {
        this.statements.setCodingJobLogTail.run(tail, id);
    }

    settleCodingJob(
        id: string,
        state: Exclude<
            CodingJobState,
            "queued" | "running" | "awaiting-answer"
        >,
        result: SettleCodingJobInput,
        at: string,
    ): AppCodingJob | null {
        this.statements.settleCodingJob.run(
            state,
            result.diffSummary ?? null,
            result.prUrl ?? null,
            result.logTail ?? null,
            result.error ?? null,
            at,
            id,
            state,
        );
        // Re-read rather than assume: the terminal guard may have refused (an
        // already-settled row, or one never claimed), and the caller needs the
        // row as it actually is.
        return this.getCodingJobById(id);
    }

    pruneCodingJobs(userId: number, keep: number): number {
        return this.statements.pruneCodingJobs.run(
            userId,
            userId,
            Math.max(0, keep),
        ).changes;
    }

    settleJobRun(input: SettleFiringInput): AppJob | null {
        this.settleFiring(input);
        return this.jobById(input.jobId);
    }

    rearmJob(id: string, runAt: string, error?: string): AppJob | null {
        this.statements.rearmJob.run(runAt, error ?? null, id);
        return this.jobById(id);
    }

    countModelRuns(userId: number, day: string): number {
        const row = this.statements.countModelRuns.get(userId, day) as
            { runs: number } | undefined;
        return row?.runs ?? 0;
    }

    recordModelRun(userId: number, day: string): void {
        this.statements.recordModelRun.run(userId, day);
    }

    /**
     * A job by id, with no owner filter — the scheduler's read, for the row it
     * has just settled. Deliberately not on {@link JobLedger}: a request
     * handler must never reach a job by id alone.
     */
    private jobById(id: string): AppJob | null {
        const row = this.statements.selectJobById.get(id) as JobRow | undefined;
        return row ? mapJob(row) : null;
    }

    close(): void {
        this.db.close();
    }
}
