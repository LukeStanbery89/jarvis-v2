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
 * `kokoro-js` is an `optionalDependency` of the server (TTS is config-gated,
 * and the Docker prod stage installs with `--omit=optional`), so nothing here
 * is a hard runtime requirement: a missing install surfaces at the lazy
 * `import()` and is reported as an unavailable provider, never as a type
 * error.
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

    /**
     * kokoro-js re-exports its bundled transformers.js `env`; setting
     * `cacheDir` here pins model weights under the server's private tree
     * without importing a second transformers.js/ONNX runtime.
     */
    export const env: {
        cacheDir: string;
    };
}
