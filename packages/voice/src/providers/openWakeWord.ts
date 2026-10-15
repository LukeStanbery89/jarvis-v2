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
 * `start()`, and the match emits every buffered frame from the **onset** of
 * the phrase's score upward. That onset sits at the phrase's end, whereas the
 * threshold crossing lands a couple of frames later and can be *inside* a
 * command spoken in the same breath — so cutting at the onset is what keeps a
 * one-breath command whole without the phrase (#121).
 */
import type { VoiceError, WakeCallbacks, WakeWordProvider } from "../types";
import { micError, voiceError } from "./internal";

/** The detector's capture rate; the command stream is mono at this rate. */
const MIC_SAMPLE_RATE = 16000;

/** One frame's worth of samples at the detector's 16 kHz rate (80 ms). */
const FRAME_SAMPLES = 1280;

/**
 * The buffered-frame cap (#121): captured frames awaiting a `predict()`, plus
 * the scored history the cut searches. Ten seconds of audio — a stalled main
 * thread recovers from far less. Past this the oldest frames are shed so
 * memory stays bounded, at the cost of the pipeline's contiguity (logged; see
 * {@link OpenWakeWordWakeProvider.onFrame}).
 */
const MAX_CAPTURED_FRAMES = (10 * MIC_SAMPLE_RATE) / FRAME_SAMPLES;

/**
 * The score below which a frame is considered to be *before* the wake phrase
 * (#121). The score is at the noise floor (≈0) on silence and ramps up over
 * the phrase's last frames before plateauing — and the ramp's start, unlike
 * the detection threshold's crossing, sits at the phrase's end. Measured
 * level-independent: scaling the input by 0.25 moves the crossing by less than
 * a frame but leaves the ramp where it is, so a plain small floor is stable.
 * Exported so `scripts/probe-wake-latency.mjs` reproduces the cut exactly.
 */
export const SCORE_FLOOR = 0.01;

/**
 * How far back the cut searches for the ramp's start — 12 frames, 960 ms. The
 * phrase's own plateau runs ~500 ms past the crossing, and the search stops at
 * the *first* frame at the noise floor, so a wider window can only find the
 * same frame (or the phrase's true end), never more phrase. Exported alongside
 * {@link SCORE_FLOOR} for the probe.
 */
export const CUT_SCAN_FRAMES = 12;

/** One captured frame and the detector's score for it (null until scored). */
interface CapturedFrame {
    readonly pcm: Int16Array;
    score: number | null;
}

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
     * Captured frames, oldest first (#121), each with the score prediction
     * gave it — the feature pipeline's input must be contiguous, so a frame is
     * never skipped; and because the pipeline reaches the phrase only after
     * ingesting the audio that followed it, this buffer is also what holds
     * (and later recovers) the command's opening. Bounded by
     * {@link MAX_CAPTURED_FRAMES}.
     */
    private captured: CapturedFrame[] = [];
    /** Index of the next frame to predict; everything before it is scored. */
    private cursor = 0;
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
        this.captured = [];
        this.cursor = 0;
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
        this.captured = [];
        this.cursor = 0;
        this.fired = false;
        this.predicting = false;
    }

    /**
     * One 16 kHz 16-bit PCM frame from the worklet. Before a match the frame is
     * buffered for prediction (and kept for the match's cut); from the match
     * onward it *is* the command and is handed straight out through
     * `WakeCallbacks.onCommandAudio` — the same microphone, nothing spliced
     * (#121).
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
        this.captured.push({ pcm: frame, score: null });
        if (this.captured.length > MAX_CAPTURED_FRAMES) {
            // The pipeline is ten seconds behind: shed the oldest audio so
            // memory stays bounded. This breaks the contiguity the feature
            // extractor needs, so it is a last resort — logged once per arm.
            this.captured.shift();
            this.cursor = Math.max(0, this.cursor - 1);
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
     * Scores the oldest unpredicted frame, one at a time. Every captured frame
     * is predicted in order — the feature pipeline is a streaming extractor
     * whose input must stay contiguous (skipping a frame shifts every later
     * score, and the frames skipped while the phrase was being scored would be
     * the command's opening).
     */
    private pump(): void {
        if (this.predicting || this.fired || !this.armed) {
            return;
        }
        const instance = this.instance;
        if (instance === null) {
            return;
        }
        const entry = this.captured[this.cursor];
        if (entry === undefined) {
            return;
        }
        this.predicting = true;
        void instance
            .predict(entry.pcm)
            .then((predictions) => {
                entry.score = maxScore(predictions);
            })
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
                this.cursor += 1;
                this.pump();
            });
    }

    /**
     * The threshold was crossed mid-predict (fires inside
     * {@link OpenWakeWordInstanceLike.predict}, with the crossing frame still
     * in flight): record the match, deliver the detection to the armed
     * callbacks, and then emit **every buffered frame from the phrase's end
     * onward**.
     *
     * That emission is the point (#121). The feature pipeline reaches the
     * phrase only after ingesting the audio that followed it, so by the time
     * the score crosses, the command's opening has already been captured — and
     * because the cut is the score's *onset* rather than the crossing, the
     * frames between them (which a one-breath command occupies) are included
     * while nothing of the phrase is. Fires at most once per start.
     *
     * @param event - The label and score that crossed the threshold.
     */
    private onDetection(event: DetectionEventLike): void {
        if (!this.armed || this.fired) {
            return;
        }
        this.fired = true;
        const recovered = this.captured.slice(this.commandStartIndex());
        this.captured = [];
        this.cursor = 0;
        // Deliver the match first: the client must be holding frames before
        // the first one arrives (the controller arms its hold from `onWake`).
        this.callbacks?.onWake({ confidence: event.score });
        if (recovered.length > 0) {
            this.log(
                `wake match: recovered ${recovered.length} buffered frame(s) (${Math.round(
                    ((recovered.length * FRAME_SAMPLES) / MIC_SAMPLE_RATE) *
                        1000,
                )} ms) captured after the phrase`,
            );
        }
        for (const entry of recovered) {
            this.emitCommandAudio(entry.pcm);
        }
    }

    /**
     * The index of the first frame after the wake phrase: the most recent
     * frame whose score was still at the noise floor, plus one.
     *
     * The score ramps up over the phrase's final frames and then plateaus for
     * several hundred milliseconds, so the *crossing* is a couple of frames
     * into the plateau — and, for a command spoken in the same breath, already
     * inside the command. The ramp's onset is at the phrase's end, which is
     * where the stream must start: any later clips the command, any earlier
     * includes the phrase. Searching back from the crossing (bounded by
     * {@link CUT_SCAN_FRAMES}) stops at the plateau's start; when no quiet
     * frame is in the window, the crossing frame itself is the cut.
     *
     * @returns The index to start emitting from.
     */
    private commandStartIndex(): number {
        const from = Math.max(0, this.cursor - CUT_SCAN_FRAMES);
        for (let i = this.cursor - 1; i >= from; i -= 1) {
            const score = this.captured[i]?.score;
            if (score !== null && score !== undefined && score < SCORE_FLOOR) {
                return i + 1;
            }
        }
        return this.cursor;
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
 * The highest score `predict` reported for a frame — the detector's own
 * confidence that a wake phrase ends there (`predict` returns one entry per
 * registered model). Used to locate the phrase's end in the score timeline
 * (#121); a frame with no models is scored 0, i.e. "not the phrase".
 *
 * @param predictions - The per-label scores `predict` returned.
 * @returns The highest score, or 0 when there are none.
 */
function maxScore(predictions: Record<string, number>): number {
    const scores = Object.values(predictions);
    return scores.length > 0 ? Math.max(...scores) : 0;
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
