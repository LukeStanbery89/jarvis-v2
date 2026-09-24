/**
 * Best-effort private filesystem posture for the CLI's local state.
 *
 * Mirrors the semantics of the server's `src/fs.ts` locally (the CLI cannot
 * depend on the server package): directories *this process creates* are
 * narrowed to `0700`, and secret-bearing files (credentials, session ids) are
 * written by their callers at `0600`. Enforcement is best-effort — `chmod`
 * failures are swallowed rather than aborting the CLI, which still works with
 * looser perms in a single-user setup.
 *
 * Care: a pre-existing directory is never chmodded — only directories this
 * process actually created are narrowed, so pointed `JARVIS_*` paths can't
 * unexpectedly lock out other users of shared locations like `/tmp`.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";

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
