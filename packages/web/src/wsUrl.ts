/**
 * Derives the chat WebSocket URL for the page the user is on.
 *
 * The web client is served by the JARVIS server (at `/web` in production,
 * via Vite's proxy in dev), so the chat socket always lives at the same
 * origin as the page: `ws(s)://<location host>/ws`. Deriving from
 * `window.location` keeps one code path working under both setups and under
 * TLS (the scheme follows the page).
 */
export function webSocketUrl(base?: URL): string {
    const origin = base ?? new URL(window.location.href);
    const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${origin.host}/ws`;
}
