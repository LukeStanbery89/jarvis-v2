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
    CHECK (
        (kind = 'prompt' AND prompt IS NOT NULL AND tool_name IS NULL AND message IS NULL) OR
        (kind = 'tool' AND tool_name IS NOT NULL AND prompt IS NULL AND message IS NULL) OR
        (kind = 'message' AND message IS NOT NULL AND prompt IS NULL AND tool_name IS NULL)
    )
)`;
}

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

const JOBS_SCHEMA = `${jobsTable("jobs")};
${JOB_INDEXES}
CREATE TABLE IF NOT EXISTS job_runs (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    state       TEXT NOT NULL CHECK (state IN ('running', 'ok', 'failed')),
    output      TEXT,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job
    ON job_runs (job_id, started_at DESC);`;

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
CREATE TABLE IF NOT EXISTS notifications (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    class           TEXT NOT NULL DEFAULT 'notification' CHECK (class IN ('notification', 'reminder', 'timer')),
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
    ON notifications (user_id, created_at DESC);
${JOBS_SCHEMA}
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
 * Where a notification is in its life (#139).
 *
 * `pending` — recorded but never pushed to a live client (nobody was
 * connected, the delivery cap was reached, or quiet hours suppressed it), so a
 * client that connects later finds it through the list. `delivered` — pushed
 * to at least one live socket. `read` / `dismissed` / `answered` are terminal
 * from the user's point of view. `answered` is the retirement path for a
 * `requiresAnswer` notification: a reply, not an acknowledgement, is what
 * settles it.
 *
 * Note that `pending` → `read` is a legal transition: a user who finds the
 * notification in the list and reads it there never needs it delivered.
 */
export const NOTIFICATION_STATES = [
    "pending",
    "delivered",
    "read",
    "answered",
    "dismissed",
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
     * A user's notifications, newest first. Dismissed rows are excluded by
     * default; `limit` caps the page.
     */
    listNotifications(
        userId: number,
        options?: { limit?: number; includeDismissed?: boolean },
    ): AppNotification[];
    /** How many of a user's notifications are neither read nor dismissed. */
    countUnreadNotifications(userId: number): number;
    /**
     * Moves a notification to `state`, stamping `delivered_at` / `settled_at`
     * as that state implies, optionally recording the user's `answer`.
     *
     * Terminal states are terminal: a transition out of `read`, `dismissed`,
     * or `answered` is refused and the existing row returned unchanged, so a
     * late duplicate ack cannot resurrect a settled notification.
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
export const JOB_RUN_STATES = ["running", "ok", "failed"] as const;

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
    runAt: string;
}

/**
 * Job-rows ledger: the scheduler's queue and history (#90).
 *
 * Unlike {@link NotificationLedger} — whose every method scopes by `userId`,
 * because a notification is only ever read for its owner — this ledger has two
 * deliberate surfaces:
 *
 * - **User-scoped** ({@link getJob} / {@link listJobs} / {@link cancelJob} /
 *   {@link listJobRuns}): what the REST layer and the pages use. A foreign id
 *   is indistinguishable from a missing one, as everywhere else.
 * - **Scheduler-scoped** ({@link listDueJobs} / {@link claimJob} /
 *   {@link settleJob} / {@link startJobRun} / {@link finishJobRun}): the
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
    /** Finishes one attempt, recording what it produced or why it failed. */
    finishJobRun(
        runId: string,
        state: Exclude<JobRunState, "running">,
        result: { output?: string; error?: string },
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
     * Cancels one of the caller's own jobs (the only user-reachable state
     * change). Only a `pending` job is cancellable: one already running is
     * being worked on, and its result is on its way.
     *
     * @returns The row after the attempt — unchanged when it was not
     * cancellable — or `null` when no such job belongs to `userId`.
     */
    cancelJob(userId: number, id: string): AppJob | null;
    /**
     * A job's runs, newest first, for the pages and for tests.
     */
    listJobRuns(jobId: string, options?: { limit?: number }): AppJobRun[];
    /**
     * Trims a user's jobs to the newest `keep`, so a long-lived instance cannot
     * grow the table without bound. Settled rows are evicted first — a
     * `pending` job is work still owed, so it is the last thing a prune takes,
     * though (as with notifications) it is not exempt: a store nobody's jobs
     * ever settle in would otherwise grow forever.
     *
     * @returns The number of rows deleted.
     */
    pruneJobs(userId: number, keep: number): number;
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
    JobLedger & {
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
    createdAt: string;
    deliveredAt: string | null;
    settledAt: string | null;
}

/**
 * The notification SELECT list, shared by every read so a new column cannot
 * reach one query and miss another (`mapNotification` is the other half).
 */
const NOTIFICATION_COLUMNS = `SELECT id, user_id AS userId, kind, class, priority, title, body, state, requires_answer AS requiresAnswer, dedupe_key AS dedupeKey, answer, created_at AS createdAt, delivered_at AS deliveredAt, settled_at AS settledAt FROM notifications`;

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
}

/** The job SELECT list, shared by every read (`mapJob` is the other half). */
const JOB_COLUMNS = `SELECT id, user_id AS userId, label, class, kind, prompt, tool_name AS toolName, tool_args AS toolArgs, message, run_at AS runAt, state, attempts, created_at AS createdAt, settled_at AS settledAt, last_error AS lastError FROM jobs`;

/** The run SELECT list (`mapJobRun` is the other half). */
const JOB_RUN_COLUMNS = `SELECT id, job_id AS jobId, started_at AS startedAt, finished_at AS finishedAt, state, output, error FROM job_runs`;

/** The states a job never returns from — settled, in the ledger's terms. */
const SETTLED_JOB_STATES = `('done', 'failed', 'cancelled', 'missed')`;

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
 */
function parseToolArgs(value: string | null): unknown {
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
        toolArgs: parseToolArgs(row.toolArgs),
        message: row.message,
        runAt: row.runAt,
        state: row.state,
        attempts: row.attempts,
        createdAt: row.createdAt,
        settledAt: row.settledAt,
        lastError: row.lastError,
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
 * How many runs of one job a history call returns.
 *
 * A job is a repeating thing by nature (recurrence is phase 8), so the run
 * history is the one list here that genuinely grows per job.
 */
const DEFAULT_JOB_RUN_PAGE = 20;

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

function migrate(db: Database.Database): void {
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
                // The documented last step: prove the swap left no dangling
                // reference before declaring the store upgraded. A rebuild that
                // silently orphaned runs would be worse than a loud failure.
                const violations = db.pragma("foreign_key_check") as unknown[];
                if (violations.length > 0) {
                    throw new Error(
                        `the jobs rebuild left ${violations.length} foreign-key violation(s)`,
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
        selectNotificationsWithDismissed: Database.Statement;
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
        settleJob: Database.Statement;
        cancelJob: Database.Statement;
        insertJobRun: Database.Statement;
        finishJobRun: Database.Statement;
        failOpenJobRuns: Database.Statement;
        selectJobRuns: Database.Statement;
        pruneSettledJobs: Database.Statement;
        pruneJobs: Database.Statement;
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
                "INSERT INTO notifications (id, user_id, kind, class, priority, title, body, state, requires_answer, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
            ),
            selectNotification: db.prepare(
                `${NOTIFICATION_COLUMNS} WHERE user_id = ? AND id = ?`,
            ),
            selectNotifications: db.prepare(
                `${NOTIFICATION_COLUMNS} WHERE user_id = ? AND state != 'dismissed' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            selectNotificationsWithDismissed: db.prepare(
                `${NOTIFICATION_COLUMNS} WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            ),
            countUnreadNotifications: db.prepare(
                "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND state NOT IN ('read', 'answered', 'dismissed')",
            ),
            // One statement covers every transition: the terminal guard lives
            // in the WHERE clause, so a late duplicate ack touches no row and
            // the caller re-reads the settled one instead. `delivered_at` and
            // `settled_at` are stamped only by the states that imply them.
            settleNotification: db.prepare(
                "UPDATE notifications SET state = ?, answer = COALESCE(?, answer), delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, settled_at = CASE WHEN ? IN ('read', 'answered', 'dismissed') THEN ? ELSE settled_at END WHERE user_id = ? AND id = ? AND state NOT IN ('read', 'answered', 'dismissed')",
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
                "INSERT INTO jobs (id, user_id, label, class, kind, prompt, tool_name, tool_args, message, run_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
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
            // Only a pending job is cancellable, and only its owner's.
            cancelJob: db.prepare(
                "UPDATE jobs SET state = 'cancelled', settled_at = ? WHERE user_id = ? AND id = ? AND state = 'pending'",
            ),
            insertJobRun: db.prepare(
                "INSERT INTO job_runs (id, job_id, started_at, state) VALUES (?, ?, ?, 'running')",
            ),
            finishJobRun: db.prepare(
                "UPDATE job_runs SET state = ?, output = ?, error = ?, finished_at = ? WHERE id = ?",
            ),
            failOpenJobRuns: db.prepare(
                "UPDATE job_runs SET state = 'failed', error = ?, finished_at = ? WHERE job_id = ? AND state = 'running'",
            ),
            selectJobRuns: db.prepare(
                `${JOB_RUN_COLUMNS} WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            ),
            // Two passes for the same reason notifications prune in two: the
            // ceiling has to hold for the table, and only when settled rows
            // cannot absorb the cut is a `pending` job — work still owed —
            // taken with them.
            pruneSettledJobs: db.prepare(
                `DELETE FROM jobs WHERE user_id = ? AND state NOT IN ${SETTLED_JOB_STATES} AND id NOT IN (SELECT id FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
            ),
            pruneJobs: db.prepare(
                "DELETE FROM jobs WHERE user_id = ? AND id NOT IN (SELECT id FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)",
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

    listNotifications(
        userId: number,
        options: { limit?: number; includeDismissed?: boolean } = {},
    ): AppNotification[] {
        const limit = Math.max(1, options.limit ?? DEFAULT_NOTIFICATION_PAGE);
        const statement = options.includeDismissed
            ? this.statements.selectNotificationsWithDismissed
            : this.statements.selectNotifications;
        const rows = statement.all(userId, limit) as NotificationRow[];
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
        result: { output?: string; error?: string },
        at: string,
    ): void {
        this.statements.finishJobRun.run(
            state,
            result.output ?? null,
            result.error ?? null,
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

    listJobRuns(jobId: string, options: { limit?: number } = {}): AppJobRun[] {
        const rows = this.statements.selectJobRuns.all(
            jobId,
            Math.max(1, options.limit ?? DEFAULT_JOB_RUN_PAGE),
        ) as JobRunRow[];
        return rows.map(mapJobRun);
    }

    pruneJobs(userId: number, keep: number): number {
        const limit = Math.max(0, keep);
        const settled = this.statements.pruneSettledJobs.run(
            userId,
            userId,
            limit,
        );
        const excess = this.statements.pruneJobs.run(userId, userId, limit);
        return settled.changes + excess.changes;
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
