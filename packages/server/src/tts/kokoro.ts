/**
 * Kokoro TTS provider — the first `TtsProvider` implementation (issue #83,
 * phase 1).
 *
 * `kokoro-js` runs Kokoro-82M through ONNX (transformers.js) fully locally:
 * no Python, no Apple-Silicon lock-in, Mac + Linux — which is what
 * disqualifies the MLX sketch the spike grew from. The module is
 * ESM-first, so it loads through a lazy dynamic `import()` (Node 24's
 * `require(esm)` interop makes that safe from this CommonJS build), and it
 * is an *optional* dependency: the provider is config-gated and a missing
 * install surfaces as a failed init, never a boot failure.
 *
 * The first `synthesize()` initializes the engine once (weights download
 * into a private cache dir under `~/.jarvis` on first use — never baked
 * into the Docker image) and every call after that reuses it. The loader
 * is injectable so tests drive a fake module and never touch the network.
 *
 * Voice selection takes the Kokoro voice id directly (`bm_lewis` by
 * default); the logical `voice: "jarvis"` config indirection lands with the
 * orchestrator phase (#83 P3/P4).
 */
import { homedir } from "node:os";
import { ensurePrivateDir } from "@lukestanbery/jarvis-auth";
import type { KokoroTTS } from "kokoro-js";
import type {
    SynthesizeOptions,
    SynthesizedSpeech,
    TtsProvider,
} from "./types";

/** The slice of the kokoro-js module the provider drives. */
type KokoroModule = typeof import("kokoro-js");

/**
 * Loads the runtime modules; injectable so tests never touch the network
 * or the real packages.
 */
export type KokoroModuleLoader = () => Promise<KokoroModule>;

/**
 * Construction options for {@link KokoroTtsProvider}. All optional; the
 * defaults synthesize on CPU from the quantized checkpoint.
 */
export interface KokoroTtsOptions {
    /** Hugging Face model id. Default: {@link DEFAULT_KOKORO_MODEL_ID}. */
    readonly modelId?: string;
    /** ONNX dtype. Default `"q8"` (small + fast; `"fp32"` for max quality). */
    readonly dtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
    /** Kokoro voice id (see `kokoro-js`'s `VOICES`). Default: `bm_lewis`. */
    readonly voice?: string;
    /** Speaking speed multiplier. Default `1`. */
    readonly speed?: number;
    /**
     * Where model weights cache. Default: {@link DEFAULT_KOKORO_CACHE_DIR}
     * (`~/.jarvis/tts`, created private — 0700 — on first use).
     */
    readonly cacheDir?: string;
}

/** The quantized Kokoro-82M checkpoint kokoro-js documents. */
export const DEFAULT_KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** The default J.A.R.V.I.S. voice: Lewis, a British male stock voice. */
export const DEFAULT_KOKORO_VOICE = "bm_lewis";

/** Model weights cache root, under the `~/.jarvis` data tree. */
export const DEFAULT_KOKORO_CACHE_DIR = `${homedir()}/.jarvis/tts`;

/**
 * The real module loader: pins the transformers.js cache dir (its default
 * is `./.cache` relative to the process CWD, which would litter the repo or
 * the container workdir), then loads kokoro-js.
 *
 * @returns The kokoro-js module.
 */
const defaultLoadModule: KokoroModuleLoader = async () => {
    const transformers = await import("@huggingface/transformers");
    const cacheDir = cacheDirOverride;
    if (cacheDir !== null) {
        transformers.env.cacheDir = cacheDir;
    }
    return import("kokoro-js");
};

/**
 * Module-level cache-dir handoff from {@link KokoroTtsProvider.init} to
 * {@link defaultLoadModule}: the loader is a fixed function by design (the
 * injectable seam is the whole loader), so the provider records the dir it
 * wants before invoking it. Reads as a wart; keeps the seam one function.
 */
let cacheDirOverride: string | null = null;

/**
 * The Kokoro `TtsProvider`.
 *
 * Abort semantics are cooperative: the signal is checked before engine
 * init, before `generate`, and after it — a synthesis in flight cannot be
 * interrupted inside the engine, but the caller's rejection is immediate at
 * the next checkpoint and any late result is discarded by the orchestrator.
 */
export class KokoroTtsProvider implements TtsProvider {
    readonly id = "kokoro";

    private readonly options: KokoroTtsOptions;
    private readonly loadModule: KokoroModuleLoader;
    private instance: KokoroTTS | null = null;
    private initPromise: Promise<KokoroTTS> | null = null;

    /**
     * @param options - Engine configuration (model, dtype, voice, cache).
     * @param loadModule - Module loader override for tests.
     */
    constructor(
        options: KokoroTtsOptions = {},
        loadModule?: KokoroModuleLoader,
    ) {
        this.options = options;
        this.loadModule = loadModule ?? defaultLoadModule;
    }

    /**
     * Synthesizes one snippet of speakable text.
     *
     * @param text - The text to speak.
     * @param options - Cancellation signal.
     * @returns The synthesized speech (mono float PCM + rate).
     * @throws On empty text, an aborted signal, or a failed engine
     * init/generate (missing optional install, no weights, engine error).
     */
    async synthesize(
        text: string,
        { signal }: SynthesizeOptions = {},
    ): Promise<SynthesizedSpeech> {
        const prompt = text.trim();
        if (prompt === "") {
            throw new Error("refusing to synthesize empty text");
        }
        throwIfAborted(signal);
        const instance = await this.init();
        throwIfAborted(signal);
        const raw = await instance.generate(prompt, {
            voice: this.options.voice ?? DEFAULT_KOKORO_VOICE,
            speed: this.options.speed ?? 1,
        });
        throwIfAborted(signal);
        return { pcm: raw.audio, sampleRate: raw.sampling_rate };
    }

    /**
     * Loads the engine exactly once. A failed init resets the promise so a
     * later call retries (e.g. after installing the optional dependency or
     * regaining network for the weights download).
     *
     * @returns The shared engine instance.
     */
    private async init(): Promise<KokoroTTS> {
        if (this.instance !== null) {
            return this.instance;
        }
        if (this.initPromise === null) {
            const cacheDir = this.options.cacheDir ?? DEFAULT_KOKORO_CACHE_DIR;
            ensurePrivateDir(cacheDir);
            cacheDirOverride = cacheDir;
            this.initPromise = this.loadModule()
                .then((kokoro) =>
                    kokoro.KokoroTTS.from_pretrained(
                        this.options.modelId ?? DEFAULT_KOKORO_MODEL_ID,
                        { dtype: this.options.dtype ?? "q8", device: "cpu" },
                    ),
                )
                .then((instance) => {
                    this.instance = instance;
                    return instance;
                })
                .catch((err: unknown) => {
                    this.initPromise = null;
                    throw err;
                });
        }
        return this.initPromise;
    }
}

/**
 * Rejects immediately when the signal has fired, with the signal's own
 * reason (the `AbortError` the caller's `catch` expects).
 *
 * @param signal - The caller's signal, if any.
 */
function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("synthesis aborted");
    }
}
