/**
 * Resolves the chat server's WebSocket URL.
 *
 * Reads the `JARVIS_SERVER_URL` environment variable (for example
 * `ws://localhost:54321/ws`) and falls back to the local dev-server default.
 */
// Default port must match the server's default PORT (packages/server/src/index.ts).
export function getServerUrl(): string {
    return process.env.JARVIS_SERVER_URL ?? "ws://localhost:54321/ws";
}
