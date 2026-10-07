/**
 * `@lukestanbery/jarvis-voice` — shared voice-input abstractions for
 * J.A.R.V.I.S. clients (issue #84, phases 1–3).
 *
 * Three halves, deliberately independent:
 *
 * - `./types` — the engine seam: {@link SttProvider},
 *   {@link WakeWordProvider}, and {@link VadProvider} keep speech engines
 *   out of client protocol code.
 * - `./lifecycle` — the pure session state machine ({@link reduceVoice})
 *   that turns provider results, submissions, and response events into one
 *   explicit {@link VoiceState} at a time.
 * - `./controller` — the imperative orchestrator ({@link VoiceController})
 *   that drives engines through the state machine: mic presses, endpointing
 *   (VAD-driven or engine-native), transcript accumulation, and turn
 *   submission. React- and transport-free, so any voice client reuses it.
 *
 * Zero runtime dependencies, CommonJS, browser- and Node-safe (no DOM or
 * `node:` APIs at module scope). Browser providers (Web Speech first, local
 * WASM next) arrive in later #84 phases and are consumed by `packages/web`.
 */
export type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
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
export { END_OF_SPEECH_MS, NO_SPEECH_MS, VoiceController } from "./controller";
export type { VoiceControllerOptions, VoiceSubmit } from "./controller";
export {
    WebSpeechSttProvider,
    createBrowserStt,
    isWebSpeechSupported,
} from "./providers/webSpeech";
export type { WebSpeechSttOptions } from "./providers/webSpeech";
export {
    BrowserVadProvider,
    createBrowserVad,
    isVadSupported,
} from "./providers/browserVad";
export type { BrowserVadOptions } from "./providers/browserVad";
