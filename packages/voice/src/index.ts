/**
 * `@lukestanbery/jarvis-voice` — shared voice-input abstractions for
 * J.A.R.V.I.S. clients (issue #84, phases 1–6).
 *
 * Five halves, deliberately independent:
 *
 * - `./types` — the engine seam: {@link SttProvider},
 *   {@link WakeWordProvider}, and {@link VadProvider} keep speech engines
 *   out of client protocol code. The STT seam also carries the `feed()`
 *   back-door that replays pre-session audio (a wake detector's look-back,
 *   a barge-in watch's ring) into a session. The VAD seam carries an
 *   optional raw-audio tap for the same purpose.
 * - `./lifecycle` — the pure session state machine ({@link reduceVoice})
 *   that turns provider results, submissions, and response events into one
 *   explicit {@link VoiceState} at a time (plus detector-armed state).
 * - `./controller` — the imperative orchestrator ({@link VoiceController})
 *   that drives engines through the state machine: mic presses, wake-word
 *   matches, endpointing (VAD-driven or engine-native), transcript
 *   accumulation, turn submission, and the barge-in watch (#84 P6) that
 *   interrupts a playing response on sustained speech. React- and
 *   transport-free, so any voice client reuses it.
 * - `./wakeText` — transcript hygiene for wake sessions ({@link stripWakePhrase}).
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
export {
    BARGE_IN_LOOKBACK_MS,
    BARGE_IN_SPEECH_MS,
    DEFAULT_WAKE_PHRASE,
    END_OF_SPEECH_MS,
    NO_SPEECH_MS,
    VoiceController,
} from "./controller";
export type {
    BargeInDetection,
    VoiceControllerOptions,
    VoiceSubmit,
} from "./controller";
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
