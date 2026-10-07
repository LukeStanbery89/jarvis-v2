# @lukestanbery/jarvis-voice

Shared voice-input abstractions for J.A.R.V.I.S. clients (issue #84). Two
halves, deliberately independent:

- **Provider seam** (`src/types.ts`) — `SttProvider` (what did they say),
  `WakeWordProvider` (are they addressing J.A.R.V.I.S.), `VadProvider` (is
  someone speaking). Engines are swappable behind these; nothing here knows
  about conversations, sockets, or protocol frames.
- **Session lifecycle state machine** (`src/lifecycle.ts`) — a pure reducer
  (`reduceVoice`) that owns the whole interaction: press/wake through
  transcript submission through response playback, one explicit state at a
  time.

Zero runtime dependencies, CommonJS, browser- and Node-safe. Browser
providers (Web Speech first, a local WASM model next) arrive in later #84
phases and are consumed by `packages/web`.

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

## Traceability

Phase 1 of the [voice-input issue](https://github.com/LukeStanbery89/jarvis-v2/issues/84):
the provider interfaces and lifecycle this package ships are the units of
work its P1 acceptance criteria name. Later phases land here too: local VAD
timeouts and wake-word look-back buffering in the provider layer, plus the
Web Speech/WASM browser providers consumed by `packages/web`.

## Notes for maintainers

- No runtime dependencies, so this package never needs a rebuild-then-check
  ordering like `@lukestanbery/jarvis-logger` consumers do.
- The state machine readme diagram mirrors the module doc in
  `src/lifecycle.ts`; keep them in step.
