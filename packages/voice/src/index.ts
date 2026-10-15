/**
 * `@lukestanbery/jarvis-voice` — shared voice-input abstractions for
 * J.A.R.V.I.S. clients (issue #84, phases 1–6).
 *
 * Independent modules:
 *
 * - `./types` — the engine seam: {@link SttProvider},
 *   {@link WakeWordProvider}, and {@link VadProvider} keep speech engines
 *   out of client protocol code. The STT seam also carries the `feed()`
 *   back-door that takes caller audio instead of a microphone (a wake
 *   session streams the detector's live command frames through it, #121; a
 *   barge-in session replays its ring). The wake seam carries the same live
 *   stream as `WakeCallbacks.onCommandAudio`, so a wake session's audio is
 *   never replayed or spliced.
 * - `./lifecycle` — the pure session state machine ({@link reduceVoice})
 *   that turns provider results, submissions, and response events into one
 *   explicit {@link VoiceState} at a time (plus detector-armed state).
 * - `./controller` — the imperative orchestrator ({@link VoiceController})
 *   that drives engines through the state machine: mic presses, wake-word
 *   matches, session lifetime, and turn submission. React- and
 *   transport-free, so any voice client reuses it. Feature state machines
 *   live beside it (issue #110), each over a shared `VoiceCore` context:
 *   `./session` (`VoiceSession` — one session's endpointing + transcript
 *   accumulation + submission), `./wake` (`WakeManager` — the detector-armed
 *   machine), and `./barge` (`BargeWatch` — the barge-in watch that
 *   interrupts a playing response on sustained speech, #84 P6).
 * - `./wakeText` — transcript hygiene for wake sessions ({@link stripWakePhrase}).
 * - `./wav` — a dependency-free WAV codec ({@link encodeWav}/{@link decodeWav})
 *   for the #121 corpus: fixtures and the debug capture path move audio as
 *   WAV bytes so tests and the replay harness share one representation.
 *
 * Zero mandatory runtime dependencies, CommonJS, browser- and Node-safe (no
 * DOM or `node:` APIs at module scope; the WASM STT engine and the
 * openWakeWord wake detector are optional peers the browser client
 * provides). Browser providers (Web Speech, the local Vosk WASM engine, the
 * openWakeWord wake word) are consumed by `packages/web`.
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
export { BARGE_IN_LOOKBACK_MS, BARGE_IN_SPEECH_MS } from "./barge";
export type { BargeInDetection } from "./barge";
export { DEFAULT_WAKE_PHRASE } from "./wake";
export { END_OF_SPEECH_MS, MAX_COMMAND_MS, NO_SPEECH_MS } from "./session";
export { VoiceController } from "./controller";
export type { VoiceControllerOptions, VoiceSubmit } from "./controller";
export {
    WebSpeechSttProvider,
    createBrowserStt,
    isWebSpeechSupported,
} from "./providers/webSpeech";
export type { WebSpeechSttOptions } from "./providers/webSpeech";
export {
    VoskSttProvider,
    createVoskStt,
    isVoskSupported,
    DEFAULT_VOSK_MODEL_URL,
} from "./providers/vosk";
export type { VoskModuleLoader, VoskSttOptions } from "./providers/vosk";
export {
    BrowserVadProvider,
    createBrowserVad,
    isVadSupported,
} from "./providers/browserVad";
export type { BrowserVadOptions } from "./providers/browserVad";
export {
    OpenWakeWordWakeProvider,
    createOpenWakeWord,
    isWakeSupported,
} from "./providers/openWakeWord";
export type {
    OpenWakeWordLoader,
    OpenWakeWordModuleLike,
    OpenWakeWordOptions,
} from "./providers/openWakeWord";
export { stripWakePhrase } from "./wakeText";
export { decodeWav, encodeWav } from "./wav";
export type { WavAudio } from "./wav";
