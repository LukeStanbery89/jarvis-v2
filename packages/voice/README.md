# @lukestanbery/jarvis-voice

Shared voice-input abstractions for J.A.R.V.I.S. clients (issue #84). Three
halves, deliberately independent:

- **Provider seam** (`src/types.ts`) — `SttProvider` (what did they say),
  `WakeWordProvider` (are they addressing J.A.R.V.I.S.), `VadProvider` (is
  someone speaking). Engines are swappable behind these; nothing here knows
  about conversations, sockets, or protocol frames.
- **Session lifecycle state machine** (`src/lifecycle.ts`) — a pure reducer
  (`reduceVoice`) that owns the whole interaction: press/wake through
  transcript submission through response playback, one explicit state at a
  time.
- **Controller** (`src/controller.ts`) — the imperative orchestrator
  (`VoiceController`) that drives engines through the state machine: mic
  presses, endpointing, transcript submission, and response-frame
  forwarding. React- and transport-free, so every voice client reuses it.

Zero mandatory runtime dependencies, CommonJS, browser- and Node-safe. The
Web Speech STT provider, the local WASM STT provider (Vosk), and the energy
VAD ship here (phases 2–3, consumed by `packages/web`). The WASM engine's
one dependency (`@lichess-org/vosk-browser`) is declared as a **peer
dependency** and loads lazily at first `start()` — the package never
imports it at module scope, so node consumers and tests are unaffected.

## Install

```sh
npm install @lukestanbery/jarvis-voice
```

## Scripts

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`      |
| `npm run typecheck` | Type-check src and tests (no emit) |
| `npm test`          | Run the test suite (Vitest)        |

## Lifecycle

```text
idle ──activate──► listening ──endOfSpeech──► transcribing
  ▲                   │  ▲                        │
  │     noSpeech/fail │  │ userSpeech (barge-in)  │ transcript
  └───────────────────┘  │                        ▼
                         │                   submitting
                         │                        │
                         │                   submitted
                         │                        ▼
                         │            waiting ◄───┘
                         │              │ responseStarted
                         │              ▼
                         │          responding ──audioStarted──► speaking
                         │              │ responseEnded            │
                         └──────────────┴──────────────────────────┘
```

States: `idle`, `listening`, `transcribing`, `submitting`, `waiting`,
`responding`, `speaking`. `responding` (text streaming) is distinct from
`speaking` (TTS audio playing) so a text-only voice turn never lies about
audio.

The reducer is pure: hold the latest `VoiceSnapshot`, feed it `VoiceEvent`s,
render from the result. There is no hidden state and no I/O — callsite logging
(via `@lukestanbery/jarvis-logger`) is the caller's job.

## Controller (endpointing)

`VoiceController` is the imperative half of the interaction: it arms the
engine and VAD, feeds their events into the reducer, accumulates the
transcript, and submits the turn. Client UIs render from
`controller.getSnapshot()` (an external store — `useSyncExternalStore` in
React) and call `press()` / `noteResponseFrame()` / `noteAudioStarted()` /
`dispose()`.

Endpointing — who decides "the user stopped talking" — is phase 3's
deterministic answer:

- **With a `vad`** (`VadProvider`), the controller owns endpointing. The
  engine is started `{ continuous: true }` so it never finalizes on its own
  pause detection; final segments arrive while speech continues and are
  accumulated. The VAD's `onSpeechEnd` arms an `END_OF_SPEECH_MS` (800 ms)
  timer — expiry enters `transcribing`, flushes the engine (`stt.stop()`),
  and submits the accumulated transcript. A manual press during the same
  silence window routes through the identical pipeline. Speech resuming
  inside the window cancels the timer (the user was not done talking).
- **Silence is quiet.** A press with no detected speech ends after
  `NO_SPEECH_MS` (4 s — deliberately under the browser engines' own ≈8 s
  no-speech error) via `stt.cancel()` (no callbacks fire) and the reducer's
  `noSpeech` event: back to `idle` with no error banner.
- **Without a `vad`** (unsupported runtime), behavior is the engine's own:
  it finalizes on its silence detection, a second press stops-and-flushes,
  and no timer is ever armed — identical to phase 2.

Timer seams (`schedule`/`unschedule` options) are injectable, so tests fire
expiries by hand; the controller never reads a real clock.

### Design rules

- **Session ids kill races.** `activate`/`userSpeech` open a new session
  (id + 1); every recognition, submission, and response event is tagged with
  the session it belongs to. Events from a stale session are ignored, so a
  late transcript or a dying response-generation cannot disturb the
  interaction that replaced it.
- **Empty transcripts never submit.** A blank `transcript` event leaves the
  session where it is.
- **Ignores, not throws.** An illegal event returns the same snapshot by
  identity (`next === prev`), so out-of-order delivery is harmless by
  construction.

## Usage

```ts
import { initialVoiceSnapshot, reduceVoice } from "@lukestanbery/jarvis-voice";
import type { SttProvider } from "@lukestanbery/jarvis-voice";

let snapshot = initialVoiceSnapshot;

// A provider reports events through per-session callbacks; the UI forwards
// them into the reducer, tagging each with the session it belongs to.
snapshot = reduceVoice(snapshot, { type: "activate" });
sttProvider.start({
    onPartial: (text) => {
        snapshot = reduceVoice(snapshot, {
            type: "partial",
            sessionId: snapshot.sessionId,
            text,
        });
    },
    onResult: (text) => {
        snapshot = reduceVoice(snapshot, {
            type: "transcript",
            sessionId: snapshot.sessionId,
            text,
        });
    },
});

// In "submitting", submit snapshot.transcript as an ordinary
// `mode: "voice"` prompt; response frames map to submitted/responseStarted/
// audioStarted/responseEnded, an error frame to `rejected`.
```

Only `submitting`'s `transcript` may become a user message; `partial` text is
for live UI display and nothing else.

## Browser provider (Web Speech)

`createBrowserStt()` returns a `WebSpeechSttProvider`, or `null` when the
runtime has no recognition engine (Firefox; any non-secure context — the
HTTPS-or-localhost rule the geolocation feature shares). The provider
honors the full `SttProvider` contract:

- partials and finals are trimmed; an empty final is _no transcript_, and a
  session that ends without one reports `no-speech`;
- `stop()` flushes (final delivery then settlement), `cancel()` aborts and
  guarantees no callback fires after it resolves;
- engine errors map to `no-speech` / `permission-denied` / `engine`;
  the engine's own `aborted` code is ignored (cancellation has its own
  path, and a cancelled session delivers nothing);
- events from a previous session are dropped by id, so a late engine
  callback after a re-start cannot leak.

Chrome's Web Speech recognition is cloud-backed (audio egress) — accepted
for phase 2, documented in the web client's README; the local WASM provider
below is the private path.

## Browser provider (Vosk WASM)

`createVoskStt()` returns a `VoskSttProvider` (id `vosk-wasm`), or `null`
when the runtime lacks mic access, Web Audio, or WebAssembly. Recognition
runs fully on-device: Kaldi compiled to WASM, driven through a module Web
Worker by `@lichess-org/vosk-browser` — the maintained fork of
ccoreilly's vosk-browser, rebuilt **CSP-safe** (its Emscripten runtime
defines classes without `new Function`, so it runs under a strict
`script-src 'self'`; the worker script + WASM binary are served as
same-origin SPA assets) — no audio egress, and it works where Web Speech
does not (Firefox, any secure-context browser). The engine contract maps
like this:

- the model archive (~40 MB `tar.gz`) loads lazily at the first `start()`
  from a configurable URL (default: the J.A.R.V.I.S. server's
  `GET /api/stt/model`), and the worker persists the extracted model in
  IndexedDB, so the archive travels once per browser;
- the mic runs through its own echo-cancelled track into an
  `AudioContext` → `ScriptProcessorNode` chain (zero-gain hop keeps the
  node pulled without echoing the mic to the speakers), feeding
  `acceptWaveformFloat` at the context's sample rate — vosk resamples
  internally;
- `partialresult` → `onPartial` (trimmed, non-empty); per-utterance
  `result` finals → `onResult`: in continuous capture every final is a
  segment the controller accumulates, without it the first final is the
  transcript and the session settles right after (mirroring Web Speech);
- `stop()` flushes: capture stops feeding, `retrieveFinalResult()` forces
  the engine to finalize its pending audio, the text lands on `onResult`,
  and the session settles. A continuous session settles silently when the
  flush produced nothing (the controller owns the quiet no-speech path);
  an engine-native session reports `no-speech` instead;
- `cancel()` discards (mic released, recognizer freed, no callbacks after
  it resolves); stale worker messages are dropped by session id;
- the model outlives sessions; the optional `dispose()` seam (phase 3b
  added it to `SttProvider`) terminates the worker and drops the caches
  when the client will never recognize again.

## Browser provider (VAD, energy)

`createBrowserVad()` returns a `BrowserVadProvider`, or `null` when the
runtime lacks Web Audio + mic access (the same HTTPS-or-localhost rule the
STT provider shares). It opens its own echo-cancelled `getUserMedia` track,
feeds an `AnalyserNode`, and runs a two-edge energy state machine at a
fixed cadence: loudness sustained past `onsetMs` (default 120) fires
`onSpeechStart`; silence sustained past `releaseMs` (default 350) fires
`onSpeechEnd`. `stop()` is idempotent and guarantees no callback fires
after it resolves; `start()` rejects (rather than erroring the session)
when the track or context cannot be established, so the controller degrades
to engine-native endpointing instead of surfacing a failure.

This is the energy-detector MVP (id `browser-energy`): robust for
headset/quiet-room use, flaky in noisy rooms. A model-backed engine (e.g.
Silero WASM) can replace it behind the identical `VadProvider` seam without
touching any client.

## Traceability

Phase 1 of the [voice-input issue](https://github.com/LukeStanbery89/jarvis-v2/issues/84):
the provider interfaces and lifecycle this package ships are the units of
work its P1 acceptance criteria name; the Web Speech provider is P2, and
phase 3 lands here too — the energy VAD plus VAD-owned endpointing in the
controller (the orchestrator itself moved from `packages/web` in P3 so any
future client reuses it) and the local WASM STT provider (P3b — Vosk,
with the optional `dispose()` seam it added). Later phases: wake-word
look-back buffering in the provider layer, and a Whisper-class engine
benchmarked behind the same seam before any default changes.

## Notes for maintainers

- Zero mandatory runtime dependencies, so this package never needs a
  rebuild-then-check ordering like `@lukestanbery/jarvis-logger` consumers
  do; `@lichess-org/vosk-browser` is an optional peer the browser client
  provides.
- The state machine readme diagram mirrors the module doc in
  `src/lifecycle.ts`; keep them in step.
