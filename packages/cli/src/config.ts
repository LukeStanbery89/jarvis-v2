/**
 * Resolves the chat server's WebSocket URL and the local state file paths.
 *
 * The server URL reads `JARVIS_SERVER_URL` (for example
 * `ws://localhost:54321/ws`) and falls back to the local dev-server default.
 * The session file path reads `JARVIS_SESSION_FILE` and defaults to a
 * machine-local file under the home directory; see `src/session.ts`. The
 * credentials file path reads `JARVIS_CREDENTIALS_FILE` and defaults to a
 * sibling file; see `src/credentials.ts`.
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

/** Default location of the file that stores per-server login credentials. */
export function defaultCredentialsFilePath(): string {
    return join(homedir(), ".jarvis", "credentials.json");
}

/**
 * Returns the credentials file path, honouring `JARVIS_CREDENTIALS_FILE`.
 *
 * The file holds one entry per server origin (see `serverOrigin`), each with
 * the device token issued by that server's `POST /api/auth/login`; see
 * `src/credentials.ts`.
 */
export function getCredentialsFilePath(): string {
    return process.env.JARVIS_CREDENTIALS_FILE ?? defaultCredentialsFilePath();
}

/**
 * Derives a stable origin key for a server URL.
 *
 * Converts the WebSocket scheme to its HTTP form (`ws://` → `http://`,
 * `wss://` → `https://`), passes `http(s)` through untouched, and drops any
 * path, so `ws://localhost:54321/ws` and `ws://localhost:54321` name the same
 * server. Used both as the key into the credentials file and as the REST base
 * for `POST /api/auth/login` (see `src/login.ts`). Throws on URLs that are
 * invalid or use any other scheme.
 */
export function serverOrigin(serverUrl: string): string {
    let url: URL;
    try {
        url = new URL(serverUrl);
    } catch {
        throw new Error(`invalid server URL: ${serverUrl}`);
    }
    const { protocol } = url;
    const scheme =
        protocol === "wss:" || protocol === "https:"
            ? "https:"
            : protocol === "ws:" || protocol === "http:"
              ? "http:"
              : null;
    if (scheme === null) {
        throw new Error(
            `unsupported server URL scheme in: ${serverUrl} (use ws://, wss://, http://, or https://)`,
        );
    }
    return `${scheme}//${url.host}`;
}
