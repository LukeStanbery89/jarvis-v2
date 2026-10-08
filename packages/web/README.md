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
declaring what it can render: `markdown`, `image`, `link`, and `audio`.
Typed prompts carry `mode: "text"` — text chats are answered with the
declared capabilities (rich Markdown/tables/images). Mic prompts carry
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

Click-to-talk: the composer's mic button starts capture (pulse animation +
a live partial transcript in the status line), and the transcript submits
as an ordinary `mode: "voice"` prompt that lands in history as text. A
status line tracks the session stage (Listening… / Transcribing… /
Sending… / Thinking…), and a failed session (denied microphone, rejected
turn) stays on screen as an alert until the next press.

**The engine is Web Speech first**: `src/voice.ts` `createStt()` selects the
Web Speech engine (cloud-backed in Chrome) when the runtime offers it — the
fastest, most accurate dictation — and falls back to the local WASM engine
(Vosk, via `@lichess-org/vosk-browser`) when `SpeechRecognition` is absent
(e.g. Firefox) or the team wants on-device privacy by opting in, running
fully on-device (no audio egress). The engine's worker script and WASM
binary ship with the SPA bundle (Vite `?url` assets, served same-origin);
the `/web` CSP covers them with `worker-src 'self'` and `script-src 'self'
'wasm-unsafe-eval'` for the page, while the worker entry script itself is
served with a worker-scoped `script-src 'self' 'unsafe-eval'` CSP —
embind's runtime synthesizes method invokers with `new Function`, and a
worker whose entry declares its own CSP runs under that policy instead of
the owner's, so eval is confined to the hashed engine module and never
appears on the page. The model
archive (~40 MB) downloads once from the server's `GET /api/stt/model`
(configure the server with `JARVIS_STT_PROVIDER=vosk`; unconfigured → the
Vosk engine errors at session start) and persists in the browser's IndexedDB
after that. Selection is construction-time; a session-time failure
surfaces through the engine's own error path rather than falling back
mid-session.

Endpointing is VAD-owned when the runtime supports it (#84 P3): an energy
VAD (`createBrowserVad()` — Web Audio on its own echo-cancelled track) and
the controller's timers decide "pause ⇒ send" (800 ms of silence after
speech ends) and "press with silence ⇒ quiet idle" (4 s, `stt.cancel()`, no
error banner). The engine runs continuously (`start(…, { continuous: true })`)
and the controller accumulates its per-segment finals into one transcript.
Without VAD support the engine's own endpointing and the second-press stop
remain — identical to phase 2.

The wiring splits cleanly: `packages/voice` owns the engine seam
(`SttProvider`, `VadProvider`), the pure lifecycle reducer, and the
`VoiceController` orchestrator itself (moved there in P3 so other clients
reuse it). The controller arms the engines, tags every event with its
session id, submits transcripts, and routes turn outcomes back through the
reducer, so stale engine callbacks or old turn ends can never disturb a
newer session. `src/views/Chat.tsx` renders the snapshot, forwards server
frames (`noteResponseFrame`), and passes `createBrowserVad()` in at
construction; unmount disposes the controller (cancelling any live session
and releasing the WASM model worker). No behavior lives only in the
component.

Two honest limits: the WASM engine's model archive must be fetchable from
the server (a 404 from `GET /api/stt/model` — `JARVIS_STT_PROVIDER` unset —
surfaces as a session error), and every engine here needs a secure context
(HTTPS or localhost), so over plain HTTP — like geolocation — the mic
reports unavailable (disabled button with an explanation) and typing keeps
working exactly as before.

The client also declares the `audio` capability (#83): when the server has
TTS configured, voice-mode turns come back spoken — an `audioStart` frame
(sample rate), binary little-endian s16le PCM messages (decoded via the
protocol's `s16leToPcm`), and `audioEnd`, all before the turn's `done`.
`src/audio.ts` queues the chunks gap-free through a WebAudio context that
the mic press unlocks (the user gesture), and the status line reads
"Speaking…" while the turn's audio spans. A failed synthesis never
disturbs the text stream — the answer simply is not spoken.

### Wake word (#84 P4)

An optional "Hey JARVIS" wake word lives beside the click-to-talk mic: a
sidebar toggle (waveform icon, next to the location pin) arms an
on-device openWakeWord detector (`createWakeWord()` in `src/voice.ts` —
openwakeword-web running under the WASM STT engine's runtime). While armed,
the detector holds a second 16 kHz mic open continuously; a match plays a
short blip (`AudioPlayer.blip()`, the cue the toggle's user gesture
unlocked), opens a wake session through the same `VoiceController`, replays
the phrase's look-back audio into `wakeStt` (a second, always-local Vosk
instance — never Web Speech, so wake-eavesdropped audio never leaves the
device), strips "Hey JARVIS" from the transcript, and submits it as an
ordinary voice turn. The toggle is **off by default** (a persistent extra
mic), persisted in localStorage, rendered only when the runtime supports
wake (secure context + audio worklet), a local STT engine exists, and the
server answers the `HEAD /api/wake/model/melspectrogram.onnx` probe
(configured with `JARVIS_WAKE_PROVIDER=openwakeword`). The waveform icon
lights while `wakeArmed`; a failed arm surfaces through the normal voice
error path.

The ORT runtime and mic worklet ship with the SPA build:
`scripts/copy-voice-assets.mjs` stages `openwakeword-web`'s worklet and
`onnxruntime-web`'s wasm pair into `public/ort/` (copied to `/web/ort/`,
gitignored, staged by a Vite `buildStart` plugin). Vite resolves the
ESM-only `openwakeword-web` and `onnxruntime-web`'s "extern wasm" entry
through config aliases/conditions, so no 28 MB wasm is duplicated into the
bundle — it is fetched only at arm time from the staged directory.

### Barge-in (#84 P6)

You can talk over J.A.R.V.I.S. while the reply is playing. While the
lifecycle is `speaking`, the view arms the voice controller's barge-in
watch — a VAD-only mic session (echo-cancelled track, the browser's AEC
keeps JARVIS's own voice out) with a 2-second look-back ring. Sustained
speech (~300 ms) triggers once: local playback stops immediately, the
`cancel` frame drops the in-flight turn (the server ends it with `done` —
text already streamed stays in history), and a listening session opens
seeded with the look-back, so the interruption's opening words are
transcribed whole. The composer's send button becomes a **stop button**
while a turn streams — the same cancel path, for typed turns too. Every
step is opportunistic: without VAD support (no Web Audio) the watch stays
off and the stop button still works.

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
- `src/ChatClient.ts` — event-driven `/ws` wire client (incl. `sendLocation`, #31; binary audio decode, #83; `cancelTurn` + dropped-generation audio filtering, #84 P6).
- `src/location.ts` — geolocation consent + request plumbing (#31).
- `src/voice.ts` — voice-controller wiring + STT engine selection (Web Speech first, Vosk WASM fallback — #84 P3b) and the wake-word helpers (`createWakeWord`, `createWakeStt`, `probeWakeSupport`, wake pref — #84 P4); the controller lives in `packages/voice`.
- `src/audio.ts` — spoken-response playback queue (WebAudio, #83) + wake cue (`blip`, #84 P4).
- `src/safeHref.ts` — link protocol allowlist.
- `src/Markdown.tsx` — GFM renderer with hardened links/images.
- `src/views/Login.tsx`, `src/views/Chat.tsx` — the two screens (Chat owns the wake toggle + arming effect).
- `src/components/ToolCall.tsx` — collapsible tool/toolResult notices.
- `src/wsUrl.ts` — derives the page-origin `ws(s)://…/ws` URL.
- `src/styles.css` — shell styling.
- `scripts/copy-voice-assets.mjs` — stages the ORT/openWakeWord runtime assets into `public/ort/` (#84 P4).
