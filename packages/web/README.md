# @lukestanbery/jarvis-web

Web chat client (SPA) for J.A.R.V.I.S. — a private
(published-to-nobody, Vite-built) browser client that the server serves at
`/web`, alongside the admin portal at `/` (issue #12). Once the chat surface
lands it will talk to the server's REST login endpoint for a device token and
stream chat turns over the `/ws` WebSocket, rendering the response — Markdown,
hyperlinks, and images — in the browser.

This phase (PR-I) ships the scaffold and the client's first-frame `hello`
capability announcement; the interactive chat surface (REST sign-in, streaming
Markdown rendering, session threads) lands in the next PR.

## Stack

- React 19 + Vite 8 (browser SPA, ESM — not CommonJS, not `tsc`-built)
- Frames and parsing from `@lukestanbery/jarvis-protocol` (the single wire
  source of truth shared with `packages/cli` and the server)
- Tests via Vitest (Node environment; no browser/jsdom dependencies)

## Scripts

Run from `packages/web`:

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run build`     | `vite build` → static `dist/`                |
| `npm run dev`       | Vite dev server with HMR, proxying to :54321 |
| `npm run preview`   | Preview the production build                 |
| `npm run typecheck` | Type-check src and tests (`tsc --noEmit`)    |
| `npm test`          | Run the unit tests (Vitest)                  |

`npm run typecheck` needs `@lukestanbery/jarvis-protocol` built first (it
resolves through `dist/`), so run the root `npm run check` rather than a bare
`tsc` in a dependent package.

## Client capabilities

On connect the client sends a first-frame `hello` announcement
(`{ type: "hello", capabilities: [...] }`, see `src/App.tsx`) declaring what
it can render: `markdown`, `image`, and `link`. The server stores it for the
socket's lifetime and conditions the agent's system prompt on it. Raw `html`
is deliberately _not_ claimed: model text is rendered as Markdown with raw
HTML escaped (the server's own output is Markdown-formatted plain text).

## Serving

The built `dist/` is served by the server at `/web` (`JARVIS_WEB_DIR`, default
`packages/web/dist`); the Vite `base` is `/web/` so the build's asset URLs are
correct under that mount. The server applies a stricter-CSP variant for the
web mount: `img-src` is widened by `https:` (model-rendered remote images) and
`connect-src` is pinned to the request's `ws`/`wss` origin. In dev, Vite
proxies `/api` and `/ws` to `localhost:54321`, so the client dials the same
same-origin URLs as in production (`src/wsUrl.ts`).

## Source layout

- `src/main.tsx` — React bootstrap.
- `src/App.tsx` — shell + the `hello` capability probe (replaced by the chat
  surface in the next phase).
- `src/wsUrl.ts` — derives the page-origin `ws(s)://…/ws` URL.
- `src/styles.css` — shell styling.
