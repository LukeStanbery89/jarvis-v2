# @lukestanbery/jarvis-web

Web app (SPA) for J.A.R.V.I.S. — a private (published-to-nobody,
Vite-built) browser client that the server serves at `/`: the app's front door
since #90 phase 6a, when the admin portal moved to `/admin`, the chat moved to
`/chat`, and the old `/web` address began 301-ing to `/chat`. Sign in, pick a conversation, and chat: the server
streams the answer and the client renders it — Markdown, tables, links, and
images — in the browser.

## Stack

- React 19 + Vite 8 (browser SPA, ESM — not CommonJS, not `tsc`-built)
- Frames and parsing from `@lukestanbery/jarvis-protocol` (the single wire
  source of truth shared with `packages/cli` and the server)
- REST response types (type-only) from `@lukestanbery/jarvis-contracts`
- `react-markdown` + `remark-gfm` for reply rendering
- A hand-rolled canvas particle field (`src/particles/`) — a pure motion model
  plus one `requestAnimationFrame` loop, with no rendering dependency
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

### What the dev server serves

`npm run dev` proxies `/api`, `/ws` and **`/admin`** to the running JARVIS
server (`:54321`). The last one is not obvious and worth knowing: the admin
portal is a _different app_ on the real server, and the dashboard links to it —
without the proxy, the dev server would answer `/admin` with _this_ app's shell,
which renders the dashboard (an unknown path), so the link would look like it
went nowhere while production was perfectly correct. Anything else under `/`
is this app, on every path it names (Vite's SPA fallback).

## Pages

Real paths, not hash routes (#90 phase 6a): the server's SPA fallback replays
`index.html` for any non-`/api` GET, so a deep link and a reload both work
without a route on the server, and a URL reads as the page it names. The admin
portal is a different app at `/admin` and keeps its own hash router.

| Path             | Today                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `/`              | The dashboard: the clock, what is coming up, the unread count                                               |
| `/chat`          | The conversation                                                                                            |
| `/timers`        | The countdowns still running: New, Edit, Cancel, and a Recent history                                       |
| `/reminders`     | What the assistant owes you: New, Edit, **Repeats**, Cancel, **Snooze**, Recent                             |
| `/notifications` | What is scheduled of the class, then everything recorded (Mark read · Dismiss · Snooze · Answer a question) |
| anything else    | The dashboard (a typo or an old link gets the front door, not an error)                                     |

In-app links are `AppLink`s over the store in `src/router.ts`: a click swaps the
view with `history.pushState` instead of reloading the document, so Back and
Forward behave and a modified click still opens a real tab (every path replays
the shell, so that tab works). The bar's one exception is **Admin** (`/admin`),
a real anchor after a hairline: the portal is a different SPA with its own
router and cookie sign-in, so following it unloads this app. It is shown to
every account — the web app has never fetched `role`, and the portal's own
owner check is the honest gate. The `/ws` socket survives the swap because
`src/AppShell.tsx` owns it rather than the view (#90 phase 6b) — which is why a
turn that is mid-stream keeps landing in the transcript while the user walks to
another page.

## Background (#146)

The app sits on a slow, blue disc of particles: dense at the centre, sparse at
the rim, turning once every ~105 s and breathing every ~11 s. It is one
full-viewport canvas rendered behind `.app` (so a route change never restarts
it), and it is deliberately cheap — a cached glow sprite stamped once per
particle with `lighter` compositing, no `shadowBlur`, no per-frame allocation,
device pixel ratio capped at 1.5, and a frame delta clamped to 50 ms so a
backgrounded tab resumes instead of teleporting.

The split is the app's usual one: `src/particles/field.ts` is the whole motion
model — seeded PRNG, rotation, breathe, projection into a `Float32Array` — and
is unit-tested without a browser; `src/particles/ParticleCanvas.tsx` is the
loop around it.

`step(field, dt, energy)` takes a 0..1 `energy` that widens the breathe and
brightens the disc, and phase E feeds it the answer's voice: `AudioPlayer`
routes the spoken PCM through an `AnalyserNode` (256 samples, ~5 ms at the
protocol's 24 kHz) and exposes `energy()` as the RMS of that window, scaled ×6
because a voice sits well below full scale. The alarm and the wake cue stay
direct-to-destination — the field answers the assistant, not every sound the app
makes. `ParticleCanvas` reads it through a ref once per frame and smooths it
over ~170 ms, so the disc breathes with the sentence rather than strobing per
syllable, and `energy()` returns 0 the moment nothing is speaking, so it settles
with the last word instead of holding the peak. A context without
`createAnalyser` simply has no tap and a still field.

`prefers-reduced-motion: reduce` draws a single static frame; the media query is
watched, so toggling the OS setting takes effect without a reload.

All three appearance preferences are switches in the settings panel's
**Appearance** group (`src/appearance.ts`, `localStorage` key
`jarvis.appearance`). They are per-browser, not per-account: a busy background on
a phone and a quiet one on a wall display are facts about the device. Turning the
field off **unmounts** the canvas, so its loop stops rather than drawing into
something invisible; turning the glass off sets `data-glass="off"` on `.app`,
which flattens the composed `--glass-filter` to `none` and darkens the tint; and
**Navigation labels** off sets `data-nav-labels="off"` on the wide-screen left
menu, which hides its words and leaves their icons, with each item's
`aria-label`/`title` still naming it. The layout is otherwise identical — a
switch is about the surface, not the shape.

## Responsive layout (#146 phase D)

The shell stops growing at 96 rem (`--shell-max`) and centres, so on a wide
monitor the particle field becomes the margin rather than stretching behind an
ever-longer row of content. Inside it the list pages (`/timers`, `/reminders`,
`/notifications`) hold a 64 rem measure — and subtract a 0.75 rem gutter from
their own width, so the pane floats off the edge rather than touching it at
exactly the widths a phone sits at — the dashboard holds 48 rem, and the
transcript centres its turns in a 64 rem reading column **by padding** — a
narrower scroller would have floated the scrollbar in the middle of the pane.

Under 48 rem the chat is one column and the thread list becomes a drawer over
the conversation: a scrim closes it, Escape closes it, and a pick closes it on
the way to the thread. The closed drawer is `visibility: hidden`, not merely
translated off-screen, so it stays out of the tab order; reduced motion drops
the slide. The state lives in `AppShell`, not `Chat`, because the control is in
the top bar — the chat route's first button, where the wordmark sits on wide
screens — while the drawer is the view's; the shell also closes it on a
navigation. At that width the wordmark is pinned to the bar's true centre
(the flanks differ in width, so flex-centring would sit it off-centre).

The **bar** collapses at its own breakpoint, **60 rem**, not the shell's 48:
with three state chips beside them, the wordmark, four links, Admin, the account
name and the gear need just over 60 rem, and 50–55 rem was the band where the
chips ran the links out of room. There the links hand over to the hamburger and
the gear to a **Settings** item in it, with Admin below a hairline under them —
the wordmark's centring stays at 48 rem because it belongs to the thread
toggle, which follows the chat's breakpoint.

The **rail** takes over at **80 rem**: the bar's links step aside for a column on
the left — dashboard, chat, timers, reminders, notifications, then Admin past a
hairline — each item its icon beside its word, and each carrying an `aria-label`
and a `title` as well, so an icon alone still names itself. The **Navigation
labels** switch is the rail's own: off, the words are hidden and the column falls
back to the 2.5 rem icon squares, while the bar's links (60–80 rem), the
hamburger (under 60 rem) and the drawer keep their words — exactly one set of
destinations is visible at every width, and only the wide-screen one responds to
the switch. The switch itself follows the rail's breakpoint: below 80 rem, where
the rail is absent, the settings panel hides it (`.settings-nav-labels`) rather
than offering a control that changes nothing.

The sign-in gate is the same box: `Login` renders it as `.app.gate` and reads
this browser's appearance itself, so the field and the glass reach the first
screen and a switch turned off stays off before anyone signs in. The card is the
glass pane, centred by its own auto margins — a card taller than a short window
scrolls instead of losing its title to a centred flex item's overflow.

The same breakpoint raises every phone-reachable control to at least 44 px in
its short dimension — a floor via `min-height` on labelled buttons, 2.75 rem
squares on icon buttons — and starts the corner toast stack below the taller
bar. Job and notification rows also stack at that width: what the row says on
one line, its controls on the next. The actions never shrink
(`flex-shrink: 0`), so until they were given their own row the _text_ was what
gave way, and a four-word reminder title wrapped to one word per line. A job's
moment now rides opposite its class on the first line (`job-when` moved out of
`job-actions`), which leaves that second row to be nothing but buttons — and the
three are given an equal `min-width` floor with their labels centred, so "Edit"
is not half the width of "Snooze" — or pinned to the left edge of a wider
button.

**A list page is a stack of panes.** `/timers`, `/reminders` and
`/notifications` no longer put the whole list on one sheet of glass:
`.page-rows` drops the page-level pane, and the head (title, count, New) and
every row below it — jobs, settled rows and notification records alike, plus
their empty states — become panes of their own, with more air between them. The
page is the layout, not the window. The notification list's bordered scroll box
became the gap between its panes, and a record's state moved to its header line
beside the eyebrow, where a job's moment sits. From 64 rem the rows pair up in
two columns of half the page each — a row at the measure spends most of its
width empty — with `minmax(0, 1fr)` tracks so a long title cannot widen its
column past its share.

That
block sits last in `styles.css` on purpose: it overrides sizes declared above,
and a media query carries no specificity of its own.

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

Deleting a conversation is a **press-and-hold** gesture (#157): the row's trash
button fills a red ring clockwise for three seconds, and the row is removed only
when the ring closes. Releasing early — or a scroll that starts on the button —
cancels the hold and deletes nothing, so a stray tap cannot lose a thread. The
gesture lives in `views/app/HoldToDelete.tsx`; the sidebar only names the row.
The button is the circle alone: its `.icon-btn` hairline border and rounded hover
wash are cleared in `styles.css`, so no square is drawn around the ring.

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
default**: on app load a geolocation request runs once, and the browser's own
permission prompt is the consent gate (the user answers explicitly; the
browser remembers). The share is the app's, not the chat's (#90 phase 6d):
the request runs when the signed-in app mounts, and the `location` frame goes
out over the shell's socket from whatever page the user is on. The location
pin lives in the **settings panel** under
"This browser" (#143) and is the visible opt-out (persisted in localStorage —
an explicit "0" suppresses sharing). While sharing is on but not delivering,
the bar says so in a word (`Locating…` / `Location denied`
/ `Location failed` / `Location unavailable`), so a declined permission prompt
is never silent. On success, coordinates are
rounded to four decimals (~11 m), and the result ships as a `location`
frame — sent immediately (the server accepts them at any point in the
socket's lifetime) and re-announced after every reconnect, since the
server's socket state is per-connection. Outcomes have UI states: locating /
active / denied / failed / **unsupported** — `navigator.geolocation` exists
only in secure contexts (HTTPS or localhost), so over plain HTTP the panel
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
the app's CSP covers them with `worker-src 'self'` and `script-src 'self'
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
newer session. `src/hooks/useVoiceSession.ts` owns the controller's lifetime:
it constructs the controller (passing `createBrowserVad()` in and re-installing
the submit seam) inside a mount effect — so React StrictMode's double-invoke
gets a fresh instance rather than a permanently-disposed one — and disposes it
on unmount (cancelling any live session and releasing the WASM model worker).
Since #90 phase 6d the hook is **the shell's** (`src/AppShell.tsx`), not the
chat view's: a wake word that listens on one page only is not a wake word, and
the turn a transcript submits into is the shell's active thread, so
`runTurn` — mint the thread if none is open (and go to it, since an answer
nobody can see is not an answer), record the user message, `prompt`, persist,
re-read the notifications — is the shell's too, shared with the typed composer.
That is also what let the frame bus go: the shell's `onFrame` is now the one
place that feeds the controller (`noteResponseFrame` for a turn's first frame,
`noteAudioStarted` for `audioStart`), where a mounted view used to subscribe.
The engines cost nothing to hold — Vosk loads its worker and model inside
`start()`, openWakeWord loads ORT inside `start()` — so the only cost of the
lift is the wake-support probe on boot and the arming the phase exists for.
The chat remains the _detailed_ view of a session (the live partial
transcript, the stage, a failure's reason) reading the same snapshot the bar
does. No behavior lives only in a component.

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
switch in the settings panel (#143, "This browser" — the detector is a
per-device engine) arms an
on-device openWakeWord detector (`createWakeWord()` in `src/voice.ts` —
openwakeword-web running under the WASM STT engine's runtime). The detector
belongs to the app (#90 phase 6d): once armed it listens on **every page**, and
a match taken on `/timers` submits into the open thread exactly as one taken in
the chat does — with no thread open it mints one and goes to it. While armed,
the **bar** shows a blinking red microphone, because an open
microphone is not something to have to open a panel to discover (a static
icon under `prefers-reduced-motion`), and
the detector holds a 16 kHz mic open continuously; a match plays a short blip
(`AudioPlayer.blip()`, the cue the toggle's user gesture unlocked), opens a
wake session through the same `VoiceController`, and then **streams the
command straight off the detector's own microphone** into `wakeStt` — every
frame from the match onward, so the phrase is excluded by construction and a
one-breath "Hey JARVIS what time is it" is captured whole, with no second mic
opening late and nothing spliced (#121). `wakeStt` is a second, always-local
Vosk instance running microphone-free (`{ source: "external" }`; never Web
Speech, so the command never leaves the device); it endpoints on its own
silence detection, and any stray "Hey JARVIS" is stripped as a safety net
before the prompt is submitted as an ordinary voice turn. The
toggle is **off by default** (a persistent extra
mic), persisted in localStorage, rendered only when the runtime supports
wake (secure context + audio worklet), a local STT engine exists, and the
server answers the `HEAD /api/wake/model/melspectrogram.onnx` probe
(configured with `JARVIS_WAKE_PROVIDER=openwakeword`). The waveform icon
lights while `wakeArmed`; a failed arm surfaces through the normal voice
error path.

The ORT runtime and mic worklet ship with the SPA build:
`scripts/copy-voice-assets.mjs` stages `openwakeword-web`'s worklet and
`onnxruntime-web`'s wasm pair into `public/ort/` (copied to `/ort/`,
gitignored, staged by a Vite `buildStart` plugin). Vite resolves the
ESM-only `openwakeword-web` and `onnxruntime-web`'s "extern wasm" entry
through config aliases/conditions, so no 28 MB wasm is duplicated into the
bundle — it is fetched only at arm time from the staged directory.

`createWakeWord()` hands ORT that directory as an **origin-absolute** URL
(`wakeWasmPath()`), never a root-relative one. ORT loads the wasm glue with
a runtime `import(<url>)`, and Vite's dev server appends `?import` to any
dynamic import whose specifier starts with `.` or `/`; it then refuses the
request, because a `public/` file may not enter the module/transform
pipeline — so in dev the detector failed to arm and Vite logged an internal
error (#123). An absolute URL is left untouched by that rewrite, and is the
same request the built client makes. The mic worklet stays relative:
`audioWorklet.addModule` is never rewritten.

### Barge-in (#84 P6)

You can talk over J.A.R.V.I.S. while the reply is streaming or playing.
While a voice response is in flight (`responding` onward, so a tool turn is
covered from the tool call rather than only from its first audio frame,
#114) or the player still has audio scheduled, the shell arms the voice
controller's barge-in
watch — a VAD-only mic session (echo-cancelled track, the browser's AEC
keeps JARVIS's own voice out) with a 2-second look-back ring. Sustained
speech (~300 ms) triggers once: local playback stops immediately, the
`cancel` frame drops the in-flight turn (the server ends it with `done` —
text already streamed stays in history), and a listening session opens
seeded with the look-back, so the interruption's opening words are
transcribed whole. A **wake match** pre-empts the same way: the detector can
only fire once the previous turn has settled — for a spoken reply that is
_after_ its `done` frame, while the audio is still playing — so the cue also
stops playback and cancels the turn, otherwise the old answer talks over the
new command and the new answer's audio queues behind it (#114). Note the
ordering when both listeners are live — the reply's tail with wake armed:
the energy VAD sustains (120 ms onset + 300 ms) well before the detector
finishes a phrase, so an interruption that _is_ the wake phrase is routed
through the barge path (look-back replay, no phrase stripping) rather than
opening a wake session. Both stop playback and open a session; only the
routing differs, and stripping the phrase on the barge path too would be the
way to converge them. The
composer's send button becomes a **stop button**
while a turn streams — the same cancel path, for typed turns too. Every
step is opportunistic: without VAD support (no Web Audio) the watch stays
off and the stop button still works.

### Replay harness and transcript tracing (#121)

Two dev-only surfaces support the wake→command work:

- **`/chat?voice-harness=1`** renders an offline replay harness
  (`src/dev/VoiceHarness.tsx`, lazily imported so it is code-split out of a
  normal page load). Load an audio file — a committed fixture under
  `packages/voice/test/fixtures/`, or your own recording in any format the
  browser decodes (a 48 kHz iPhone voice memo's `.m4a` works as-is) — and it
  runs the clip through the **real local Vosk engine with no microphone**
  (`{ source: "external" }`), feeding it in real time, and prints the raw
  transcript for both the whole clip (today's behavior) and the post-match
  slice, next to the current wake-phrase strip. That pair is the A/B the
  redesign is judged on, and "Copy report" puts it on the clipboard for the
  issue record. _The dev server
  pre-bundles `@lukestanbery/jarvis-voice`; after rebuilding that package,
  restart the dev server (or start it with `--force`) or the harness sees a
  stale copy with no new exports._
- **`/chat?voice-trace=1`** logs each wake session's raw recognizer transcript
  and the prompt actually submitted (`[jarvis:voice:trace] raw="…"
submitted="…"`). It is deliberately a _separate_ switch from
  `?debug=1`/`jarvis.debug` (`src/voiceTrace.ts`): it prints real user speech,
  so ordinary voice debugging must never start dumping transcripts.

## Notifications (#139)

This client declares the `notification` capability in its `hello` frame, which
is what lets the server push the out-of-turn `notification` frame to its
sockets. That gate is deliberate rather than incidental: a client that does not
declare it (an older bundle, the CLI) is never sent the frame, because an
unreadable frame fails that client's turn — so adding a server frame stays
additive instead of breaking clients the server cannot update.

The server can push a `notification` frame at any time — a background job
finishing, a reminder coming due, an agent needing an answer — and this client
is where it surfaces. Two sources feed one list: the frame itself (best-effort,
arriving **outside** a turn, so `ChatClient` routes it to `onNotification`
rather than the turn-scoped `onFrame`) and `GET /api/notifications` on load.
They carry the same `id`, and `src/notifications.ts` merges by it — so a
pushed notification is never rendered twice, and a frame can never un-read or
un-dismiss something the user already settled (the wire frame carries no
state; the record does).

The surfaces are the notifications page at `/notifications`
(`src/views/app/NotificationsPage.tsx`, where Mark read · Dismiss · Snooze live),
the unread badge in the top bar, and — since #90 phase 6b — a floating toast in
the shell (`src/views/app/Toast.tsx`) that reaches the user on **every** page,
because a fired reminder arrives wherever they happen to be. Which rows reach
the toast is `selectToasts`' decision (see the alert-classes section below), not
the list's. Reading or dismissing is optimistic — the list
updates immediately and rolls back if the server refuses — and a notification
raised while this client was closed is simply in the list when it next loads,
which is why nothing here depends on the frame arriving. The list is re-read
when the socket comes up after a **failed attempt** — the client reports that
itself (`ChatClient`'s `onReconnected`), because a notification raised while
the server was unreachable was pushed to nobody and the list is the only place
it can appear. The client reports it rather than the view inferring it from the
status sequence: `connecting` and `reconnecting` both precede `connected`, so a
view effect trying to tell them apart ends up keyed on something that changes
every render — which is a fetch loop, not a reconnect.

An **answerable** notification (#94) — raised with `requiresAnswer`, e.g. a
coding job parked on a question — is settled by replying, not by reading it, so
its row renders an answer surface in place of Mark read. When the record names a
`codingJobId` (#180), the card fetches `GET /api/coding-jobs/{id}/questions` and
renders one control per question — a textarea, a radio group, or a checkbox
group, plus an optional **Other** field — then submits the whole set as
`{ answers: [{ questionId, value, other? }] }`. A notification with no job link,
or a job that has no structured questions, keeps the free-text box and submits
`{ answer }`. `POST /api/notifications/:id/answer` resumes the job behind the
question _before_ it marks the row `answered`, so a refusal leaves the form (and
the draft) in place with the server's reason, and the answered summary is shown
on the settled row. A settled row also offers a collapsed **Questions and
answers** disclosure, which reads the same route so the full Q/A set stays
visible after the job continues. The record carries the job's `codingJobId`, but
the form never sends it: the server resolves the link, so a client cannot point
an answer at a job it was not given.

A **held-back** notification (quiet hours, the per-minute budget, the user's own
switch) is pushed to nobody at all — the suppression gate returns before any
channel runs — so the record is the only trace it leaves, and the client has to
re-read the list to find it. Two more places do that fetch, both because the
alternative is a notification that is invisible until a page reload: the end of
a **turn** (a tool call is exactly how the assistant raises one) and the moment
the **list is opened** (which is the user asking what is there). Silence is not
a state the UI should be able to be in.

**Desktop notifications (phase 2).** A switch in the settings panel (#143,
"This browser") raises OS
notifications through the `Notification` API, for the case where the user is
not looking at this tab. The rules live in `src/browserNotify.ts` and are all
refusals: only while the document is **hidden** (a visible tab already has the
in-app banner, and an OS pop-up beside it is noise), only for a row the server
**actually pushed** (`delivered` — a `pending` row is the server choosing not to
interrupt, and the browser has no standing to overrule it, #90), only once per
id (the live frame and the fetched page both mention it), and only when the
user's preference, the account's master switch, and the browser's permission all
agree. Clicking one focuses this tab and marks it read — or, for a timer, acts
as **Stop** — which is the entire point of the channel.

Permission can only be requested from a user gesture, so the toggle's click
handler is where `requestPermission()` runs; a `denied` browser is reported as
**blocked** rather than merely off, because it cannot be re-prompted and the
tooltip has to send the user to their settings. The preference is stored per
browser _and_ per username (`jarvis.web.user.<name>.browserNotify`): the
browser grants permission per origin, and it cannot be synced, so a server
preference would let the UI claim "on" while that browser would refuse. Web
Push — which genuinely needs server-side state — is phase 3.

**Testing it.** In a development build, with the `jarvis.debug` gate on, the
expanded list shows a _Send a test notification_ button — it is behind
`import.meta.env.DEV` as well, so a shipped bundle carries neither the branch
nor the button. It raises a notification through this browser's own credential
and prints what the server did with it — pushed to N clients, or recorded only
because no client was connected, quiet hours held it back (a notification
waits them out — only a `timer` pierces them, #90), or the delivery budget was
spent. That single line separates "the server did not push it" from
"the client received it and did not show it", which is otherwise unresolvable
from a missing banner; doing the same thing with `curl` also requires a device
token and the right account, which is exactly the sort of thing that makes a
test inconclusive.

In a shipped client the same test runs through the assistant instead — "send me
a test notification" calls the `sendNotification` tool (#139), which is a real
producer exercising the same service the button does. The button stays because
it costs no model call and still works when the model path is the thing that is
broken.

Everything about raising an OS notification is guarded: an environment with no
`Notification` global (the node test env, an old browser) hides the toggle
entirely, and a throw from `new Notification` (iOS Safari outside an installed
PWA, permission revoked in a background tab) is swallowed — the in-app
notification and the stored record are unaffected.

## Alert classes and the timer ring (#90 phase 4)

Every notification carries a **class** the server decided when the thing was
scheduled: `timer`, `reminder`, or `notification`. The client carries it too
(`ClientNotification.class`, mapped in `src/notifications.ts` — the wire frame
and the REST record have both had it since #90 phase 2a), because it decides
which surface a row gets. `selectAlerts(list, { enabled, now })` is the single
place that decision is made, and it returns `{ ring, banner }`:

| Row                                       | Surface                                         | Sound                                      | Exit                |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------ | ------------------- |
| `timer`, `job.finished`                   | the modal ring overlay                          | a three-tone chime every 3 s until stopped | **Stop**            |
| `reminder`                                | the **floating toast**, on any page             | none                                       | Mark read · Dismiss |
| `notification` (incl. agent requests)     | the badge and the list                          | none                                       | Mark read · Dismiss |
| `timer` that **failed** or was **missed** | the **floating toast**, labelled `Timer failed` | none                                       | Mark read · Dismiss |

Rules worth knowing, all pure and pinned by tests:

- The ring target is the **oldest** fired timer, so two timers queue instead of
  shouting over each other; when one is stopped the next takes over, and the
  ring loop is idempotent so the hand-over does not restart the pattern.
- The ring target is never also the toast, and that is structural rather than a
  check: only a fired `timer` rings and only a failed or missed one toasts, so a
  firing timer appears in exactly one loud place (a test pins the pair).
- `selectToasts(list, { enabled })` picks every row worth interrupting for, up to
  `TOAST_LIMIT` (3), newest first. Anything past the limit is still in the list and
  still counted by the badge, and the master switch empties the corner entirely. An informational notification deliberately does not toast: it is a
  record to read, and interrupting whatever page the user is on would make every
  tool that says something a popup.
- The master switch silences the toast as it silences the ring: a suppressed row
  is still a record, but nothing may start shouting on its behalf.
- Only a timer that **actually fired** rings. A failed or missed one has nothing
  due, and an overlay whose Stop button stopped nothing would misrepresent what
  the user is acknowledging — so those two are the timer's toast case instead.
- **Snooze** (the reminder table's escape hatch) is the toast's third action, and
  it is one request end to end: `POST /api/jobs/{id}/snooze` moves the reminder
  _and_ settles the announcement it came from (`snoozed`), because the deferral is
  the acknowledgement. `src/snooze.ts` is the client's join of those two halves:
  the row is settled locally once the call reports success, and the notification
  list is re-read either way — a snooze from the reminder list settles a row that
  page never held. The three offsets are `SNOOZE_PRESETS` (in an hour, tomorrow,
  next week), shared by `views/app/SnoozeMenu.tsx` so the surfaces that offer a
  snooze cannot offer different choices in a different order.
- The account's **master switch** gates the ring. A suppressed row is still a
  record worth reading, but nothing may start shouting on its behalf.
- A timer keeps the right to ring for **24 h** (`RING_MAX_AGE_MS`): "rings until
  acknowledged" still greets a browser that was closed, without a week-old timer
  shouting at the next visit. An unreadable timestamp fails closed.

`TimerRing` is a modal `<dialog>`, which is what makes "wherever the user is"
structural rather than a z-index race: a modal dialog lives in the browser's top
layer, so the ring covers the settings dialog — and anything that opens later —
without either component knowing about the other's stacking. Escape is a
**Stop**, not a way to hide an unacknowledged timer; the tab title becomes
`⏰ <label>` while it rings; the pulse honours `prefers-reduced-motion`. Stop
dismisses the row (the durable half) and silences the alarm at once — a failed
dismissal rolls the row back and the ring resumes with it, so the overlay never
claims an acknowledgement the server did not get.

**The audio unlock is no longer the mic's alone.** A timer can fire before the
user has ever touched the mic, and a suspended `AudioContext` is silent — a
timer nobody hears is the exact failure this phase exists to fix — so the first
`pointerdown`/`keydown` anywhere resumes it once. A ring requested while the
context is still suspended starts sounding the moment it resumes; the overlay
appears either way, because a tab nobody has ever interacted with cannot make
sound and hiding the timer instead would be worse.

**The alarm is scheduled, not ticked.** A background tab throttles
`setInterval` (Chrome clamps it to once a minute after five minutes hidden), and
a timer is most likely to fire while the tab is hidden — exactly when a
chime-per-tick alarm would go quiet. So `startRing()` queues about two minutes
of the pattern on the **audio clock**, which is not throttled, and tops it up
every thirty seconds; a fully throttled top-up still lands well inside the
window already queued, so the sound never gaps. `stopRing()` stops every queued
tone, not just the loop, so Stop is immediate even with two minutes of audio in
flight.

The chime is Web Audio, deliberately ours rather than the OS's: an OS popup's
sound is the browser's to suppress. A timer's popup also asks to be **sticky**
(`requireInteraction`) and clicking it is a Stop — but stickiness is the
browser's to grant, not ours: Chrome on macOS ignores the flag and dismisses the
banner after a few seconds, while Windows/Linux/ChromeOS and Safari's Web Push
honour it. The guarantees this client actually owns are the modal overlay, the
tab title, and the alarm; the OS card is best-effort.

## Settings panel (#143)

A gear in the **top bar** opens a settings panel holding the controls that
used to sit as four icon buttons beside the account name (location, wake word,
desktop notifications, sign out). The gear moved there in #90 phase 6d: the
microphone and the location share it governs are the app's, so the panel that
holds their toggles has to be reachable from every page, not only while the
chat is on screen. It is a native `<dialog showModal()>` — so
Escape, the focus trap, and restoring focus to the gear are the platform's job
rather than a hand-rolled key handler — and it is organized by **where a
setting lives**, because that is the part a user has to know:

| Group            | Settings                                         | Stored in                                              |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------ |
| **Your account** | Notifications, quiet hours                       | `notify.*` in `/api/prefs` — applies on every device   |
| **This browser** | Desktop notifications, wake word, share location | `localStorage` — a permission, a microphone, an engine |

The split is not cosmetic. The server is the one that decides whether to
interrupt you (`notify.enabled`) and when it is quiet (`notify.quietHours`), so
those must hold on every device — including the phone, which will never share a
browser's notification permission. The browser-side three are per-device facts
that cannot be synced without lying about them.

The account group renders what the system **does**, not what happens to be
stored (`src/prefs.ts`): a well-formed pref shows the real controls, an absent
one shows the documented default, and a stored value the server cannot parse
shows _not in effect_ with a line saying so and how to fix it. It never crashes
on an unexpected shape, never echoes raw bytes into a time input, and never
shows the default as though the write had worked — the last of those would hide
exactly the failure the notification work exists to make visible. A rejected
write surfaces the server's own message (a malformed value for a known key is a
400, see the server README), and the hook re-reads the stored map rather than
guessing a rollback.

Zeros worth knowing: the panel writes single-key patches, so it never touches
integration prefs; it never calls `DELETE /api/prefs`, which would clear the
whole map; quiet hours are switched off by writing `null`; and the unread count
rides both the Notifications link and the hamburger, whichever is showing, so
nothing depends on the chat being on screen.

## Dev-server gotcha: the linked protocol package

`npm run dev` pre-bundles `@lukestanbery/jarvis-protocol` (its build output is
CommonJS, which the browser cannot load directly — see the note in
`vite.config.ts`). Vite keys that pre-bundle on the **lockfile and its own
config**, not on the linked package's contents, so **rebuilding the protocol
while the dev server is running leaves the browser holding the old
`parseFrame`**. The symptom is nasty because it is silent: the server sends a
frame the stale parser does not recognize, the client drops it, and only an
REST-backed refresh shows the result — so a feature looks like it "only works
after a reload" even though it works in the built client.

When you change `packages/protocol` (a new frame, a parser rule):

```sh
npm run build -w @lukestanbery/jarvis-protocol
npm run dev:clean -w @lukestanbery/jarvis-web   # clears the dep cache, restarts Vite
```

`dev:clean` is the whole fix — it removes `node_modules/.vite/deps`, so the
next start re-optimizes against the current build. The built app served by
the JARVIS server at `/` has no such cache and is unaffected.

**A change to the protocol needs a fresh pre-bundle.** Vite caches the
pre-bundled package under `node_modules/.vite/deps`, and a stale bundle silently
keeps the _old parser_: frames then arrive with fields the current protocol
added missing (a notification frame without `class` was exactly this, 2026-10-17
— it read as "timers never ring" while the REST list, whose types come from
contracts, worked). The failure is silent rather than an error, so restart the
dev server after changing the protocol.

## Serving

The built `dist/` is served by the server at `/` (`JARVIS_WEB_DIR`, default
`packages/web/dist`); the Vite `base` is `/` so the build's asset URLs are
correct at the origin root. (The admin portal is a separate build served at
`/admin`; the app's SPA fallback deliberately leaves that path alone.) The
server applies its widened CSP to the app: `img-src` gains `https:`
(model-rendered remote images), `connect-src` is pinned to the request's
`ws`/`wss` origin, and `worker-src`/`'wasm-unsafe-eval'` admit the local speech
engine. In dev, Vite proxies `/api` and `/ws` to `localhost:54321`, so the app
dials the same same-origin URLs as in production (`src/wsUrl.ts`).

## Source layout

- `src/main.tsx` — React bootstrap.
- `src/App.tsx` — sign-in gate, then the page the path names (#90 phase 6a).
- `src/router.ts` — the app's paths (`/` dashboard, `/chat`, `/timers`, `/reminders`, `/notifications`), `routeForPath`, and the store that follows `window.location` (`currentRoute`/`subscribeRoute`/`navigate`, plus the `interceptsNavigation` click rule); `src/AppLink.tsx` is the `<a href>` that claims a plain left click and swaps the view without a reload, and `src/hooks/useRoute.ts` reads the store with `useSyncExternalStore`.
- `src/AppShell.tsx` — the signed-in app: the app-level state (socket, transcript, audio, notifications, prefs, jobs, and since 6d the microphone, the location share and the one turn runner both the composer and a wake match submit through), the settings panel, and the switch that renders the page the address names. Everything here has to outlive a route change, and the socket is the load-bearing example.
- `src/appState.ts` — the type a view receives from the shell (types only, so a view never imports its own parent).
- `src/clock.ts` — `clockText` / `formatDate` / `weekdayText` / `describeSpan`: time in the words a person reads, hand-rolled so the tests are exact and shared so a reminder and a job cannot disagree.
- `src/jobs.ts` — the repeat control's logic (#90 phase 8e): `RepeatDraft` + `repeatDraftToRule` (the form's choices turned into the rule, anchored at the moment the picker holds) + `repeatDraftFromRule` (a stored rule read back into the controls, so opening an edit cannot change it) + `checkRepeatDraft` + `repeatText` (the row's clause, the protocol's words verbatim) + `nextRepeatAt` (the live preview, through the server's own `nextOccurrence`). Beside them, the jobs list as the dashboard reads it (`upcomingJobs`: owed rows by `runAt`; `describeRunAt`: "in 4 minutes" / "at 8:00 AM" / "tomorrow at 8:00 AM"; `formatCountdown`: a timer's remaining time as `hh:mm:ss`; `runDuration`: a single attempt's length in ms / seconds / the usual span, since a tool job's run is not measurable in whole minutes).
- `src/hooks/useJobs.ts` — the caller's jobs: one read for the app, polled while the tab is visible and re-read on becoming visible, plus a `refresh` the shell calls when a `jobId` frame arrives. The read asks for settled rows too (`includeSettled`, the server's maximum page — its page is newest-created first, so a settled-only read is not expressible, and retention caps a user's table below the limit), and `jobs.ts`'s `splitJobs` divides it into what is owed and what is history, so a page gets both without a second request. The hook is also where a create or an edit happens (#90 phase 7): `create`/`update` return the server's `{job, quiet}` or its refusal in its own words, for the form that is still open behind the dialog.
- `src/views/app/NavBar.tsx` — the top bar: wordmark (home), the four pages, the unread badge (on whichever of the link and the hamburger is showing), the state chips — connection, microphone, location — each present only when it has something to say, the account name (in the corner on wide screens, at the top of the drawer on narrow ones), the settings gear, and the hamburger drawer under 60rem — its own measured breakpoint, where the links and the gear become drawer items.
- `src/views/app/IconRail.tsx` — the wide-screen navigation rail: the same destinations as a column from 80rem, each an icon beside its word (or the icon alone when **Navigation labels** is off), with the unread badge on the icon's corner and Admin past a hairline. Every item carries an `aria-label` and a `title` as well, so the icon-only mode is still named.
- `src/views/app/Settings.tsx` — the settings panel (#143), a native modal `<dialog>`: the account's notification preferences beside this browser's own controls, saying which is which, and an **Appearance** group holding the three per-browser switches — background particles, frosted glass, and navigation labels (hidden below the rail's 80 rem breakpoint, where it would drive nothing). The gear in the bar opens it from any page (#90 phase 6d).
- `src/views/app/TimerRing.tsx` — the ring a fired `timer` gets (#90 phase 4): a modal `<dialog>` with **Stop** as its one exit, so it covers anything else in the top layer without a z-index race.
- `src/views/app/HoldToDelete.tsx` — the press-and-hold destructive control (#157): a trash button whose red ring fills clockwise over three seconds and fires `onDelete` only when it closes; an early pointer/key release, a scroll (`pointercancel`), blur or unmount cancels. The circle is the whole control — `styles.css` clears the shared `.icon-btn` square chrome around it. `scheduleHold` is the cancellable timer the node-only suite tests, so the ring and the deletion cannot drift apart.
- `src/views/app/Toast.tsx` — the floating notification **stack** (up to `TOAST_LIMIT` cards, newest first): the banner's words and actions, fixed in a corner on every page. The card reuses the banner's classes on purpose, so the two cannot drift apart.
- `src/views/app/Dashboard.tsx` — the page at `/`: a ticking clock (a leaf, so 1 Hz never re-renders the app) whose colon blinks once a second (`clockParts` + a CSS animation, off under `prefers-reduced-motion`), "coming up" from `useJobs`, and the unread count. Links into the pages that manage each.
- `src/views/app/NotificationsPage.tsx` — `/notifications`: the notification class whole. **Scheduled** (since 7d) is the class's pending work — the model's `scheduleTask` jobs and any note written here via **New note** — with Edit/Cancel on the shared `JobRow` and the form's quiet note; it and its heading appear only when something is owed, so a normal day is still one list. **Recorded** is every row the server has filed with the actions it allows (Mark read · Dismiss · Snooze) — where Dismiss _deletes_ the row (#90 phase 9c: the user is finished with it), so the list is what they still have rather than a history with tombstone states and the dev-only test button. A recorded row that knows its `jobId` offers **Runs** (`JobRuns.tsx`), which is where the answer to "what did it actually do?" lives; the **Scheduled** half gets the same disclosure on every row through `JobRow` (#90 phase 8f). "Snoozed until 7:00 PM" is `snoozeUntil` + `describeSnooze`, the join through the row's `jobId`. An answerable row (#180) fetches its job's structured questions and renders `CodingQuestionForm` in the card's footer, falling back to the free-text box for a job with none.
- `src/views/app/JobsPages.tsx` — `/timers` and `/reminders`: the same list twice, filtered by class, with New/Edit (the shared `JobForm`), Cancel, Snooze (a reminder's), the server's quiet-hours line after a save, and a collapsed **Recent** history of that class's settled rows — `cancelled` included, since a cancelled job leaves no notification record anywhere else. Both halves carry the row's own **Runs** disclosure (8f), which for a one-shot a gate declined is the only place its story exists. The row itself is `JobRow.tsx`.
- `src/views/app/JobRuns.tsx` — a **Runs** disclosure (#90 phases 7d, 8f): what the job actually did, attempt by attempt (state, duration, the result text, or the error), mounted on the first open so a page of history costs one request per row the user asked about rather than per row on screen. Since 8f it hangs off the **job row as well as a recorded notification** — the job's own history is the only place a gated firing exists, because one whose check found nothing changed announces nothing — and a `skipped` attempt reads as just that with the gate's answer under it (`describeRun` in `src/jobs.ts`: "checked: front door: closed"), which is the reason it produced nothing. An empty list is a normal answer too (#90 phase 9b): a plain recurring reminder keeps no per-firing rows, so the disclosure reports the count the job row carries (`emptyRunsNote`) rather than claiming nothing was recorded.
- `src/presentation.ts` — the unified presentation of a job or a notification (#156): one pure `Presented` shape (`kind`, `primary`, `title`, `body`, `details`, `countdown`) per class, so every surface reads the same hierarchy. A timer's primary fact is its remaining time (`formatCountdown`, `countdown: true`), a reminder's is its moment, a notification's message is its title with the body carried separately to render as Markdown. `presentJob`/`presentNotification` are the only place the "which fact leads" decision lives.
- `src/views/app/Row/` — the shared row components that render `presentation.ts`: `JobCard.tsx` (the job pane, and the dashboard's compact line; the timer's countdown is its own half-width block), `NotificationCard.tsx` (a record, body through `Markdown`), `ClassChip.tsx` (the class eyebrow), `Countdown.tsx` (the timer's live `hh:mm:ss`, ticking via `useClock`), and `RowActions.tsx` (a row's actions folded into one `⋯` **popover**, so the primary fact keeps the width and nothing paints over the menu).
- `src/views/app/JobRow.tsx` — one owed job, as every page that lists them shows it: it renders `JobCard` (whose words and hierarchy are `presentation.ts`) and owns only what the job's state and class allow — the actions in a single `⋯` (`RowActions`) rather than a button bar, the Snooze menu when the caller passes `onSnooze`, and the job's own **Runs** disclosure (#90 phase 8f — a gated job's declined firings are visible nowhere else). Shared rather than copied so the Timers, Reminders and Notifications pages cannot disagree about what a job says.
- `src/views/app/JobForm.tsx` — the create/edit form (#90 phases 7, 8e), a modal `<dialog>` mounted while it is open (so a fresh mount is a fresh form): a **Repeats** row (chips for Never/Daily/Weekdays/Weekly/Monthly, then the fields that choice needs — an interval, the weekday toggles, the monthly day-or-ordinal, an end by count or date — and a live line reading the cadence with when it next fires, both from the protocol's own `describeRepeat`/`nextOccurrence`, so the preview cannot disagree with the server), plus — a timer is created by a length, everything else by a moment, and an edit always by a moment. Its decisions — the duration↔instant maths, the `datetime-local` round trip, the bounds, and the "only send what moved" patch — all live in `src/jobs.ts` and are asserted there, because this package's suite renders no components.
- `src/views/app/SnoozeMenu.tsx` — the snooze control: one button, and its three presets in a **popover** menu, placed through the shared `src/hooks/usePopoverMenu.ts`. A popover because the toast is a scrolling column and a menu inside it was clipped by the column's edge; the top layer cannot be clipped by an ancestor, and the platform brings Escape and light-dismiss with it — including the rule that the toggle's `popoverTarget` (not a handler calling `togglePopover`) is what lets a second press close it, since light dismiss fires on pointerdown. Since #156 the `⋯` row menu is a popover too, so the two close each other (one `popover="auto"` open at a time); both are rendered in this suite (`react-dom/server`, no DOM), because a missing `popover` or a missing invoker is invisible to a pure test and reports as "always open" or "does nothing".
- `src/popover.ts` — where a floating menu hangs from its toggle: below it, right-aligned, flipped above when the room below is gone, clamped to the viewport. Pure and tested, because a popover is centred unless measured and every way this can be wrong is silent (off-screen on a short window, half over the edge on a narrow one).
- `src/snooze.ts` — the client's half of a deferral: one job call (which settles the announcement server-side too), then the local settle plus a re-read of the list for the surfaces that never held the row.
- `src/hooks/useClock.ts` — the ticking clock a leaf owns (`useClock`), so the dashboard's 1 Hz and a list's countdown never re-render the shell.
- `src/hooks/usePopoverMenu.ts` — the state and placement one floating menu needs (#156): a stable `menuId`, the open flag from the popover's own `toggle` event, the toggle/menu refs, and the measurement through `src/popover.ts` (re-placed on scroll/resize while open). Shared by `SnoozeMenu` and `RowActions` so the two popovers stay identical — and, because both are `popover="auto"`, mutually exclusive without either knowing the other exists.
- `src/api.ts` — typed REST client (login, session list/delete, notification list/read/dismiss/answer, coding-job questions, jobs list/detail/create/edit/cancel/snooze, prefs read/patch; Bearer token). `answerNotification` sends `{ answers }` for a structured set and `{ answer }` for the legacy text path; `getCodingJobQuestions` is the app's read of a parked job's questions and recorded answers.
- `src/credentials.ts` — per-user localStorage credential store.
- `src/threads.ts` — client-side transcript store (pure helpers + persistence).
- `src/ChatClient.ts` — event-driven `/ws` wire client (incl. `sendLocation`, #31; binary audio decode, #83; `cancelTurn` + dropped-generation audio filtering, #84 P6; out-of-turn `notification` frames via `onNotification`, #139).
- `src/location.ts` — geolocation consent + request plumbing (#31).
- `src/voice.ts` — voice-controller wiring + STT engine selection (Web Speech first, Vosk WASM fallback — #84 P3b) and the wake-word helpers (`createWakeWord`, `createWakeStt`, `probeWakeSupport`, wake pref — #84 P4); the controller lives in `packages/voice`.
- `src/audio.ts` — spoken-response playback queue (WebAudio, #83) + wake cue (`blip`, #84 P4).
- `src/debug.ts` — the `jarvis.debug`-gated console sink (scopes: voice, ws).
- `src/voiceTrace.ts` — the opt-in raw-vs-submitted transcript trace (#121), a separate switch from `debug.ts` because it prints real speech.
- `src/dev/VoiceHarness.tsx` — the offline replay harness (#121, `?voice-harness=1`), lazily imported.
- `src/safeHref.ts` — link protocol allowlist.
- `src/Markdown.tsx` — GFM renderer with hardened links/images.
- `src/views/Login.tsx`, `src/views/Chat.tsx` — the sign-in gate and the chat page (`/chat`). `Chat.tsx` renders the conversation: its sidebar rows (`useSessions`), the transcript, the composer, and the error/wake/voice status lines — the turn itself is the shell's `runTurn`, and the gear and the panel it opens are the shell's too (#90 phase 6d).
- `src/views/chat/` — the presentational chat components (#109): `Sidebar.tsx` (whose row delete is the `HoldToDelete` gesture, #157), `Transcript.tsx` (memoized message rows + auto-scroll), `Composer.tsx` (draft, focus, paste/drop, mic/attach/send), `PendingAttachments.tsx`.
- `src/hooks/useJobRuns.ts` — one job's attempts, read when a record asks (#90 phase 7d): `loaded` with the runs, `gone` for the 404 a _stale_ link gets (the schema nulls a record's `job_id` when its job is pruned, so only a list read before the prune can ask after something that is gone), `error` for anything else. Mounted only once a disclosure is open, because a `<details>` renders its children either way and a naive one would fire a request per record on every visit.
- `src/hooks/useJobPage.ts` — a job page's form lifecycle (#90 phase 7): which object the form has open, the line the last save left (the server's quiet-hours forecast), and the transitions between them. One copy, because three pages open the same form and a second would be the place they disagreed about what "saved" means.
- `src/hooks/` — the hooks (#109): `useThreads` (transcript reducer + persistence), `useSessions`, `useAudio`, `useChatClient` and `useVoiceSession` (each constructs its socket/controller in a mount effect so React StrictMode's double-invoke yields a live instance), `useLocationSharing`, `useAttachments`, `useNotifications` (#139 list state + REST), `useBrowserNotify` (#139 phase 2 OS announcements), `usePrefs` (#143 account prefs read/patch), `useJobs` (#90 job list), `useClock`, `useRoute`, `useAutoScroll`.
- `src/notifications.ts` — pure notification-list helpers (#139): merge a pushed frame with the fetched page by id, settle locally, pick the banner, count unread. Since #180 it also carries the client-side `CodingQuestion` / `CodingJobQuestion` / `CodingAnswer` shapes the answer form reads.
- `src/codingAnswers.ts` — the pure half of the structured answer form (#180): `emptyCodingDraft` prefills from recorded answers, `codingDraftComplete` enforces required questions and Other text, and `codingAnswersFromDraft` produces the `answers` payload.
- `src/views/app/CodingQuestionForm.tsx` — the one-control-per-question form (#180): textarea, radio group, checkbox group, optional Other, and the **Send answers** submit; the page owns the request so a refusal keeps the draft.
- `src/views/app/CodingQuestions.tsx` — the settled **Questions and answers** disclosure (#180): reads the job's question route and renders each question with its answer (option labels and Other text), so the record survives the answer summary.
- `src/prefs.ts` — pure account-preference helpers (settings panel): read `notify.enabled`/`notify.quietHours` the way the server does (an unreadable stored value reads as not in effect, flagged rather than hidden), validate a typed window, and build the one-key patches the panel writes.
- `src/browserNotify.ts` — pure desktop-notification rules (#139 phase 2): the announce decision (hidden tab, unsettled, not already announced, preference _and_ permission), the toggle's UI state, and this browser's stored preference.
- `src/sidebar.ts` — sidebar-row merge (`mergeSessions`) + wake/location label helpers.
- `src/attachments.ts` — attachment chip lifecycle + upload/retry helpers (#10).
- `src/components/ToolCall.tsx` — collapsible tool/toolResult notices.
- `src/wsUrl.ts` — derives the page-origin `ws(s)://…/ws` URL.
- `src/styles.css` — shell styling.
- `scripts/copy-voice-assets.mjs` — stages the ORT/openWakeWord runtime assets into `public/ort/` (#84 P4).
