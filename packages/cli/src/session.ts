/**
 * Per-identity conversation session ids for the CLI.
 *
 * The CLI keeps one active `sessionId` at a time and sends it with every
 * prompt so the server accumulates a conversation under one LangGraph thread.
 * Because the server uses strict session ownership (a guest socket can never
 * prompt on an account's thread, and vice-versa), the active id must match the
 * CLI's current identity. Rather than throwing the id away whenever identity
 * changes (which fragments the account's conversations into orphaned ledger
 * rows), the store remembers one thread slot per identity:
 *
 *   - `guest` — the id used while not logged in;
 *   - `users["<username>"]` — that account's thread, keyed by the server's
 *     canonical username.
 *
 * `login`/`logout` therefore *switch slots* (resuming the remembered thread)
 * instead of minting a fresh conversation, and a deliberate fresh start is an
 * explicit `new` command (`rotateActiveSession`). The threads themselves live
 * server-side; this file only remembers which id belongs to whom.
 *
 * The file lives at `JARVIS_SESSION_FILE` (default `~/.jarvis/session-id`,
 * see `src/config.ts`). An existing bare-uuid file (the pre-identity format)
 * is transparently adopted as the guest id on first load; writes are atomic
 * and mode `0600`, so the file never exists at looser permissions and a crash
 * mid-write cannot truncate it.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionFilePath } from "./config";
import { ensurePrivateDir } from "./privateFs";
import { logger } from "./logger";

/** The CLI's current identity — the thread slot to read/write. */
export type SessionIdentity =
    { kind: "guest" } | { kind: "user"; username: string };

/** On-disk shape of the per-identity session-id store. */
export interface SessionIds {
    version: 1;
    /** Id used while not logged in (a guest's threads are ephemeral server-side). */
    guest: string;
    /** Id per canonical server username — that account's conversation thread. */
    users: Record<string, string>;
}

/**
 * Max session-id length the server accepts (`MAX_SESSION_ID_LENGTH` in
 * `@lukestanbery/jarvis-protocol`).
 */
const MAX_SESSION_ID_LENGTH = 128;

/** Returns whether `value` is a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns whether `id` is a well-formed session id (non-empty, within bounds). */
function isValidSessionId(id: unknown): id is string {
    return (
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= MAX_SESSION_ID_LENGTH
    );
}

/** Returns whether `value` is a well-formed session-id store. */
function isSessionIdStore(value: unknown): value is SessionIds {
    if (!isRecord(value) || value.version !== 1) {
        return false;
    }
    return (
        isRecord(value.users) &&
        Object.values(value.users).every(isValidSessionId) &&
        isValidSessionId(value.guest)
    );
}

/**
 * Returns a fresh, unique session id (a UUID; well within the server's bound).
 */
export function generateSessionId(): string {
    return randomUUID();
}

/**
 * Persistent session-id store, defaulting to `{ guest: <fresh>, users: {} }`.
 *
 * A missing file is created (and persisted) on first load so the guest thread
 * survives restarts even if `login`/`new` are never used; a legacy file that
 * holds a bare session id (the pre-identity format) is adopted as the guest id
 * and converted to the JSON store in place; a malformed or unreadable file
 * warns and starts fresh rather than crashing the CLI.
 */
export function loadSessionIds(): SessionIds {
    const path = getSessionFilePath();
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        const fresh: SessionIds = {
            version: 1,
            guest: generateSessionId(),
            users: {},
        };
        saveSessionIds(fresh);
        return fresh;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Not JSON: the legacy bare-id file (or a malformed file).
        parsed = raw;
    }
    if (isSessionIdStore(parsed)) {
        return parsed;
    }
    let next: SessionIds;
    if (typeof parsed === "string" && isValidSessionId(parsed.trim())) {
        // Legacy format: one bare line. It belongs to the guest identity —
        // nothing was authenticated when it was written.
        next = { version: 1, guest: parsed.trim(), users: {} };
    } else {
        logger.warn(`Ignoring malformed session-id file: ${path}`);
        next = { version: 1, guest: generateSessionId(), users: {} };
    }
    // Migrate the on-disk format up front so the file always holds the JSON
    // store (a bare legacy id is preserved as the new guest slot).
    saveSessionIds(next);
    return next;
}

/**
 * Serializes `ids` to the session file atomically and with owner-only
 * permissions: a `0600` temp file (pid-suffixed) is renamed over the target,
 * so a crash mid-write leaves the previous store intact and the file never
 * exists at looser permissions. Throws when the file cannot be written; the
 * caller decides whether that is fatal.
 */
export function saveSessionIds(ids: SessionIds): void {
    const path = getSessionFilePath();
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        ensurePrivateDir(dirname(path));
        writeFileSync(tmp, `${JSON.stringify(ids, null, 4)}\n`, {
            mode: 0o600,
        });
        renameSync(tmp, path);
    } catch (err) {
        try {
            unlinkSync(tmp);
        } catch {
            // nothing to clean up (or already removed)
        }
        throw new Error(
            `could not write session-id file ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/**
 * Returns the `sessionId` the CLI should use while running under `identity`.
 *
 * Guest resolves the remembered guest id (never generated here — the guest
 * slot always exists). A username with no remembered thread yet gets a fresh
 * id, which is remembered and persisted so the *next* login (or next CLI
 * start) resumes the same thread. Never rotates an existing id.
 */
export function sessionIdFor(
    ids: SessionIds,
    identity: SessionIdentity,
): string {
    if (identity.kind === "guest") {
        return ids.guest;
    }
    const { username } = identity;
    let existing = ids.users[username];
    if (!isValidSessionId(existing)) {
        existing = generateSessionId();
        ids.users[username] = existing;
        saveSessionIds(ids);
    }
    return existing;
}

/**
 * Replaces `identity`'s thread slot with a fresh session id, persists, and
 * returns it — the CLI's explicit "start a new conversation" operation.
 */
export function rotateActiveSession(
    ids: SessionIds,
    identity: SessionIdentity,
): string {
    const fresh = generateSessionId();
    if (identity.kind === "guest") {
        ids.guest = fresh;
    } else {
        ids.users[identity.username] = fresh;
    }
    saveSessionIds(ids);
    return fresh;
}
