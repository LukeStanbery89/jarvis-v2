/**
 * Best-effort private filesystem posture for local state.
 *
 * JARVIS keeps its data under `~/.jarvis` (app database, LangGraph
 * checkpoints). On a shared machine those files can carry account hashes and
 * conversation history, so the directory is tightened to `0700` and each
 * database file to `0600`. Enforcement is best-effort: `chmod` failures (e.g.
 * an existing file on an odd filesystem) are swallowed rather than aborting
 * startup — directory creation always succeeds, and the app still works with
 * looser perms in a single-user setup.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Creates `dir` (recursively) and narrows it to owner-only access. */
export function ensurePrivateDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    try {
        chmodSync(dir, 0o700);
    } catch {
        // best-effort: creation is the hard requirement
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

/** Tightens the parent directory of `dbPath` and then the database itself. */
export function ensurePrivateStorage(dbPath: string): void {
    ensurePrivateDir(dirname(dbPath));
    ensurePrivateFile(dbPath);
}
