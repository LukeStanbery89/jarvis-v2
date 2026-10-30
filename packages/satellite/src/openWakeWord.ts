/**
 * Node-side openWakeWord detector for the satellite.
 *
 * `openwakeword-web` is a browser package, but its `OpenWakeWord` engine only
 * needs ONNX Runtime and 16 kHz int16 frames — not Web Audio. The satellite
 * feeds it the same raw frames SoX already produces, which keeps wake detection
 * local without adding a Python sidecar.
 *
 * The command cut follows the #121 invariant implemented by the browser
 * provider: the phrase's score ramps up at its end, so the first command frame
 * is found by walking back from the threshold crossing to a short quiet run.
 * Only frames from that point onward reach the command segmenter and, later,
 * Whisper.
 */
import type { SatelliteConfig } from "./config";
import { logger } from "./logger";
import { SpeechSegmenter } from "./vad";
import { ensureWakeModels } from "./wakeModels";

/**
 * `openwakeword-web` is ESM-only and its `exports` map has no CommonJS
 * condition. TypeScript rewrites a normal dynamic `import()` to `require` in
 * this CommonJS package, which fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so
 * the import is built at runtime where the compiler cannot rewrite it.
 */
type OpenWakeWordModule = typeof import("openwakeword-web");
const importEsm = new Function("specifier", "return import(specifier)") as (
    specifier: string,
) => Promise<OpenWakeWordModule>;

/** openWakeWord's capture frame: 1280 samples (80 ms at 16 kHz). */
export const WAKE_FRAME_SAMPLES = 1280;

/** Score below which a frame is before the phrase (mirrors #121). */
const SCORE_FLOOR = 0.01;
/** How far back the cut searches. */
const CUT_SCAN_FRAMES = 12;
/** Quiet frames needed to identify the boundary. */
const CUT_RUN_FRAMES = 2;
/** Last-resort cap on unpredicted frames (~10 seconds). */
const MAX_BACKLOG_FRAMES = 125;

/** The slice of `OpenWakeWord` the satellite drives. */
export interface WakeEngine {
    predict(frame: Int16Array): Promise<Record<string, number>>;
    reset(): Promise<void>;
}

/** One captured frame and its score, once predicted. */
interface CapturedFrame {
    readonly pcm: Int16Array;
    score: number | null;
}

/** Callbacks for one armed detector. */
export interface OpenWakeWordCallbacks {
    /** A wake phrase crossed the threshold. */
    onWake: (confidence: number) => void;
    /** A complete command utterance after the phrase. */
    onCommand: (pcm: Float32Array) => Promise<void> | void;
    /** The detector failed and must be disabled for this run. */
    onError: (error: Error) => void;
}

/** Detects “Hey JARVIS” from streaming 16 kHz int16 frames. */
export class OpenWakeWordDetector {
    private engine: WakeEngine | null = null;
    private callbacks: OpenWakeWordCallbacks | null = null;
    private armed = false;
    private detected = false;
    private predicting = false;
    private generation = 0;
    private captured: CapturedFrame[] = [];
    private cursor = 0;
    private commandEmitted = false;
    private readonly commandSegmenter: SpeechSegmenter;

    constructor(
        private readonly config: SatelliteConfig,
        private readonly engineFactory?: (
            modelDir: string,
        ) => Promise<WakeEngine>,
    ) {
        this.commandSegmenter = new SpeechSegmenter({
            threshold: config.vadThreshold,
            onsetMs: config.vadOnsetMs,
            silenceMs: config.vadSilenceMs,
            preRollMs: 0,
            maxUtteranceMs: config.vadMaxUtteranceMs,
            sampleRate: 16_000,
        });
    }

    /** Loads the ONNX models once; safe to call again after {@link reset}. */
    async start(callbacks: OpenWakeWordCallbacks): Promise<void> {
        this.callbacks = callbacks;
        if (this.engine !== null) {
            this.armed = true;
            this.detected = false;
            this.captured = [];
            this.cursor = 0;
            this.commandEmitted = false;
            this.commandSegmenter.reset();
            await this.engine.reset();
            return;
        }
        const modelDir =
            this.engineFactory !== undefined
                ? this.config.wakeModelDir
                : await ensureWakeModels(this.config);
        if (modelDir === null) {
            throw new Error(
                "openWakeWord models are unavailable; using transcript wake",
            );
        }
        const engine =
            this.engineFactory !== undefined
                ? await this.engineFactory(modelDir)
                : await this.loadEngine(modelDir);
        this.engine = engine;
        this.armed = true;
        this.detected = false;
        this.captured = [];
        this.cursor = 0;
        this.commandEmitted = false;
        this.commandSegmenter.reset();
        logger.info("Local openWakeWord detector ready (hey_jarvis)");
    }

    /** Loads the ESM engine and its three ONNX sessions. */
    private async loadEngine(modelDir: string): Promise<WakeEngine> {
        const module = await importEsm("openwakeword-web");
        return module.OpenWakeWord.create({
            baseUrl: `${modelDir.replace(/\/+$/, "")}/`,
            wakewordModels: ["hey_jarvis"],
            threshold: this.config.wakeThreshold,
            executionProviders: ["wasm"],
            ort: { numThreads: 1 },
        });
    }

    /** Handles one 1280-sample frame. */
    push(frame: Int16Array): void {
        if (this.engine === null || frame.length !== WAKE_FRAME_SAMPLES) {
            return;
        }
        if (this.detected) {
            this.feedCommand(frame);
            return;
        }
        if (!this.armed) {
            return;
        }
        this.captured.push({ pcm: frame, score: null });
        if (this.captured.length - this.cursor > MAX_BACKLOG_FRAMES) {
            this.captured.splice(this.cursor, 1);
            logger.warn(
                "Wake detector is falling behind; shedding the oldest audio",
            );
        }
        this.pump();
    }

    /**
     * Resets for another phrase: clears features, scores and any partial
     * command, and aborts a prediction that was in flight.
     */
    async reset(): Promise<void> {
        this.generation += 1;
        this.armed = false;
        this.detected = false;
        this.predicting = false;
        this.captured = [];
        this.cursor = 0;
        this.commandEmitted = false;
        this.commandSegmenter.reset();
        if (this.engine !== null) {
            await this.engine.reset();
            this.armed = true;
        }
    }

    /** Releases callbacks; the engine stays loaded for a later start. */
    stop(): void {
        this.generation += 1;
        this.armed = false;
        this.detected = false;
        this.predicting = false;
        this.captured = [];
        this.cursor = 0;
        this.commandEmitted = false;
        this.callbacks = null;
        this.commandSegmenter.reset();
    }

    /** Scores the oldest unpredicted frame, one at a time. */
    private pump(): void {
        const engine = this.engine;
        if (
            engine === null ||
            this.predicting ||
            this.detected ||
            !this.armed
        ) {
            return;
        }
        const entry = this.captured[this.cursor];
        if (entry === undefined) {
            return;
        }
        const generation = this.generation;
        this.predicting = true;
        void engine
            .predict(entry.pcm)
            .then((scores) => {
                if (generation !== this.generation) {
                    return;
                }
                const values = Object.values(scores);
                entry.score = values.length > 0 ? Math.max(...values) : 0;
                if (entry.score >= this.config.wakeThreshold) {
                    this.fire(entry.score);
                }
            })
            .catch((error: unknown) => {
                if (generation !== this.generation) {
                    return;
                }
                this.armed = false;
                this.callbacks?.onError(
                    error instanceof Error
                        ? error
                        : new Error("wake detector failed"),
                );
            })
            .finally(() => {
                if (generation === this.generation) {
                    this.predicting = false;
                    this.cursor += 1;
                    this.pump();
                }
            });
    }

    /** Starts the command stream from the phrase's score onset. */
    private fire(confidence: number): void {
        if (this.detected) {
            return;
        }
        this.detected = true;
        this.armed = false;
        const start = this.commandStartIndex();
        const recovered = this.captured.slice(start);
        this.captured = [];
        this.cursor = 0;
        this.callbacks?.onWake(confidence);
        for (const entry of recovered) {
            this.feedCommand(entry.pcm);
        }
    }

    /** Feeds command audio through the VAD/segmenter owned by this detector. */
    private feedCommand(frame: Int16Array): void {
        if (this.commandEmitted) {
            return;
        }
        const completed = this.commandSegmenter.feed(frame);
        for (const pcm of completed) {
            if (this.commandEmitted) {
                break;
            }
            this.commandEmitted = true;
            void this.callbacks?.onCommand(pcm);
        }
    }

    /** The first frame after the phrase, using the #121 score-onset cut. */
    private commandStartIndex(): number {
        const from = Math.max(0, this.cursor - CUT_SCAN_FRAMES);
        for (let i = this.cursor - 1; i > from; i -= 1) {
            let quiet = true;
            for (let back = 0; back < CUT_RUN_FRAMES; back += 1) {
                const score = this.captured[i - back]?.score;
                if (
                    score === null ||
                    score === undefined ||
                    score >= SCORE_FLOOR
                ) {
                    quiet = false;
                    break;
                }
            }
            if (quiet) {
                return i + 1;
            }
        }
        return this.cursor;
    }
}
