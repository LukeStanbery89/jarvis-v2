/**
 * Local WASM implementation of the {@link WakeWordProvider} seam (issue
 * #84, phase 4) — a streaming openWakeWord detector running entirely
 * on-device through `openwakeword-web` (a faithful browser port of David
 * Scripka's openWakeWord). This is the "Hey JARVIS" wake word: `start()`
 * arms a 16 kHz monitor that fires once per phrase, and — because that same
 * microphone keeps running — the provider hands every frame **after** the
 * match to `WakeCallbacks.onCommandAudio`, so the wake session's engine
 * recognizes the command on the detector's own capture, with nothing spliced
 * and the phrase never replayed (#121).
 *
 * The audio pipeline is openwakeword-web's: a same-origin AudioWorklet
 * (`mic-worklet.js`, copied into the web client's own `public/` because the
 * package does not export it) frames 16-bit PCM; the streaming feature
 * models (`melspectrogram.onnx`, `embedding_model.onnx`) and the trained
 * `hey_jarvis_v0.1.onnx` are fetched same-origin from the J.A.R.V.I.S.
 * server's `GET /api/wake/model` route — upstream GitHub assets send no
 * CORS headers, so the models must be hosted on the origin the page runs
 * on. ONNX Runtime executes in WebAssembly, whose `.wasm` binary is also
 * served same-origin and passed in explicitly (`wasmPath`) — ORT resolves
 * its wasm relative to its own bundle URL by default, which a `/web`-mounted
 * SPA cannot satisfy.
 *
 * Like every browser provider in this package, browser APIs are looked up
 * structurally from `globalThis` (no DOM lib; node tests install fakes),
 * and the engine module loads lazily through an injectable loader, so a
 * missing install or a non-browser runtime never breaks importing this
 * file — it surfaces as `null` from {@link createOpenWakeWord} or a
 * rejected `start()`.
 *
 * Detection posture: prediction runs serialized over a FIFO of captured
 * frames (busy-dropping would starve — and de-align — the feature pipeline,
 * whose input must stay contiguous), the detector fires at most once per
 * `start()`, and the frames captured *after* the frame that crossed the
 * threshold are recovered from that queue and streamed out with everything
 * that follows — so the command's opening survives however long the pipeline
 * took to reach the phrase (#121).
 */
import type { VoiceError, WakeCallbacks, WakeWordProvider } from "../types";
import { micError, voiceError } from "./internal";

/** The detector's capture rate; the command stream is mono at this rate. */
const MIC_SAMPLE_RATE = 16000;

/** One frame's worth of samples at the detector's 16 kHz rate (80 ms). */
const FRAME_SAMPLES = 1280;

/**
 * The prediction backlog cap (#121): captured frames awaiting a `predict()`.
 * Ten seconds of audio — a stalled main thread recovers from far less. Past
 * this the oldest frames are shed so memory stays bounded, at the cost of the
 * pipeline's contiguity (logged; see {@link OpenWakeWordWakeProvider.onFrame}).
 */
const MAX_QUEUED_FRAMES = (10 * MIC_SAMPLE_RATE) / FRAME_SAMPLES;

/** Configuration for {@link createOpenWakeWord}. */
export interface OpenWakeWordOptions {
    /**
     * Base URL the model files resolve against (openwakeword-web joins it
     * with each model filename). Defaults to the J.A.R.V.I.S. server's
     * same-origin wake-model route (`/api/wake/model/`)
     */
    readonly baseUrl?: string;
    /**
     * Registry names of the wake-word models to arm. Defaults to
     * `["hey_jarvis"]` → `hey_jarvis_v0.1.onnx`.
     */
    readonly wakewordModels?: string[];
    /**
     * Detection threshold, 0..1. Defaults to 0.5 — the openWakeWord
     * convention.
     */
    readonly threshold?: number;
    /**
     * Base URL ORT fetches its wasm pair (`ort-wasm-simd-threaded.jsep.mjs`
     * + `.wasm`) from — a directory prefix ending in `/`, not a file URL.
     * Passed to openwakeword-web explicitly because ORT otherwise resolves
     * its wasm relative to its bundle URL, which a `/web`-mounted SPA cannot
     * satisfy. Defaults to ORT's own resolution when omitted (works only
     * when the SPA can reach it).
     */
    readonly wasmPath?: string;
    /** ORT worker threads. Defaults to 1 (openwakeword-web's recommendation). */
    readonly numThreads?: number;
    /**
     * URL of the 16 kHz mic worklet (`mic-worklet.js` from
     * `openwakeword-web/src`). Defaults to the library's own worklet URL —
     * which, again, cannot satisfy a `/web`-mounted SPA, so web clients
     * serve it same-origin and pass it in.
     */
    readonly workletUrl?: string;
    /**
     * Debug sink for the detector's otherwise-invisible backlog work
     * (#121): how many captured frames the match had to recover from the
     * prediction queue. The caller owns diagnostics (this package has no
     * logging dependency); default: a no-op.
     */
    readonly log?: (message: string, error?: unknown) => void;
}

/** A detection event reported by openwakeword-web. */
interface DetectionEventLike {
    readonly label: string;
    readonly score: number;
}

/** The ORT configuration slice passed through to openwakeword-web. */
interface OrtOptionsLike {
    readonly wasmPaths?: string;
    readonly numThreads?: number;
    readonly simd?: boolean;
}

/** The slice of `OpenWakeWord.create` options the provider drives. */
interface OpenWakeWordCreateOptionsLike {
    readonly baseUrl?: string;
    readonly wakewordModels?: string[];
    readonly threshold?: number;
    readonly onDetection?: (event: DetectionEventLike) => void;
    readonly ort?: OrtOptionsLike;
}

/** The slice of openwakeword-web's `OpenWakeWord` instance. */
interface OpenWakeWordInstanceLike {
    predict(pcm: Int16Array): Promise<Record<string, number>>;
    reset(): Promise<void>;
}

/** The slice of openwakeword-web's `Microphone` helper. */
interface MicrophoneLike {
    readonly sampleRate: number | null;
    start(): Promise<void>;
    stop(): Promise<void>;
}

/** Constructor shape of openwakeword-web's `Microphone`. */
interface MicrophoneCtorLike {
    new (
        onFrame: (frame: Int16Array) => void,
        options?: { workletUrl?: string },
    ): MicrophoneLike;
}

/** The slice of the engine module the provider drives. */
export interface OpenWakeWordModuleLike {
    readonly OpenWakeWord: {
        create(
            options?: OpenWakeWordCreateOptionsLike,
        ): Promise<OpenWakeWordInstanceLike>;
    };
    readonly Microphone: MicrophoneCtorLike;
}

/**
 * Loads the runtime module; injectable so tests never touch the network,
 * the WASM binaries, or a real AudioWorklet.
 */
export type OpenWakeWordLoader = () => Promise<OpenWakeWordModuleLike>;

const defaultLoadModule: OpenWakeWordLoader = async () => ({
    ...(await import("openwakeword-web")),
    ...(await import("openwakeword-web/microphone")),
});

/** The default base URL: the J.A.R.V.I.S. server's wake-model route. */
const DEFAULT_WAKE_BASE_URL = "/api/wake/model/";

/** The default wake-word registry name. */
const DEFAULT_WAKE_WORD = "hey_jarvis";

/** The default detection threshold (the openWakeWord convention). */
const DEFAULT_THRESHOLD = 0.5;

/**
 * Whether the current runtime offers everything openwakeword-web needs:
 * a secure context (mic + AudioWorklet), Web Audio, and an audio worklet.
 * Cheap and side-effect free — UIs call this to decide whether the wake
 * toggle is available.
 *
 * @returns True when a wake detector can plausibly run here.
 */
export function isWakeSupported(): boolean {
    const globals = globalThis as {
        isSecureContext?: boolean;
        AudioWorkletNode?: unknown;
        AudioContext?: unknown;
        navigator?: { mediaDevices?: unknown };
    };
    return (
        globals.isSecureContext === true &&
        globals.AudioWorkletNode !== undefined &&
        globals.AudioContext !== undefined &&
        globals.navigator?.mediaDevices !== undefined
    );
}

/**
 * The on-device openWakeWord {@link WakeWordProvider}. One instance arms a
 * single detector; `start()` may be called again after `stop()` (a fresh
 * detection pass). A match arrives through {@link WakeCallbacks.onWake}
 * carrying its confidence, and the command streams through
 * {@link WakeCallbacks.onCommandAudio} from the match onward — starting with
 * the frames the pipeline had already captured while it was scoring the
 * phrase, which is what keeps a one-breath command whole (#121).
 */
export class OpenWakeWordWakeProvider implements WakeWordProvider {
    readonly id = "oww-browser";

    private readonly baseUrl: string;
    private readonly wakewordModels: string[];
    private readonly threshold: number;
    private readonly wasmPath: string | undefined;
    private readonly numThreads: number;
    private readonly workletUrl: string | undefined;
    private readonly loadModule: OpenWakeWordLoader;
    private readonly log: (message: string, error?: unknown) => void;
    /** Callbacks for the armed pass; dropped when detection stops. */
    private callbacks: WakeCallbacks | null = null;
    private instance: OpenWakeWordInstanceLike | null = null;
    private mic: MicrophoneLike | null = null;
    private armed = false;
    private fired = false;
    private predicting = false;
    /**
     * Captured frames awaiting prediction, in capture order (#121). The
     * feature pipeline's input must be contiguous — skipping a frame shifts
     * every later score — so frames queue here instead of being dropped, and
     * because the pipeline reaches the phrase some time *after* the phrase was
     * spoken, this queue is also what holds (and later recovers) the command's
     * opening. Bounded by {@link MAX_QUEUED_FRAMES}.
     */
    private toPredict: Int16Array[] = [];
    /** Ensures the backlog-cap warning is logged once per arm. */
    private backlogWarned = false;
    /**
     * Invalidates an in-flight `start()`/`stop()` race: incremented by every
     * stop, checked between the await points of a start.
     */
    private initSeq = 0;

    /**
     * @param options - Model URLs and detector tuning (see
     * {@link OpenWakeWordOptions}).
     * @param loadModule - Module loader override for tests.
     */
    constructor(
        options: OpenWakeWordOptions = {},
        loadModule?: OpenWakeWordLoader,
    ) {
        this.baseUrl = options.baseUrl ?? DEFAULT_WAKE_BASE_URL;
        this.wakewordModels = options.wakewordModels ?? [DEFAULT_WAKE_WORD];
        this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
        this.wasmPath = options.wasmPath;
        this.numThreads = options.numThreads ?? 1;
        this.workletUrl = options.workletUrl;
        this.loadModule = loadModule ?? defaultLoadModule;
        this.log = options.log ?? (() => {});
    }

    /**
     * Arms detection: loads the runtime module and the ONNX models
     * (fetched from `baseUrl`), opens the 16 kHz worklet microphone, and
     * lets frames flow into the feature pipeline.
     *
     * @param callbacks - Where matches — and, from the match onward, the
     * live command audio — are delivered.
     * @returns Resolves once the detector is listening for the wake phrase.
     */
    async start(callbacks: WakeCallbacks): Promise<void> {
        if (this.armed) {
            throw voiceError("engine", "wake detection is already active");
        }
        this.callbacks = callbacks;
        this.fired = false;
        this.predicting = false;
        this.toPredict = [];
        this.backlogWarned = false;
        const seq = ++this.initSeq;
        let instance: OpenWakeWordInstanceLike | null = null;
        let mic: MicrophoneLike | null = null;
        try {
            const module = await this.loadModule();
            if (seq !== this.initSeq) {
                return; // Stopped while the module loaded; nothing to do.
            }
            instance = await module.OpenWakeWord.create({
                baseUrl: this.baseUrl,
                wakewordModels: this.wakewordModels,
                threshold: this.threshold,
                onDetection: (event) => this.onDetection(event),
                ort: {
                    wasmPaths: this.wasmPath,
                    numThreads: this.numThreads,
                    simd: true,
                },
            });
            if (seq !== this.initSeq) {
                await instance.reset();
                return;
            }
            mic = new module.Microphone((frame) => this.onFrame(frame), {
                workletUrl: this.workletUrl,
            });
            this.instance = instance;
            this.mic = mic;
            await mic.start();
            if (seq !== this.initSeq) {
                return; // Stopped while the mic started; stop already ran.
            }
            this.armed = true;
        } catch (err) {
            this.callbacks = null;
            try {
                await mic?.stop();
            } catch {
                // A mic that will not stop is already dead.
            }
            try {
                await instance?.reset();
            } catch {
                // Models that will not reset are already gone.
            }
            throw micError(err, "could not start wake detection");
        }
    }

    /**
     * Disarms detection: the worklet mic is released, the models are
     * reset, the command stream ends, and no callback fires after the
     * returned promise resolves.
     *
     * @returns Resolves once the detector has fully stopped.
     */
    async stop(): Promise<void> {
        this.initSeq += 1;
        this.armed = false;
        this.callbacks = null;
        const mic = this.mic;
        this.mic = null;
        const instance = this.instance;
        this.instance = null;
        try {
            await mic?.stop();
        } catch {
            // A mic that will not stop is already dead.
        }
        try {
            await instance?.reset();
        } catch {
            // Models that will not reset are already gone.
        }
        this.toPredict = [];
        this.fired = false;
        this.predicting = false;
    }

    /**
     * One 16 kHz 16-bit PCM frame from the worklet. Before a match the frame
     * joins the prediction queue; after it, the frame *is* the command and is
     * handed straight out through `WakeCallbacks.onCommandAudio` — the same
     * microphone, nothing spliced (#121).
     *
     * @param frame - The frame's int16 PCM samples.
     */
    private onFrame(frame: Int16Array): void {
        if (this.fired) {
            this.emitCommandAudio(frame);
            return;
        }
        if (!this.armed) {
            return;
        }
        this.toPredict.push(frame);
        if (this.toPredict.length > MAX_QUEUED_FRAMES) {
            // The pipeline is ten seconds behind: shed the oldest audio so
            // memory stays bounded. This breaks the contiguity the feature
            // extractor needs, so it is a last resort — logged once per arm.
            this.toPredict.shift();
            if (!this.backlogWarned) {
                this.backlogWarned = true;
                this.log(
                    "wake detector is falling behind; shedding the oldest audio",
                );
            }
        }
        this.pump();
    }

    /**
     * Runs the oldest queued frame through the detector, one at a time. Every
     * captured frame is predicted in order — the feature pipeline is a
     * streaming extractor whose input must be contiguous (skipping a frame
     * shifts every later score, and the frames skipped while the phrase was
     * being scored would be the command's opening).
     */
    private pump(): void {
        if (this.predicting || this.fired || !this.armed) {
            return;
        }
        const instance = this.instance;
        if (instance === null) {
            return;
        }
        const frame = this.toPredict.shift();
        if (frame === undefined) {
            return;
        }
        this.predicting = true;
        void instance
            .predict(frame)
            .catch((err: unknown) => {
                this.fail(
                    voiceError(
                        "engine",
                        err instanceof Error
                            ? err.message
                            : "the wake detector failed",
                    ),
                );
            })
            .finally(() => {
                this.predicting = false;
                this.pump();
            });
    }

    /**
     * The threshold was crossed mid-predict (fires inside
     * {@link OpenWakeWordInstanceLike.predict}, with the crossing frame still
     * in flight): record the match, deliver the detection to the armed
     * callbacks, and then emit **every frame already captured after the
     * crossing frame**.
     *
     * That emission is the point (#121). The feature pipeline reaches the
     * phrase only after ingesting the audio that followed it, so by the time
     * the score crosses, the command's opening has already been captured —
     * and, being queued rather than dropped, it is still here. Emitting it
     * makes the wake session's stream start where the phrase ended: no
     * phrase, nothing clipped, nothing repeated. Fires at most once per start.
     *
     * @param event - The label and score that crossed the threshold.
     */
    private onDetection(event: DetectionEventLike): void {
        if (!this.armed || this.fired) {
            return;
        }
        this.fired = true;
        const recovered = this.toPredict;
        this.toPredict = [];
        // Deliver the match first: the client must be holding frames before
        // the first one arrives (the controller arms its hold from `onWake`).
        this.callbacks?.onWake({ confidence: event.score });
        if (recovered.length > 0) {
            this.log(
                `wake match: recovered ${recovered.length} queued frame(s) (${Math.round(
                    ((recovered.length * FRAME_SAMPLES) / MIC_SAMPLE_RATE) *
                        1000,
                )} ms) captured after the phrase`,
            );
        }
        for (const frame of recovered) {
            this.emitCommandAudio(frame);
        }
    }

    /**
     * Converts one frame to float PCM and hands it to the armed callbacks as
     * post-match command audio.
     *
     * @param frame - The frame's int16 PCM samples.
     */
    private emitCommandAudio(frame: Int16Array): void {
        this.callbacks?.onCommandAudio?.(pcmFromInt16(frame), MIC_SAMPLE_RATE);
    }

    /**
     * Delivers a failure to the armed callbacks and stops the detector (no
     * callback — match or command audio — fires afterwards). Idempotent: the
     * first failure wins.
     *
     * @param error - The failure to deliver.
     */
    private fail(error: VoiceError): void {
        const callbacks = this.callbacks;
        this.callbacks = null;
        void this.stop().catch(() => {
            // A detector that will not stop is already dead.
        });
        callbacks?.onError?.(error);
    }
}

/**
 * Creates the on-device openWakeWord wake-word provider.
 *
 * @param options - Model URLs and detector tuning (see
 * {@link OpenWakeWordOptions}).
 * @param loadModule - Module loader override for tests.
 * @returns An `OpenWakeWordWakeProvider`, or `null` when the runtime lacks a
 * secure context, Web Audio, or an audio worklet — the chat client uses
 * this to decide whether the wake toggle is available at all.
 */
export function createOpenWakeWord(
    options?: OpenWakeWordOptions,
    loadModule?: OpenWakeWordLoader,
): WakeWordProvider | null {
    if (!isWakeSupported()) {
        return null;
    }
    return new OpenWakeWordWakeProvider(options, loadModule);
}

/**
 * Converts a 16-bit PCM frame to float PCM normalized to `[-1, 1]` — the
 * convention the detector's command stream and the STT `feed()` seam share.
 *
 * @param int16 - The int16 PCM samples.
 * @returns The normalized float samples.
 */
function pcmFromInt16(int16: Int16Array): Float32Array {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        out[i] = int16[i] / 32768;
    }
    return out;
}
