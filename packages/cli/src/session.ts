/**
 * Loads or creates the CLI's persistent conversation session id.
 *
 * The id is read from the session file on startup and written back on first
 * use. Clients reuse it on every prompt so the server accumulates the whole
 * conversation under one LangGraph thread; deleting the file starts a fresh
 * conversation.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionFilePath } from "./config";
import { logger } from "./logger";

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
    mkdirSync(dirname(path), { recursive: true });
    // Reaching this line is the first run; a lingering failure to write means
    // the id simply won't persist across restarts, so log but keep going.
    try {
        writeFileSync(path, `${fresh}\n`, { mode: 0o600 });
    } catch (err) {
        logger.warn(
            `Could not write session file: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    return fresh;
}
