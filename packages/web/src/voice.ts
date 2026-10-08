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
    createOpenWakeWord,
    createVoskStt,
    type SttProvider,
    type WakeWordProvider,
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

/**
 * The wake-word STT engine (#84 P4): always the local WASM engine.
 *
 * Wake sessions transcribe on-device by design — the controller feeds it the
 * detector's look-back buffer and the phrase+near-continuous audio around a
 * match, so a cloud engine would ship every eavesdropped second out of the
 * browser. The primary {@link createStt} stays the general-dictation engine;
 * this one is a second, ad-hoc instance for wake-opened sessions.
 *
 * @param options - The same WASM engine asset URLs as {@link createStt} (the
 *   chat view's `?url` imports), plus an optional model archive override.
 * @returns The local engine, or `null` when the WASM engine is unavailable.
 */
export function createWakeStt(
    options: SttEngineOptions = {},
): SttProvider | null {
    return createVoskStt({
        modelUrl: options.modelUrl,
        workerUrl: options.workerUrl,
        wasmUrl: options.wasmUrl,
    });
}

/**
 * The directory the build stages the ORT/openWakeWord wake-word assets into
 * (`packages/web/public/ort/` via `scripts/copy-voice-assets.mjs`).
 *
 * Derives from Vite's `BASE_URL` (`/web/`), which the dev server and the
 * production static mount agree on — the files live at `/web/ort/*` in both.
 *
 * @param baseUrl - The app's base URL override (tests pass one; production
 *   uses Vite's `import.meta.env.BASE_URL`).
 * @returns The asset directory URL, ending in `/`, e.g. `/web/ort/`.
 */
export function wakeAssetBaseUrl(
    baseUrl: string = import.meta.env.BASE_URL,
): string {
    const withSlash = baseUrl.replace(/\/?$/, "/");
    if (/^https?:/i.test(withSlash)) {
        return new URL("ort/", withSlash).href;
    }
    return `${withSlash}ort/`;
}

/**
 * Creates the on-device openWakeWord wake detector for this browser.
 *
 * `null` when the runtime cannot host it (no secure context / Web Audio /
 * audio worklet — the same floor as the WASM STT engine), which hides the
 * sidebar wake toggle. The detector is cheap to construct — model downloads
 * and the 16 kHz mic open only when {@link VoiceController#enableWake} arms
 * it — so the chat view may build it once at mount.
 *
 * The ORT wasm and mic worklet resolve against {@link wakeAssetBaseUrl};
 * openwakeword-web's own defaults point into its bundle, a `.`-mounted SPA
 * cannot reach. The `wasmPath` is the directory ORT fetches its
 * `ort-wasm-simd-threaded.jsep.*` pair from (a prefix, not a file URL).
 *
 * @returns The provider, or `null` when unsupported.
 */
export function createWakeWord(): WakeWordProvider | null {
    return createOpenWakeWord({
        wasmPath: wakeAssetBaseUrl(),
        workletUrl: `${wakeAssetBaseUrl()}mic-worklet.js`,
    });
}

/** localStorage key for the wake-word preference. */
const WAKE_PREF_KEY = "jarvis.wake.enabled";

/**
 * Reads the saved wake-word preference.
 *
 * **Default OFF**: wake detection opens a second microphone (the openWakeWord
 * detector) and keeps it running across sessions, so it is opt-in despite
 * the on-device privacy model. Only an explicit `"1"` enables it.
 */
export function readWakePref(storage: Pick<Storage, "getItem">): boolean {
    return storage.getItem(WAKE_PREF_KEY) === "1";
}

/**
 * Persists the wake-word preference as `"1"`/`"0"` (cleared keys stay
 * "never decided", matching the location-pref convention).
 */
export function writeWakePref(
    storage: Pick<Storage, "setItem">,
    enabled: boolean,
): void {
    storage.setItem(WAKE_PREF_KEY, enabled ? "1" : "0");
}

/**
 * Probes whether the server serves the wake models (#84 P4).
 *
 * A HEAD request to the first allowlisted model file: `true` when the route
 * answers 200 (configured and the file is cached), `false` on any other
 * status (unconfigured `JARVIS_WAKE_PROVIDER`, not yet fetched — the server
 * only 404s a missing model; a configured server that has not cached a file
 * yet still answers 404 without downloading on HEAD).
 *
 * The chat view gates the sidebar toggle on this: without it the wake engine
 * would download three models and then fail every session.
 *
 * @param fetchFn - Fetch implementation (injected for tests).
 * @returns Whether all probed files are served.
 */
export async function probeWakeSupport(
    fetchFn: typeof fetch = fetch,
): Promise<boolean> {
    try {
        const response = await fetchFn("/api/wake/model/melspectrogram.onnx", {
            method: "HEAD",
        });
        return response.ok;
    } catch {
        return false;
    }
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
