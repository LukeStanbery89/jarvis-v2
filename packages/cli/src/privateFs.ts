/**
 * Best-effort private filesystem posture for the CLI's local state.
 *
 * Mirrors the semantics of the server's `src/fs.ts` locally (the CLI cannot
 * depend on the server package): directories *this process creates* are
 * narrowed to `0700`, and secret-bearing files (credentials, session ids) are
 * written atomically at `0600` by {@link writePrivateFile}. Enforcement is
 * best-effort — `chmod`
 * failures are swallowed rather than aborting the CLI, which still works with
 * looser perms in a single-user setup.
 *
 * Care: a pre-existing directory is never chmodded — only directories this
 * process actually created are narrowed, so pointed `JARVIS_*` paths can't
 * unexpectedly lock out other users of shared locations like `/tmp`.
 */
import {
    chmodSync,
    existsSync,
    mkdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
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
 * Renders an unknown rejection's message — the shape every CLI catch site
 * needs (`err instanceof Error ? err.message : String(err)`, #107 P6).
 *
 * @param err - The thrown value.
 * @returns Its message, or its string form when it is not an `Error`.
 */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Returns whether `value` is a plain (non-array) object — the structural
 * guard the session-id and credentials readers share (#107 P6).
 *
 * @param value - The parsed JSON value.
 * @returns True for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serializes-agnostic atomic write for the CLI's secret-bearing state files:
 * `contents` is written to a `0600` temp file (pid-suffixed, so concurrent
 * CLI instances don't collide) in the target directory and renamed over the
 * target — a crash mid-write leaves the previous file intact rather than a
 * truncated one, the secret never touches disk at looser permissions, and
 * the rename also tightens a pre-existing loose file. The temp file is
 * removed best-effort on failure (#107 P6: `credentials.ts` and
 * `session.ts` carried identical copies).
 *
 * @param path - The target file path.
 * @param contents - The exact bytes to write (callers serialize).
 * @param label - Human label for the thrown error ("credentials file").
 * @throws An `Error` naming the file when the write fails.
 */
export function writePrivateFile(
    path: string,
    contents: string,
    label: string,
): void {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        ensurePrivateDir(dirname(path));
        writeFileSync(tmp, contents, { mode: 0o600 });
        renameSync(tmp, path);
    } catch (err) {
        try {
            unlinkSync(tmp);
        } catch {
            // nothing to clean up (or already removed)
        }
        throw new Error(
            `could not write ${label} ${path}: ${errorMessage(err)}`,
        );
    }
}
