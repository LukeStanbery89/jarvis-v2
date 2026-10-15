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
  presses, opening and tearing down sessions, and response-frame forwarding.
  React- and transport-free, so every voice client reuses it.

Feature machines sit beside the controller (issue #110), each over the
shared `src/core.ts` (`VoiceCore`) context and each owning its own
interlocks, so the controller is their composition root rather than their
storage:

- `src/session.ts` — `VoiceSession` + `END_OF_SPEECH_MS`/`NO_SPEECH_MS`/
  `MAX_COMMAND_MS`: owns one recognition session's endpointing (VAD-owned,
  detector-fed, or engine-native), transcript accumulation, wake-phrase
  stripping, and submission. The controller creates one per `begin()` and
  delegates every engine/VAD callback to it.
- `src/wake.ts` — `WakeManager`: arms the detector, keeps it capturing through
  a wake session (so the command arrives on its own microphone), pre-warms the
  wake engine, and restarts the detector once a session lands `idle`.
- `src/barge.ts` — `BargeWatch` + `BARGE_IN_*`: the VAD-only barge-in watch and
  its look-back ring. `BargeInDetection` and the `BARGE_IN_*` constants are the
  only public symbols from here.
- `src/errors.ts` — `toVoiceError`, the shared rejection normalizer.
- `src/wav.ts` — a dependency-free WAV codec (`encodeWav`/`decodeWav`) used
  by the #121 corpus: the fixtures, the debug capture path, and the replay
  harness all move audio as WAV bytes.
- `src/providers/internal.ts` — shared provider scaffolding (#107): the
  structural `MediaStream`/`MediaDevices` slices, the `globalThis` lookups
  (`findUserMedia`/`findAudioContextCtor`), stream teardown
  (`releaseStream`), the `{ code, message }` error builder (`voiceError`),
  the permission-denied mapping (`micError`), the shared mic-open prologue
  (`openMicContext`), and track-end wiring (`wireTrackEnded`). Internal to
  the package — not re-exported from `src/index.ts`.

Zero mandatory runtime dependencies, CommonJS, browser- and Node-safe. The
Web Speech STT provider, the local WASM STT provider (Vosk), the energy VAD,
and the openWakeWord wake-word provider ship here (phases 2–4, consumed by
`packages/web`). The WASM engine's one dependency
(`@lichess-org/vosk-browser`) is a **peer dependency** that loads
lazily at first `start()` — and the wake detector's
(`openwakeword-web`, which pulls in `onnxruntime-web`) are **optionalDependencies** — the
package never imports them at module scope, so node consumers and tests are
unaffected.

## Install

```sh
npm install @lukestanbery/jarvis-voice
```

## Scripts

| Script              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`                  |
| `npm run typecheck` | Type-check src and tests (no emit)             |
| `npm test`          | Run the test suite (Vitest)                    |
| `npm run fixtures`  | Regenerate the #121 audio corpus (macOS `say`) |

The `#121` wake→command corpus lives in `test/fixtures/`: synthesized WAVs plus
`real/` recordings (the same shapes in a real voice, committed for tests), and
a gitignored `local/` scratch area. See `test/fixtures/README.md`.

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

## Session (endpointing)

`VoiceController` is the imperative half of the interaction: it arms the
engine and VAD, opens a `VoiceSession` for each `begin()`, and reaches each
one's events into the reducer. Client UIs render from
`controller.getSnapshot()` (an external store — `useSyncExternalStore` in
React) and call `press()` / `noteResponseFrame()` / `noteAudioStarted()` /
`dispose()`.

`VoiceSession` (in `src/session.ts`) owns everything that lives for exactly
one recognition session — the engine/VAD callbacks, the "pause ⇒ send" and
"press with silence" timers, the accumulated final segments, and the
transcript's submission — while `VoiceController` stays the composition root
that creates it. Endpointing — who decides "the user stopped talking" — is
phase 3's deterministic answer:

- **With a `vad`** (`VadProvider`), the session owns endpointing. The
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
- **A wake session** (`{ source: "external" }`, #121) has no VAD and no
  microphone of its own: its audio is the detector's live post-match frames,
  pushed in through `VoiceSession.pushCommandAudio` (held across the engine's
  open, so the command's opening survives a cold start). The engine endpoints
  on its own silence detection — an empty final is ignored, so a long pause
  between "Hey JARVIS" and the command cannot end it — bounded by the same
  `NO_SPEECH_MS` silence guard ("woke up and said nothing") and by
  `MAX_COMMAND_MS` (15 s), which flushes a command that never pauses.
- **Without a `vad`** (unsupported runtime), behavior is the engine's own:
  it finalizes on its silence detection, a second press stops-and-flushes,
  and no timer is ever armed — identical to phase 2.

Timer seams (`schedule`/`unschedule` options) are injectable, so tests fire
expiries by hand; the code never reads a real clock.

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
ccoreilly's vosk-browser rebuilt **CSP-friendly**: its Emscripten runtime
defines error classes without `new Function`, and the worker script + WASM
binary are served as same-origin SPA assets. Two CSP considerations remain
for the serving page:

- Wasm _compilation_ counts as eval to the CSP spec, so `script-src` needs
  the narrow `'wasm-unsafe-eval'` keyword (allows compile/instantiate,
  keeps JS `eval` banned);
- embind additionally _synthesizes per-method invoker functions_ with
  `new Function` on first call (`craftInvokerFunction`) — a second eval
  site the fork cannot remove. Approach: the worker entry script is served
  with **its own `Content-Security-Policy`** (`script-src 'self'
'unsafe-eval'`); for a dedicated worker whose entry script declares a
  CSP, that policy governs the worker scope instead of the owner's, so
  eval is scoped to the hashed, same-origin engine module and never
  reaches the page.

No audio egress, and it works where Web Speech does not (Firefox, any
secure-context browser). The engine contract maps like this:

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
- `start(callbacks, { source: "external", sampleRate })` runs **without a
  microphone**: the recognizer is created at the caller's rate and every
  sample arrives through `feed()` (#121 — the wake→command session and the
  offline replay harness both use it, so no rate flip ever recreates the
  recognizer mid-session). An external session is not continuous: the engine's
  own silence detection ends the utterance, and an empty final is ignored, so
  the pause between "Hey JARVIS" and the command cannot end it early;
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
`onSpeechEnd`. The onset gate is adaptive — `max(threshold, ambientFloor ×
noiseMargin)` — where `ambientFloor` follows only quiet ticks (so real
speech never raises it) and `threshold` (default 0.01) is the floor it can
settle to in a quiet room; this keeps soft post-wake-pause commands
starting a session while a raised ambient level still suppresses false
onsets. `stop()` is idempotent and guarantees no callback fires
after it resolves; `start()` rejects (rather than erroring the session)
when the track or context cannot be established, so the controller degrades
to engine-native endpointing instead of surfacing a failure.

This is the energy-detector MVP (id `browser-energy`): robust for
headset/quiet-room use, flaky in noisy rooms. A model-backed engine (e.g.
Silero WASM) can replace it behind the identical `VadProvider` seam without
touching any client.

## Browser provider (wake word, openWakeWord)

`createOpenWakeWord()` returns an `OpenWakeWordWakeProvider` (id
`openwakeword`), or `null` when the runtime lacks a secure context, Web
Audio, or an audio worklet. It is a client-side port of openWakeWord: at
`start()` it lazy-imports `openwakeword-web` (an optional dependency), downloads
the ONNX models it is registered for from `baseUrl` (default
`/api/wake/model/` — see the server's wake-model route), and opens a
16 kHz worklet microphone whose frames run through the continuously-running
feature pipeline. A phrase label passing threshold fires `onDetection`
(`{ pause: true }` keeps the one-shot).

Two properties make this provider slot into the controller's wake flow
(#84 P4, single-mic in #121):

- **Live command stream** — because the detector's microphone keeps running
  after a phrase fires, every frame **after** the match is handed straight to
  `WakeCallbacks.onCommandAudio` (16 kHz mono float PCM). The frame that
  crossed the threshold was only predicted, so the wake phrase is never part
  of the stream, and the frames are contiguous — so the controller runs the
  wake session's engine microphone-free over them (`{ source: "external" }`).
  Nothing is retained here, nothing is drained, nothing is spliced: a
  one-breath "Hey JARVIS what time is it" arrives whole.
- **Fire once, capture on** — `onDetection` fires at most once per `start()`,
  so prediction stops at the match while the microphone stays open for the
  command. The controller holds the detector open for the whole session
  (`WakeManager.beginCommand`) and restarts it when the turn lands `idle`
  (`maybeReArm` → stop + arm). `stop()` is idempotent, and no callback —
  match or command audio — fires after it resolves.

`stripWakePhrase()` (in `src/wakeText.ts`) removes a leading wake phrase
from a wake-session transcript ("Hey JARVIS" by default, ragged whitespace
and case tolerated) before display or submission. It is a **safety net, not
the mechanism** (#121): the session's audio is phrase-free by construction, so
this only catches a detector that fires mid-phrase or an engine that
hallucinates the phrase from silence.

### Wiring a wake detector (consuming package)

The controller arms/disarms the detector across sessions, so a client hands
it a **constructed** (cheap — nothing loads until `start()`) provider plus
a dedicated `wakeStt` engine:

```ts
new VoiceController({
    stt, // primary dictation engine
    wake, // WakeWordProvider (constructed, not running)
    wakeStt, // STT for wake sessions (the local one — the detector's
    // command audio must never leave the device)
    submit: (text) => submitTurn(text),
    onWakeCue: () => blip(), // optional sound when the phrase matches
});
// later: await controller.enableWake();  → detector arms, mic opens
//        await controller.disableWake(); → detector disarms, mic closes
```

`enableWake()` no-ops silently unless both a `wake` provider and a `wakeStt`
engine were supplied at construction. The snapshot's `wakeArmed` flag drives
the client's armed indicator; a `wakeFailed` lifecycle event surfaces as the
session error.

## Barge-in watch (#84 P6)

While J.A.R.V.I.S. speaks, `startBargeWatch()` arms a **VAD-only mic
session** on the same `VadProvider` sessions use for endpointing — no STT,
no transcript, no user toggle: the watch lives exactly as long as playback.
The client calls it when the lifecycle enters `speaking` and
`stopBargeWatch()` when it leaves. While armed, the watch taps the VAD's
optional raw-audio callback (`VadCallbacks.onAudio` — the energy VAD
delivers its analysis frames as a copy per tick) into a ring buffer capped
at `BARGE_IN_LOOKBACK_MS` (2000), and arms a sustained-speech deadline of
`BARGE_IN_SPEECH_MS` (300) on the VAD's speech-start; a speech-end inside
the window cancels it.

When the deadline fires, the controller:

1. steals the ring and disarms the watch (releasing the VAD — the session
   it is about to open needs it);
2. fires `onBargeIn({ lookback, lookbackSampleRate })` **once** — the
   client's half: stop local playback immediately (before any server round
   trip) and cancel the in-flight turn (`cancel` frame);
3. opens a listening session on the primary STT engine, replaying the
   look-back through `SttProvider.feed()` so the interruption's opening
   words survive the handoff.

The replaced turn's events are stale by session id the moment the new
session opens — the lifecycle's race discipline. The watch is
**opportunistic**: with no VAD, a busy VAD (a recognition session owns it),
a throwing `onBargeIn`, or a dying mic track it stays off or disarms
quietly — a turn that plays fine is never disturbed by a failed
interruption. Caveat: detection rides on the browser's echo cancellation
(`echoCancellation: true`); imperfect AEC on speaker setups is mitigated by
the 300 ms sustain, not eliminated — hardware AEC is out of scope.

**Traceability:** P0–P6 implementation history consolidated.

## Notes for maintainers

- Zero mandatory runtime dependencies, so this package never needs a
  rebuild-then-check ordering like `@lukestanbery/jarvis-logger` consumers
  do; `@lichess-org/vosk-browser` is a peer dependency the browser client
  provides.
- No logging dependency either — the caller owns diagnostics. The
  `log?` option (controller and the WASM engine) carries the
  otherwise-silent decision points to the caller: a VAD that failed to arm
  (the session silently degrades to press-to-stop endpointing), a barge
  watch that failed to arm, a failed wake pre-warm, and an engine
  cancelled mid-start. `packages/web` wires it to a `console.debug` sink
  gated by `localStorage.setItem("jarvis.debug", "1")`.
- The raw-vs-submitted transcript trace is a _separate_ controller option
  (`traceTranscript`, #121) because it carries real user speech: a client can
  enable general voice debugging without printing transcripts. `packages/web`
  wires it to its own opt-in sink (`?voice-trace=1`).
- The state machine readme diagram mirrors the module doc in
  `src/lifecycle.ts`; keep them in step.
