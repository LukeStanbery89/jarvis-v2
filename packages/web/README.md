# @lukestanbery/jarvis-web

Web chat client (SPA) for J.A.R.V.I.S. — a private (published-to-nobody,
Vite-built) browser client that the server serves at `/web`, alongside the
admin portal at `/` (issue #12). Sign in, pick a conversation, and chat: the
server streams the answer and the client renders it — Markdown, tables,
links, and images — in the browser.

## Stack

- React 19 + Vite 8 (browser SPA, ESM — not CommonJS, not `tsc`-built)
- Frames and parsing from `@lukestanbery/jarvis-protocol` (the single wire
  source of truth shared with `packages/cli` and the server)
- REST response types (type-only) from `@lukestanbery/jarvis-contracts`
- `react-markdown` + `remark-gfm` for reply rendering
- Tests via Vitest (Node environment; no browser/jsdom dependencies — the
  wire client and stores take injected socket/storage doubles)

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

## Sign-in and credentials

The client is signed-in-only: the login screen exchanges username +
password for a **device token** at `POST /api/auth/login` (the CLI's flow;
each login provisions a `web-<hex>` device so repeats stay distinguishable).
The token persists in **localStorage** under per-username keys
(`jarvis.web.user.<name>.*`), mirroring the CLI's credentials file — a
deliberate trade-off: it survives restarts, and any XSS in the page could
read it. A stored credential re-authenticates silently on boot; invalid or
revoked tokens (handshake error, the server's mid-prompt revocation frame,
or a REST 401) clear the credential and drop back to the gate. Sign-out
clears the credential but keeps the transcripts.

## Conversations and transcripts

The server stores LangGraph thread state but no readable message history,
so transcripts live **client-side** in localStorage
(`jarvis.web.user.<name>.threads`), keyed by the wire `sessionId`. The
sidebar merges the server's `GET /api/sessions` rows (filtered to the
signed-in user's `userId` — owner listings include every account) with the
local transcripts, so threads created on the CLI or another browser appear
(they start empty and continue on the first prompt). "New chat" mints a
fresh `sessionId` locally; the server row appears after the first prompt.
Threads are trimmed to their most recent 200 messages, and on localStorage
quota exhaustion the oldest whole thread is evicted once.

## Image attachments

The composer's 📎 button, clipboard paste, and drag-and-drop all attach
images (#10). Each attachment is prepared client-side before upload
(`src/downscale/policy.ts` decides; `src/downscale/browser.ts` executes):
in-budget PNG/JPEG within the 2048px clamp upload byte-for-byte, everything
else is re-encoded — PNG sources stay PNG (lossless, so screenshots and
glyphs stay crisp), photos go JPEG, with pixel/quality rungs stepped until
the result fits the 4 MiB budget. Uploads go to `POST /api/attachments`
(bearer auth, no CSRF — the client has no CSRF secret by design) and the
returned id rides the prompt's `attachments` list.

Attachment bytes are transient server-side (60-minute TTL): the transcript
keeps only the ids, so a reloaded thread shows a muted "image not retained"
note where the preview was. Image analysis requires signing in — it is
refused on guest sockets.

## Client capabilities and chat mode

On connect the client sends a first-frame `hello` announcement
(`{ type: "hello", capabilities: [...] }`, see `src/views/Chat.tsx`)
declaring what it can render: `markdown`, `image`, and `link`. Typed prompts
carry `mode: "text"` — text chats are answered with the declared
capabilities (rich Markdown/tables/images). Mic prompts carry
`mode: "voice"` (see below) and always yield plain conversational text
server-side. Raw `html` is deliberately _not_ claimed: model text is rendered as
Markdown with raw HTML skipped by react-markdown's default transform.

Links run through a protocol allowlist (`safeHref`: `http`/`https`/`mailto`
only, new-tab + `noopener` for external) and images render lazily without a
referrer — the agent's output is untrusted input, and these layers are
defense in depth on top of react-markdown's URL sanitizing and the server's
`img-src 'self' data: https:` CSP.

## Wire client

`src/ChatClient.ts` is an event-driven port of the CLI's chat client: one
persistent socket, `hello` as the very first frame, `auth` right behind it,
streaming prompt turns (`mode: "text"`), automatic reconnect with capped
backoff (1s → 10s) that re-runs the handshake, and permanent-rejection
handling (`onAuthRejected`). The socket constructor is injectable, so the
whole state machine is unit-tested in node (`src/ChatClient.test.ts`).

## Location sharing (#31)

Device-location sharing for the `getWeather` tool is **automatic by
default**: on load a geolocation request runs once, and the browser's own
permission prompt is the consent gate (the user answers explicitly; the
browser remembers). The sidebar MapPin is the visible opt-out (persisted in
localStorage — an explicit "0" suppresses sharing) and doubles as the
status light. On success, coordinates are
rounded to four decimals (~11 m), and the result ships as a `location`
frame — sent immediately (the server accepts them at any point in the
socket's lifetime) and re-announced after every reconnect, since the
server's socket state is per-connection. Outcomes have UI states: locating /
active / denied / failed / **unsupported** — `navigator.geolocation` exists
only in secure contexts (HTTPS or localhost), so over plain HTTP the pin
reports "unsupported" and the server-side tool falls back to asking for a
city. All geolocation logic lives in `src/location.ts` (plain `.ts`, node-
tested in `src/location.test.ts`) — the web package's node-env suite never
runs `.tsx` files, so no behavior may live only inside a component.

## Voice input (#84)

Click-to-talk via the Web Speech API: the composer's mic button starts
capture (pulse animation + a live partial transcript in the status line),
pressing again — or the engine's own final result — transcribes, and the
final transcript submits as an ordinary `mode: "voice"` prompt that lands in
history as text. A status line tracks the session stage (Listening… /
Transcribing… / Sending… / Thinking…), and a failed session (no speech,
denied microphone, rejected turn) stays on screen as an alert until the
next press.

The wiring splits cleanly: `packages/voice` owns the engine seam
(`SttProvider`) and the pure lifecycle reducer; `src/voice.ts` binds them —
a React-free `VoiceController` (an external store consumed via
`useSyncExternalStore`) that arms the engine, tags every event with its
session id, submits transcripts, and routes turn outcomes back through the
reducer, so stale engine callbacks or old turn ends can never disturb a
newer session. `src/views/Chat.tsx` renders the snapshot and forwards server
frames (`noteResponseFrame`). No behavior lives only in the component.

Two honest limits: Chrome's Web Speech recognition is cloud-backed (audio
egress to the recognition service — the local WASM provider is planned
behind the same interface), and `SpeechRecognition` exists only in secure
contexts (HTTPS or localhost), so over plain HTTP — like geolocation — the
mic reports unavailable (disabled button with an explanation) and typing
keeps working exactly as before.

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
- `src/App.tsx` — sign-in gate ↔ chat routing over the stored credential.
- `src/api.ts` — typed REST client (login, session list/delete; Bearer token).
- `src/credentials.ts` — per-user localStorage credential store.
- `src/threads.ts` — client-side transcript store (pure helpers + persistence).
- `src/ChatClient.ts` — event-driven `/ws` wire client (incl. `sendLocation`, #31).
- `src/location.ts` — geolocation consent + request plumbing (#31).
- `src/voice.ts` — voice-input controller: engine seam → lifecycle → submit (#84).
- `src/safeHref.ts` — link protocol allowlist.
- `src/Markdown.tsx` — GFM renderer with hardened links/images.
- `src/views/Login.tsx`, `src/views/Chat.tsx` — the two screens.
- `src/components/ToolCall.tsx` — collapsible tool/toolResult notices.
- `src/wsUrl.ts` — derives the page-origin `ws(s)://…/ws` URL.
- `src/styles.css` — shell styling.
