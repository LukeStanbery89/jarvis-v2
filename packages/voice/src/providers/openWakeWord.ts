/**
 * Local WASM implementation of the {@link WakeWordProvider} seam (issue
 * #84, phase 4) — a streaming openWakeWord detector running entirely
 * on-device through `openwakeword-web` (a faithful browser port of David
 * Scripka's openWakeWord). This is the "Hey JARVIS" wake word: `start()`
 * arms a 16 kHz monitor that fires once per phrase, and — because that same
 * microphone keeps running — the provider retains the audio that *follows*
 * the match, so the client can seed the recognition session with the command
 * without ever replaying the phrase (#121).
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
 * Detection posture: prediction runs serialized (busy-drop — a frame that
 * arrives while a predict is in flight is skipped), the detector fires at
 * most once per `start()` (the `onWake` callback opens a session, which
 * stops the detector), and the retained buffer is 16 kHz mono float PCM
 * sized to `commandBufferMs` and emptied at every match — so it is strictly
 * post-match audio.
 */
import type { VoiceError, WakeCallbacks, WakeWordProvider } from "../types";
import { micError, voiceError } from "./internal";

/** The detector's capture rate; the retained buffer is mono at this rate. */
const MIC_SAMPLE_RATE = 16000;

/** One frame's worth of samples at the detector's 16 kHz rate (80 ms). */
const FRAME_SAMPLES = 1280;

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
     * How much audio to retain **after** the match, to seed the session that
     * opens a moment later. The detector keeps capturing while the wake cue
     * plays and the engine starts, so the reading taken at session open covers
     * the phrase's tail and whatever the user said in the gap — but never the
     * audio *before* the match (the wake phrase itself), because the buffer is
     * emptied the instant a match fires. Defaults to 2000 ms; the retained
     * window snaps to whole 1280-sample frames.
     */
    readonly commandBufferMs?: number;
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

/** The default post-match capture window; snapped to whole 1280 frames. */
const DEFAULT_COMMAND_BUFFER_MS = 2000;

/**
 * A fixed-capacity circular buffer of the detector's mono PCM at 16 kHz,
 * always holding the most recent `capacity` samples in chronological order.
 * The capacity is a whole number of 1280-sample frames, so a frame write
 * never straddles the ring's end. Emptied at every match, so what it holds
 * afterwards is strictly post-match audio (#121).
 */
class PcmRingBuffer {
    private readonly buffer: Float32Array;
    private readonly capacity: number;
    private writeHead = 0;
    private filled = 0;

    constructor(capacityMs: number) {
        const frames = Math.max(
            1,
            Math.ceil(((capacityMs / 1000) * MIC_SAMPLE_RATE) / FRAME_SAMPLES),
        );
        this.capacity = frames * FRAME_SAMPLES;
        this.buffer = new Float32Array(this.capacity);
    }

    /**
     * Appends a frame of samples, evicting the oldest.
     *
     * @param samples - The frame's float PCM samples.
     */
    push(samples: Float32Array): void {
        this.buffer.set(samples, this.writeHead);
        this.writeHead = (this.writeHead + samples.length) % this.capacity;
        this.filled = Math.min(this.filled + samples.length, this.capacity);
    }

    /**
     * The retained audio in chronological order (a fresh copy).
     *
     * @returns The most recent samples, oldest first; shorter than
     * `capacity` until the ring has filled.
     */
    snap(): Float32Array {
        const out = new Float32Array(this.filled);
        const start = this.writeHead - this.filled;
        if (start < 0) {
            out.set(this.buffer.subarray(this.capacity + start));
            out.set(this.buffer.subarray(0, this.writeHead), -start);
        } else {
            out.set(this.buffer.subarray(start, this.writeHead));
        }
        return out;
    }

    /** Empties the buffer (a fresh `start()`, or a match). */
    clear(): void {
        this.writeHead = 0;
        this.filled = 0;
    }
}

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
 * post-match buffer and detection pass). Detection results arrive through
 * {@link WakeCallbacks.onWake} carrying the match confidence and the
 * the match's timing; the session seed is taken from
 * {@link OpenWakeWordWakeProvider.drainPostMatch}.
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
    private readonly ring: PcmRingBuffer;
    /** Callbacks for the armed pass; dropped when detection stops. */
    private callbacks: WakeCallbacks | null = null;
    private instance: OpenWakeWordInstanceLike | null = null;
    private mic: MicrophoneLike | null = null;
    private armed = false;
    private fired = false;
    private predicting = false;
    /**
     * Invalidates an in-flight `start()`/`stop()` race: incremented by every
     * stop, checked between the await points of a start.
     */
    private initSeq = 0;

    /**
     * @param options - Model URLs, threshold, and buffer tuning (see
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
        this.ring = new PcmRingBuffer(
            options.commandBufferMs ?? DEFAULT_COMMAND_BUFFER_MS,
        );
    }

    /**
     * Arms detection: loads the runtime module and the ONNX models
     * (fetched from `baseUrl`), opens the 16 kHz worklet microphone, and
     * lets frames flow into the feature pipeline.
     *
     * @param callbacks - Where matches are delivered.
     * @returns Resolves once the detector is listening for the wake phrase.
     */
    async start(callbacks: WakeCallbacks): Promise<void> {
        if (this.armed) {
            throw voiceError("engine", "wake detection is already active");
        }
        this.callbacks = callbacks;
        this.fired = false;
        this.predicting = false;
        this.ring.clear();
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
     * reset, the post-match buffer is emptied, and no callback fires after
     * the returned promise resolves.
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
        this.ring.clear();
        this.fired = false;
        this.predicting = false;
    }

    /**
     * The post-match buffer's current contents, ending **now**. The buffer is
     * emptied at the match (see {@link OpenWakeWordWakeProvider.onDetection}),
     * so this is strictly the audio that followed the phrase — the command's
     * opening, captured while the wake cue played and the recognition engine
     * was still starting. Drained by the controller just before `stop()` and
     * fed to the session's engine, which then continues from its own live
     * input.
     *
     * @returns The post-match audio (16 kHz mono), or `null` when no match
     *   fired this arm or nothing was captured after it.
     */
    drainPostMatch(): Float32Array | null {
        if (!this.fired) {
            return null;
        }
        const drained = this.ring.snap();
        return drained.length > 0 ? drained : null;
    }

    /**
     * One 16 kHz 16-bit PCM frame from the worklet: retained in the ring
     * unconditionally, then driven through the detection pass — busy-dropped
     * if a predict is already running, so a slow pass can never stack behind
     * the live microphone.
     *
     * @param frame - The frame's int16 PCM samples.
     */
    private onFrame(frame: Int16Array): void {
        this.ring.push(pcmFromInt16(frame));
        if (!this.armed || this.fired || this.predicting) {
            return;
        }
        const instance = this.instance;
        if (instance === null) {
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
            });
    }

    /**
     * The threshold was crossed mid-predict (fires synchronously inside
     * {@link OpenWakeWordInstanceLike.predict}): record the match, **empty
     * the buffer**, and deliver the detection to the armed callbacks. Emptying
     * here is what makes the wake session's audio phrase-free by construction
     * (#121): everything the buffer accumulates from now until the session
     * opens is post-match audio — the command, never the phrase. Fires at most
     * once per start.
     *
     * @param event - The label and score that crossed the threshold.
     */
    private onDetection(event: DetectionEventLike): void {
        if (!this.armed || this.fired) {
            return;
        }
        this.fired = true;
        this.ring.clear();
        this.callbacks?.onWake({ confidence: event.score });
    }

    /**
     * Delivers a failure to the armed callbacks and stops the detector
     * (subsequent frames keep filling the ring but never fire). Idempotent:
     * the first failure wins.
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
 * @param options - Model URLs, threshold, and ring tuning (see
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
 * convention {@link OpenWakeWordOptions.commandBufferMs} capture and the STT
 * `feed()` seam share.
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
