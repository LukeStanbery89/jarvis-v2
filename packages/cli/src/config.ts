/**
 * Resolves the chat server's WebSocket URL.
 *
 * Reads the `JARVIS_SERVER_URL` environment variable (for example
 * `ws://localhost:54321/ws`) and falls back to the local dev-server default.
 */
export function getServerUrl(): string {
    return process.env.JARVIS_SERVER_URL ?? "ws://localhost:54321/ws";
}
