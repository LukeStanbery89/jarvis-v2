/**
 * Local storage for per-server login credentials.
 *
 * The CLI stores the device token issued by a server's `POST /api/auth/login`
 * under `~/.jarvis/credentials.json` (mode `0600`, in a directory narrowed to
 * `0700` when this process creates it) so the CLI can authenticate its
 * WebSocket connections by sending the token as the first frame; the
 * connect-time handshake is owned by `src/client.ts`. Entries are keyed by
 * server origin (see `serverOrigin` in `src/config.ts`) so a dev server and a
 * LAN server don't clobber each other's logins.
 *
 * Writes are atomic (write to a `0600` temp file, then rename) so a crash
 * mid-write can never leave a truncated file, and the token never exists on
 * disk at any looser permission.
 *
 * The stored token is a real credential: it is never logged — diagnostics
 * only ever mention the username and device name. The path can be overridden
 * with `JARVIS_CREDENTIALS_FILE` (tests use this).
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getCredentialsFilePath } from "./config";
import { ensurePrivateDir } from "./privateFs";
import { logger } from "./logger";

/** One server's stored login: the device token plus display metadata. */
export interface StoredCredentials {
    /** The per-device token from `POST /api/auth/login` (sent as the WS auth frame). */
    token: string;
    /** Username that logged in. */
    user: string;
    /** Device name the token was issued to. */
    device: string;
    /** ISO timestamp of when the login was stored. */
    savedAt: string;
}

/** On-disk shape of the credentials file. */
interface CredentialFile {
    version: 1;
    servers: Record<string, StoredCredentials>;
}

/** Returns whether `value` is a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns whether `value` is a well-formed `StoredCredentials` entry. */
function isValidEntry(value: unknown): value is StoredCredentials {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value.token === "string" &&
        value.token.length > 0 &&
        typeof value.user === "string" &&
        typeof value.device === "string" &&
        typeof value.savedAt === "string"
    );
}

/** Returns whether `value` is a well-formed credentials file. */
function isCredentialFile(value: unknown): value is CredentialFile {
    return isRecord(value) && value.version === 1 && isRecord(value.servers);
}

/**
 * Reads and structurally validates the credentials file at `path`.
 *
 * Returns `null` when the file is missing or unreadable, and warns (then
 * returns `null`) when it is malformed — a corrupt file never crashes the
 * CLI, it just means "no credentials".
 */
function readStore(path: string): CredentialFile | null {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        // No file yet (or unreadable) — treat as no credentials.
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (isCredentialFile(parsed)) {
            return parsed;
        }
    } catch {
        // fall through to the malformed-file warning
    }
    logger.warn(`Ignoring malformed credentials file: ${path}`);
    return null;
}

/**
 * Serializes `store` to `path` atomically and with owner-only permissions.
 *
 * The payload is written to a `0600` temp file (pid-suffixed, so concurrent
 * CLI instances don't collide) in the target directory and renamed over the
 * target: a crash mid-write leaves the previous file intact rather than a
 * truncated one, and the secret never touches disk at looser permissions
 * (the rename also tightens a pre-existing loose file). The temp file is
 * removed best-effort on failure. Throws when the file cannot be written.
 */
function writeStore(path: string, store: CredentialFile): void {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        ensurePrivateDir(dirname(path));
        writeFileSync(tmp, `${JSON.stringify(store, null, 4)}\n`, {
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
            `could not write credentials file ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/**
 * Returns the stored credentials for `origin`, or `null` when none are stored
 * (or the stored entry is malformed).
 */
export function loadCredentials(origin: string): StoredCredentials | null {
    const store = readStore(getCredentialsFilePath());
    const entry = store?.servers[origin];
    if (!entry) {
        return null;
    }
    if (!isValidEntry(entry)) {
        logger.warn(`Ignoring malformed credentials entry for ${origin}`);
        return null;
    }
    return entry;
}

/**
 * Stores `credentials` for `origin`, overwriting any previous entry.
 *
 * Throws when the file cannot be written — a silently lost token would leave
 * the user believing they are logged in when they are not. (The caller logs
 * the failure.)
 */
export function saveCredentials(
    origin: string,
    credentials: StoredCredentials,
): void {
    const path = getCredentialsFilePath();
    const store = readStore(path) ?? { version: 1, servers: {} };
    store.servers[origin] = credentials;
    writeStore(path, store);
}

/**
 * Removes the stored credentials for `origin`.
 *
 * Returns whether an entry existed. Throws when the file cannot be rewritten —
 * reporting a logout that didn't persist would leave a live token on disk.
 */
export function clearCredentials(origin: string): boolean {
    const path = getCredentialsFilePath();
    const store = readStore(path);
    if (!store || !(origin in store.servers)) {
        return false;
    }
    delete store.servers[origin];
    writeStore(path, store);
    return true;
}
