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
portal is a _different app_ on the real server, and the launcher links to it —
without the proxy, the dev server would answer `/admin` with _this_ app's shell,
which renders the launcher (an unknown path), so the link would look like it
went nowhere while production was perfectly correct. Anything else under `/`
is this app, on every path it names (Vite's SPA fallback).

## Pages

Real paths, not hash routes (#90 phase 6a): the server's SPA fallback replays
`index.html` for any non-`/api` GET, so a deep link and a reload both work
without a route on the server, and a URL reads as the page it names. The admin
portal is a different app at `/admin` and keeps its own hash router.

| Path             | Today                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `/`              | The launcher: links to the app's pages (a dashboard replaces it)       |
| `/chat`          | The conversation                                                       |
| `/timers`        | A placeholder — the list lands with the pages phase                    |
| `/reminders`     | A placeholder — likewise                                               |
| `/notifications` | A placeholder — likewise                                               |
| anything else    | The launcher (a typo or an old link gets the front door, not an error) |

In-app links are `AppLink`s over the store in `src/router.ts`: a click swaps the
view with `history.pushState` instead of reloading the document, so Back and
Forward behave and a modified click still opens a real tab (every path replays
the shell, so that tab works). Keeping the `/ws` socket connected _across_ a
swap needs the shell that owns it — that, with the dashboard, is the rest of
phase 6b.

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
browser remembers). The location pin lives in the **settings panel** under
"This browser" (#143) and is the visible opt-out (persisted in localStorage —
an explicit "0" suppresses sharing). While sharing is on but not delivering,
the sidebar says so in a word beside the gear (`Locating…` / `Location denied`
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
The view renders the snapshot and forwards server frames (`noteResponseFrame`)
through `useChatClient`'s frame handler. No behavior lives only in a component.

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
openwakeword-web running under the WASM STT engine's runtime). While armed,
the sidebar shows a blinking microphone beside the gear, because an open
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
#114) or the player still has audio scheduled, the view arms the voice
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

The surface is a banner for the newest unsettled notification plus a
collapsible list with a badge, rendered inside the conversation column
(`src/views/chat/Notifications.tsx`) so a notification cannot be missed while
the sidebar is collapsed. Reading or dismissing is optimistic — the list
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

| Row                                       | Surface                                              | Sound                                      | Exit                                                   |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `timer`, `job.finished`                   | the modal ring overlay                               | a three-tone chime every 3 s until stopped | **Stop**                                               |
| `reminder`                                | the banner                                           | none                                       | Dismiss (snooze waits for phase 5's jobs REST surface) |
| `notification` (incl. agent requests)     | the banner                                           | none                                       | Mark read · Dismiss                                    |
| `timer` that **failed** or was **missed** | the banner, labelled `Timer failed` / `Timer missed` | none                                       | Mark read · Dismiss                                    |

Rules worth knowing, all pure and pinned by tests:

- The ring target is the **oldest** fired timer, so two timers queue instead of
  shouting over each other; when one is stopped the next takes over, and the
  ring loop is idempotent so the hand-over does not restart the pattern.
- The ring target is never also the banner: a firing timer appears in exactly
  one place.
- Only a timer that **actually fired** rings. A failed or missed one has nothing
  due, and an overlay whose Stop button stopped nothing would misrepresent what
  the user is acknowledging.
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

A gear in the sidebar head opens a settings panel holding the controls that
used to sit as four icon buttons beside the account name (location, wake word,
desktop notifications, sign out). It is a native `<dialog showModal()>` — so
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
whole map; quiet hours are switched off by writing `null`; and the badge over
the gear is an _addition_ to the badge on the notification list, not a
replacement, so nothing depends on the sidebar being on screen.

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
- `src/router.ts` — the app's paths (`/` launcher, `/chat`, `/timers`, `/reminders`, `/notifications`), `routeForPath`, and the store that follows `window.location` (`currentRoute`/`subscribeRoute`/`navigate`, plus the `interceptsNavigation` click rule); `src/AppLink.tsx` is the `<a href>` that claims a plain left click and swaps the view without a reload, and `src/hooks/useRoute.ts` reads the store with `useSyncExternalStore`.
- `src/views/Home.tsx` — the interim launcher at `/`: links to the app's pages, and the note that a dashboard replaces it. No widgets on purpose — a dashboard needs the shell that owns the socket and the notification state.
- `src/views/PagePlaceholder.tsx` — a page that exists as an address but not yet as content (`/timers`, `/reminders`, `/notifications`).
- `src/api.ts` — typed REST client (login, session list/delete, notification list/read/dismiss, prefs read/patch; Bearer token).
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
- `src/views/Login.tsx`, `src/views/Chat.tsx` — the sign-in gate and the chat page (`/chat`). `Chat.tsx` is the composition root: it keeps the chat-turn orchestration (`runTurn`/`send`/`remove`/sign-out/wake-arm) and wires the socket frames to the reducer, over the hooks below and `src/views/chat/*`.
- `src/views/chat/` — the presentational chat components (#109): `Sidebar.tsx`, `Transcript.tsx` (memoized message rows + auto-scroll), `Composer.tsx` (draft, focus, paste/drop, mic/attach/send), `PendingAttachments.tsx`, `Notifications.tsx` (#139 banner + list), `Settings.tsx` (#143 panel: account prefs beside this browser's controls).
- `src/hooks/` — the chat hooks (#109): `useThreads` (transcript reducer + persistence), `useSessions`, `useAudio`, `useChatClient` and `useVoiceSession` (each constructs its socket/controller in a mount effect so React StrictMode's double-invoke yields a live instance), `useLocationSharing`, `useAttachments`, `useNotifications` (#139 list state + REST), `useBrowserNotify` (#139 phase 2 OS announcements), `usePrefs` (#143 account prefs read/patch), `useAutoScroll`.
- `src/notifications.ts` — pure notification-list helpers (#139): merge a pushed frame with the fetched page by id, settle locally, pick the banner, count unread.
- `src/prefs.ts` — pure account-preference helpers (settings panel): read `notify.enabled`/`notify.quietHours` the way the server does (an unreadable stored value reads as not in effect, flagged rather than hidden), validate a typed window, and build the one-key patches the panel writes.
- `src/browserNotify.ts` — pure desktop-notification rules (#139 phase 2): the announce decision (hidden tab, unsettled, not already announced, preference _and_ permission), the toggle's UI state, and this browser's stored preference.
- `src/sidebar.ts` — sidebar-row merge (`mergeSessions`) + wake/location label helpers.
- `src/attachments.ts` — attachment chip lifecycle + upload/retry helpers (#10).
- `src/components/ToolCall.tsx` — collapsible tool/toolResult notices.
- `src/wsUrl.ts` — derives the page-origin `ws(s)://…/ws` URL.
- `src/styles.css` — shell styling.
- `scripts/copy-voice-assets.mjs` — stages the ORT/openWakeWord runtime assets into `public/ort/` (#84 P4).
