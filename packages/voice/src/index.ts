/**
 * `@lukestanbery/jarvis-voice` — shared voice-input abstractions for
 * J.A.R.V.I.S. clients (issue #84, phase 1).
 *
 * Two halves, deliberately independent:
 *
 * - `./types` — the engine seam: {@link SttProvider},
 *   {@link WakeWordProvider}, and {@link VadProvider} keep speech engines
 *   out of client protocol code.
 * - `./lifecycle` — the pure session state machine ({@link reduceVoice})
 *   that turns provider results, submissions, and response events into one
 *   explicit {@link VoiceState} at a time.
 *
 * Zero runtime dependencies, CommonJS, browser- and Node-safe (no DOM or
 * `node:` APIs at module scope). Browser providers (Web Speech first, local
 * WASM next) arrive in later #84 phases and are consumed by `packages/web`.
 */
export type {
    SttCallbacks,
    SttProvider,
    SttState,
    VadCallbacks,
    VadProvider,
    VoiceError,
    VoiceErrorCode,
    WakeCallbacks,
    WakeDetection,
    WakeWordProvider,
} from "./types";
export type { VoiceEvent, VoiceSnapshot, VoiceState } from "./lifecycle";
export { VOICE_STATES, initialVoiceSnapshot, reduceVoice } from "./lifecycle";
