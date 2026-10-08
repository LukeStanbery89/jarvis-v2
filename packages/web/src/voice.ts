/**
 * Voice-controller wiring (issue #84).
 *
 * The controller lives in `@lukestanbery/jarvis-voice` (phase 3 moved it
 * next to the lifecycle it drives, so any future voice client reuses the
 * same orchestrator). This module re-exports it for the chat view's stable
 * relative import path and owns the web client's one engine-local decision:
 * which STT engine to construct — Web Speech first (fast, cloud-backed in
 * Chrome — the best general dictation), the local WASM engine (Vosk, #84
 * P3b) as the offline/private fallback, so the on-device model ships by
 * default but is only paid for when the cloud path is unavailable (or the
 * server serves the model and no SpeechRecognition exists).
 */
import {
    createBrowserStt,
    createVoskStt,
    type SttProvider,
} from "@lukestanbery/jarvis-voice";

/** Options for {@link createStt}. */
export interface SttEngineOptions {
    /**
     * Model archive URL override for the WASM engine. Defaults to the
     * provider's own same-origin default (the server's `GET /api/stt/model`).
     */
    readonly modelUrl?: string;
    /**
     * The engine's worker script URL. The chat view passes the
     * Vite-bundled asset URL (imported with `?url`), since the library's
     * default path cannot be resolved from a `/web`-mounted SPA.
     */
    readonly workerUrl?: string;
    /**
     * The engine's WASM binary URL, fetched by the worker. The chat view
     * passes the Vite-bundled asset URL (imported with `?url`).
     */
    readonly wasmUrl?: string;
}

/**
 * Selects this browser's STT engine: Web Speech first (fast, cloud-backed in
 * Chrome — the best general dictation), the local WASM engine otherwise —
 * covering browsers with mic + Web Audio + WebAssembly whose
 * `SpeechRecognition` is absent (e.g. Firefox) or where the team wants
 * on-device privacy by opting in. `null` when neither is available (no
 * mic/secure context): the mic button renders disabled with an explanation.
 *
 * Engine selection is construction-time; a session-time failure (e.g. the
 * model archive cannot be fetched, or the cloud endpoint goes away)
 * surfaces through the engine's own error path rather than falling back
 * mid-session — engine failover is a later phase.
 *
 * @param options - Optional WASM engine asset URL overrides (used by the
 *   Vosk fallback only).
 * @returns The selected provider, or `null` when no engine is available.
 */
export function createStt(options: SttEngineOptions = {}): SttProvider | null {
    return (
        createBrowserStt() ??
        createVoskStt({
            modelUrl: options.modelUrl,
            workerUrl: options.workerUrl,
            wasmUrl: options.wasmUrl,
        })
    );
}

export {
    END_OF_SPEECH_MS,
    NO_SPEECH_MS,
    VoiceController,
} from "@lukestanbery/jarvis-voice";
export type {
    VoiceControllerOptions,
    VoiceSubmit,
} from "@lukestanbery/jarvis-voice";
