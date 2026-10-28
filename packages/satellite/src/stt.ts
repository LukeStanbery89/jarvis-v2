/**
 * Local speech-to-text through Transformers.js.
 *
 * The first satellite slice runs Whisper tiny.en on CPU, fully on-device. The
 * model is downloaded once into the satellite's private cache and then loaded
 * lazily; the microphone path never sends raw audio to the server. The engine
 * is behind {@link WhisperStt} so a Vosk or whisper.cpp provider can replace
 * it for the Pi without touching the wake loop.
 */
import { mkdirSync } from "node:fs";
import {
    env,
    pipeline,
    type AutomaticSpeechRecognitionPipeline,
    type DataType,
} from "@huggingface/transformers";
import { logger } from "./logger";
import { SAMPLE_RATE, type SatelliteConfig } from "./config";

/** One local Whisper model, loaded on first transcription. */
export class WhisperStt {
    private readonly model: string;
    private readonly dtype: string;
    private readonly cacheDir: string;
    private loaded: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

    constructor(private readonly config: SatelliteConfig) {
        this.model = config.sttModel;
        this.dtype = config.sttDtype;
        this.cacheDir = config.modelCacheDir;
    }

    /** Loads the model now so the first spoken command does not pay for it. */
    async warmup(): Promise<void> {
        await this.getPipeline();
    }

    /**
     * Transcribes mono 16 kHz float PCM.
     *
     * @returns The transcript, trimmed. Empty audio returns an empty string.
     */
    async transcribe(pcm: Float32Array): Promise<string> {
        if (pcm.length === 0) {
            return "";
        }
        const transcriber = await this.getPipeline();
        const result = await transcriber(pcm, {
            sampling_rate: SAMPLE_RATE,
            chunk_length_s: 30,
            stride_length_s: 5,
        });
        const raw = Array.isArray(result)
            ? result.map((part) => part.text).join(" ")
            : result.text;
        return raw.trim();
    }

    /** Loads and caches the pipeline; a failure is retried on the next call. */
    private getPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
        if (this.loaded === null) {
            mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
            env.cacheDir = this.cacheDir;
            logger.info(
                `Loading local STT model ${this.model} (first run downloads it)…`,
            );
            const started = Date.now();
            this.loaded = pipeline("automatic-speech-recognition", this.model, {
                dtype: this.dtype as DataType,
            }).then((transcriber) => {
                logger.info(
                    `Local STT ready in ${Date.now() - started}ms (${this.model})`,
                );
                return transcriber;
            });
            this.loaded.catch(() => {
                // Let a transient download/load failure retry next time.
                this.loaded = null;
            });
        }
        return this.loaded;
    }
}
