/**
 * Loads or creates the CLI's persistent conversation session id.
 *
 * The id is read from the session file on startup and written back on first
 * use. Clients reuse it on every prompt so the server accumulates the whole
 * conversation under one LangGraph thread; deleting the file starts a fresh
 * conversation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionFilePath } from "./config";
import { ensurePrivateDir } from "./privateFs";
import { logger } from "./logger";

/**
 * Writes `fresh` to the session file (directory narrowed to `0700` when this
 * process creates it, file at `0600`). A lingering failure means the id
 * simply won't persist across restarts, so log but keep going.
 */
function writeSessionId(fresh: string): void {
    const path = getSessionFilePath();
    try {
        ensurePrivateDir(dirname(path));
        writeFileSync(path, `${fresh}\n`, { mode: 0o600 });
    } catch (err) {
        logger.warn(
            `Could not write session file: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/**
 * Returns the stored session id, or generates, persists, and returns a new one.
 */
export function loadOrCreateSessionId(): string {
    const path = getSessionFilePath();
    try {
        const existing = readFileSync(path, "utf8").trim();
        if (existing.length > 0 && existing.length <= 128) {
            return existing;
        }
    } catch {
        // No session file yet — fall through and create one.
    }

    const fresh = randomUUID();
    writeSessionId(fresh);
    return fresh;
}

/**
 * Overwrites the stored session id with a fresh one and returns it.
 *
 * Called when the CLI's identity changes (login/logout): the server enforces
 * strict session ownership, so a thread claimed by a guest can never be
 * re-claimed by an authenticated principal (and vice versa) — a new identity
 * starts a new conversation thread. A lingering write failure logs a warning
 * and keeps going; the current run still uses the fresh id.
 */
export function rotateSessionId(): string {
    const fresh = randomUUID();
    writeSessionId(fresh);
    return fresh;
}
