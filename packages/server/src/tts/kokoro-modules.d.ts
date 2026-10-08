/**
 * Minimal ambient declarations for the ESM-first TTS packages the Kokoro
 * provider loads lazily at runtime.
 *
 * kokoro-js ships `exports`-based types, but `tsconfig.base.json` uses
 * `moduleResolution: node10`, which reads only `main` and cannot see them —
 * so the provider types the narrow slice it uses here instead. If module
 * resolution ever modernizes, these declarations can be deleted in favor of
 * the shipped types.
 *
 * Both packages are `optionalDependencies` of the server (TTS is
 * config-gated, and the Docker prod stage installs with `--omit=optional`),
 * so nothing here is a hard runtime requirement: a missing install surfaces
 * at the lazy `import()` and is reported as an unavailable provider, never
 * as a type error.
 */
declare module "kokoro-js" {
    /**
     * Audio produced by one generation: float32 PCM plus its rate, with a
     * WAV encoder (used by the local harness).
     */
    export interface KokoroRawAudio {
        /** Float32 samples in [-1, 1], mono. */
        audio: Float32Array;
        /** Sample rate of `audio`, in Hz. */
        sampling_rate: number;
        /** Encodes the audio as a WAV `ArrayBuffer`. */
        toWav(): ArrayBuffer;
    }

    /**
     * The slice of the KokoroTTS class the provider drives: the async
     * loader and per-segment generation.
     */
    export class KokoroTTS {
        static from_pretrained(
            modelId: string,
            options?: {
                dtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
                device?: "wasm" | "webgpu" | "cpu" | null;
                progress_callback?: (progress: unknown) => void;
            },
        ): Promise<KokoroTTS>;
        generate(
            text: string,
            options?: { voice?: string; speed?: number },
        ): Promise<KokoroRawAudio>;
    }
}

declare module "@huggingface/transformers" {
    /**
     * The slice of transformers.js `env` the provider touches: the model
     * cache directory (defaults to `./.cache` relative to the process CWD,
     * which would litter the repo — the provider pins it under `~/.jarvis`).
     */
    export const env: {
        cacheDir: string;
    };
}
