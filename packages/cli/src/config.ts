/**
 * Resolves the chat server's WebSocket URL and the local session file.
 *
 * The server URL reads `JARVIS_SERVER_URL` (for example
 * `ws://localhost:54321/ws`) and falls back to the local dev-server default.
 * The session file path reads `JARVIS_SESSION_FILE` and defaults to a
 * machine-local file under the home directory; see `src/session.ts`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

// Default port must match the server's default PORT (packages/server/src/index.ts).
export function getServerUrl(): string {
    return process.env.JARVIS_SERVER_URL ?? "ws://localhost:54321/ws";
}

/** Default location of the file that holds the CLI's conversation id. */
export function defaultSessionFilePath(): string {
    return join(homedir(), ".jarvis", "session-id");
}

/**
 * Returns the session-id file path, honouring `JARVIS_SESSION_FILE`.
 *
 * The id stored there is sent as `sessionId` with every prompt, so a restart
 * of the CLI resumes the same server-side conversation thread.
 */
export function getSessionFilePath(): string {
    return process.env.JARVIS_SESSION_FILE ?? defaultSessionFilePath();
}
