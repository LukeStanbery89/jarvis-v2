/**
 * Voice-controller wiring (issue #84).
 *
 * The controller lives in `@lukestanbery/jarvis-voice` (phase 3 moved it
 * next to the lifecycle it drives, so any future voice client reuses the
 * same orchestrator). This module re-exports it for the chat view's stable
 * relative import path and owns the web client's one engine-local decision:
 * which STT engine to construct (phase 3b) — the local WASM engine (Vosk)
 * first, Web Speech as the fallback, so Chrome-only speech keeps working
 * wherever the local model cannot load and Firefox gains a mic at all.
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
 * Selects this browser's STT engine: the local WASM engine when the runtime
 * offers mic access, Web Audio, and WebAssembly (every modern secure-context
 * browser); the Web Speech engine otherwise — covering browsers whose WASM
 * stack is somehow unavailable while a recognition engine exists. `null`
 * when neither is available (no mic/secure context): the mic button renders
 * disabled with an explanation.
 *
 * Selection is construction-time; a session-time failure (e.g. the model
 * archive cannot be fetched) surfaces through the engine's own error path
 * rather than falling back mid-session — engine failover is a later phase.
 *
 * @param options - Optional WASM engine asset URL overrides.
 * @returns The selected provider, or `null` when no engine is available.
 */
export function createStt(options: SttEngineOptions = {}): SttProvider | null {
    return (
        createVoskStt({
            modelUrl: options.modelUrl,
            workerUrl: options.workerUrl,
            wasmUrl: options.wasmUrl,
        }) ?? createBrowserStt()
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
