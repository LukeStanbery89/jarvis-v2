/**
 * Best-effort private filesystem posture for local state.
 *
 * JARVIS keeps its data under `~/.jarvis` (app database, LangGraph
 * checkpoints). On a shared machine those files can carry account hashes and
 * conversation history, so directories *we create* are tightened to `0700` and
 * each database file is (pre-)created at `0600`. Enforcement is best-effort:
 * `chmod` failures (e.g. an existing file on an odd filesystem) are swallowed
 * rather than aborting startup — the app still works with looser perms in a
 * single-user setup.
 *
 * Care: a pre-existing directory is never chmodded — only directories this
 * process actually created are narrowed, so pointed `JARVIS_DB_PATH` /
 * `JARVIS_CHECKPOINT_PATH` values can't unexpectedly lock out other users of
 * shared paths like `/tmp`.
 */
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    mkdirSync,
    openSync,
} from "node:fs";
import { dirname } from "node:path";

/** Creates `dir` (recursively) and, only if this process made it, narrows it. */
export function ensurePrivateDir(dir: string): void {
    const existed = existsSync(dir);
    mkdirSync(dir, { recursive: true });
    if (!existed) {
        try {
            chmodSync(dir, 0o700);
        } catch {
            // best-effort: creation is the hard requirement
        }
    }
}

/**
 * Pre-creates `path` (without truncating an existing file) at mode `0600`.
 *
 * SQLite libraries create their files at the process umask (typically `0644`),
 * which is a world-readable window before the post-open chmod runs. Creating
 * the empty file at `0600` up front closes it; a file that already exists is
 * opened with `O_CREAT` alone (no truncation) which leaves its contents alone.
 */
export function createPrivateFile(path: string): void {
    try {
        const fd = openSync(
            path,
            constants.O_CREAT | constants.O_WRONLY,
            0o600,
        );
        closeSync(fd);
    } catch {
        // best-effort: fall back to the post-open chmod path
    }
}

/** Tries to narrow a single file to owner-only access. */
export function ensurePrivateFile(path: string): void {
    try {
        chmodSync(path, 0o600);
    } catch {
        // best-effort: only meaningful for files this process created
    }
}

/** Creates + pre-narrows `dbPath`, and its directory if this process makes it. */
export function ensurePrivateStorage(dbPath: string): void {
    ensurePrivateDir(dirname(dbPath));
    createPrivateFile(dbPath);
}
