/**
 * Local WASM implementation of the {@link SttProvider} seam (issue #84,
 * phase 3b) — Vosk (Kaldi) compiled to WebAssembly, driven in a Web Worker
 * through `vosk-browser`.
 *
 * This is the privacy path the phase plan promised: recognition runs fully
 * on-device, so there is no audio egress (Web Speech in Chrome sends the
 * stream to Google's servers), and it works where Web Speech does not —
 * Firefox, and any secure-context browser without a recognition engine. The
 * engine is ~40 MB of model weights, downloaded once per server into
 * `~/.jarvis/stt` and served same-origin at `GET /api/stt/model`; the
 * browser's vosk worker then persists the extracted model in IndexedDB, so
 * the archive is fetched across page loads only when the cache is empty.
 *
 * Engine contract honored here:
 * - Interim results stream to `onPartial` (trimmed, non-empty) for live UI.
 * - `partialresult` maps to `onPartial`; vosk's per-utterance `result`
 *   finals map to `onResult`. In continuous capture (VAD-owned endpointing)
 *   every final is a segment the controller accumulates and the session
 *   continues; without it, the first final is the whole transcript and the
 *   session settles right after delivering it (mirroring the Web Speech
 *   provider).
 * - `stop()` flushes: capture stops feeding, `retrieveFinalResult()` forces
 *   the engine to finalize whatever is pending, the resulting text arrives
 *   through `onResult`, and the session settles. An engine-native session
 *   that flushes without ever having produced a transcript reports
 *   `no-speech` (the controller owns the quiet no-speech path in continuous
 *   sessions, so the provider stays silent there).
 * - `cancel()` aborts and discards: capture is released, the recognizer is
 *   freed, and no callback for the session fires after it resolves.
 * - The loaded model outlives sessions (weights + worker are expensive);
 *   `dispose()` releases it (worker + memory) for when the client will
 *   never recognize again.
 * - Errors map to {@link VoiceError}: `permission-denied` (mic denied),
 *   `engine` (model load/worker/recognizer failures, a reaped mic track),
 *   `no-speech` (engine-native flush with nothing recognized).
 *
 * Like every browser provider in this package, browser APIs are looked up
 * structurally from `globalThis` (no DOM lib; node tests install fakes) and
 * the `vosk-browser` module itself loads lazily through an injectable
 * loader, so a missing install or a non-browser runtime never breaks
 * importing this file — it surfaces as `null` from {@link createVoskStt} or
 * a rejected `start()`.
 */
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    SttState,
    VoiceError,
} from "../types";

/** Options for {@link VoskSttProvider}. */
export interface VoskSttOptions {
    /**
     * URL of the model archive (`tar.gz` of the Vosk model folder). Defaults
     * to the J.A.R.V.I.S. server's same-origin model route
     * (`GET /api/stt/model`); override for other deployments. Relative URLs
     * resolve against the page inside the vosk worker.
     */
    readonly modelUrl?: string;
    /** Vosk worker log level. Defaults to `-1` (warnings only). */
    readonly logLevel?: number;
    /**
     * How long `stop()` waits for the engine's forced final result before
     * settling without it. Defaults to 300 ms — a worker round trip is
     * single-digit milliseconds when the engine is alive; the deadline only
     * bounds a wedged one.
     */
    readonly flushWaitMs?: number;
}

/** A mic track, structurally sliced (node tests install doubles). */
interface MediaStreamTrackLike {
    stop(): void;
    onended: (() => void) | null;
}

/** A media stream carrying one or more tracks. */
interface MediaStreamLike {
    getTracks(): MediaStreamTrackLike[];
}

/** The slice of `MediaDevices` the provider needs. */
interface MediaDevicesLike {
    getUserMedia(constraints: {
        audio: { echoCancellation: boolean };
    }): Promise<MediaStreamLike>;
}

/** A graph target node (sources, processors, gains, the destination). */
interface AudioNodeLike {
    connect(destination: AudioNodeLike): void;
    disconnect(): void;
}

/** The slice of `AudioBuffer` the feed path reads. */
interface AudioBufferLike {
    readonly sampleRate: number;
    getChannelData(channel: number): Float32Array;
}

/** The `onaudioprocess` event payload. */
interface AudioProcessingEventLike {
    readonly inputBuffer: AudioBufferLike;
}

/** The slice of `ScriptProcessorNode` the provider drives. */
interface ScriptProcessorNodeLike extends AudioNodeLike {
    onaudioprocess: ((event: AudioProcessingEventLike) => void) | null;
}

/** The zero-gain node that keeps the processor pulled without echo. */
interface GainNodeLike extends AudioNodeLike {
    readonly gain: { value: number };
}

/** The slice of `AudioContext` the provider needs. */
interface AudioContextLike extends AudioNodeLike {
    readonly sampleRate: number;
    createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
    createScriptProcessor(
        bufferSize: number,
        inputChannels: number,
        outputChannels: number,
    ): ScriptProcessorNodeLike;
    createGain(): GainNodeLike;
    resume(): Promise<void>;
    close(): Promise<void>;
}

/** Constructor for an audio context, as found on `globalThis`. */
type AudioContextCtor = new () => AudioContextLike;

/**
 * One recognition message from the vosk worker (union, loosely sliced).
 * Exported so test doubles can speak the exact shape.
 */
export interface VoskRecognizerMessage {
    readonly event: "result" | "partialresult" | "error";
    readonly result?: { readonly text?: string; readonly partial?: string };
    readonly error?: string;
}

/** The slice of vosk's `KaldiRecognizer` the provider drives. */
interface RecognizerLike {
    on(
        event: "result" | "partialresult" | "error",
        listener: (message: VoskRecognizerMessage) => void,
    ): void;
    acceptWaveformFloat(buffer: Float32Array, sampleRate: number): void;
    retrieveFinalResult(): void;
    remove(): void;
}

/** One model-level message (load result or failure). */
export interface VoskModelMessage {
    readonly event: "load" | "error";
    readonly result?: boolean;
    readonly error?: string;
}

/** The slice of vosk's `Model` the provider drives. */
interface ModelLike {
    on(
        event: "load" | "error",
        listener: (message: VoskModelMessage) => void,
    ): void;
    readonly KaldiRecognizer: new (sampleRate: number) => RecognizerLike;
    terminate(): void;
}

/** The slice of the `vosk-browser` module the provider drives. */
interface VoskModuleLike {
    createModel(modelUrl: string, logLevel?: number): Promise<ModelLike>;
}

/**
 * Loads the runtime module; injectable so tests never touch the network,
 * the WASM binary, or a real Web Worker.
 */
export type VoskModuleLoader = () => Promise<VoskModuleLike>;

/** The real module loader: a lazy dynamic import of `vosk-browser`. */
const defaultLoadModule: VoskModuleLoader = () => import("vosk-browser");

/** The default model URL: the J.A.R.V.I.S. server's model route. */
export const DEFAULT_VOSK_MODEL_URL = "/api/stt/model";

/** How long `stop()` waits for the engine's forced final (see options). */
const DEFAULT_FLUSH_WAIT_MS = 300;

/**
 * Finds `getUserMedia`, standard path (the vendor-prefixed era is over for
 * every engine this provider targets — they all ship WASM).
 *
 * @returns The function, or `null` outside a browser that offers one.
 */
function findUserMedia(): MediaDevicesLike["getUserMedia"] | null {
    const globals = globalThis as {
        navigator?: { mediaDevices?: MediaDevicesLike };
    };
    return globals.navigator?.mediaDevices?.getUserMedia ?? null;
}

/**
 * Finds the audio-context constructor, standard or prefixed.
 *
 * @returns The constructor, or `null` where Web Audio is unavailable.
 */
function findAudioContextCtor(): AudioContextCtor | null {
    const globals = globalThis as {
        AudioContext?: AudioContextCtor;
        webkitAudioContext?: AudioContextCtor;
    };
    return globals.AudioContext ?? globals.webkitAudioContext ?? null;
}

/**
 * Whether the current runtime offers everything the WASM engine needs: mic
 * access (secure contexts only), Web Audio, and WebAssembly. Cheap and
 * side-effect free — UIs call this to decide whether the local engine is
 * available (see `createVoskStt`).
 *
 * @returns True when the engine can plausibly run here.
 */
export function isVoskSupported(): boolean {
    const wasm = (globalThis as { WebAssembly?: unknown }).WebAssembly;
    return (
        findUserMedia() !== null &&
        findAudioContextCtor() !== null &&
        typeof wasm === "object" &&
        wasm !== null
    );
}

/**
 * The local WASM {@link SttProvider}. One instance serves any number of
 * sequential sessions over one shared model (weights + worker persist
 * across sessions); `start()` rejects while a session is live.
 */
export class VoskSttProvider implements SttProvider {
    readonly id = "vosk-wasm";

    private engineState: SttState = "idle";
    private readonly modelUrl: string;
    private readonly logLevel: number;
    private readonly flushWaitMs: number;
    private readonly loadModule: VoskModuleLoader;
    /** Cached module import; reset on failure so a later session retries. */
    private modulePromise: Promise<VoskModuleLike> | null = null;
    /** Pending model load; reset on failure (mirrors the Kokoro provider). */
    private modelPromise: Promise<ModelLike> | null = null;
    /** The loaded model, shared across sessions until `dispose()`. */
    private model: ModelLike | null = null;
    private recognizer: RecognizerLike | null = null;
    /** Callbacks for the active session; dropped when the session settles. */
    private callbacks: SttCallbacks | null = null;
    /** Id of the active session; events from any other id are dropped. */
    private activeSession: number | null = null;
    private sessionCounter = 0;
    /** Whether this session runs continuous (VAD-owned) capture. */
    private continuousSession = false;
    /** Set when this session delivered a usable (non-empty) final result. */
    private usableFinal = false;
    /** Set when this session already delivered an error. */
    private errorDelivered = false;
    private stream: MediaStreamLike | null = null;
    private context: AudioContextLike | null = null;
    private source: AudioNodeLike | null = null;
    private processor: ScriptProcessorNodeLike | null = null;
    private gain: GainNodeLike | null = null;
    /** Resolvers parked by a concurrent `stop()` until the session settles. */
    private stopWaiters: Array<() => void> = [];
    /** Resolver of the pending final-flush wait (`stop()`), if any. */
    private flushWaiter: ((text: string | null) => void) | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * @param options - Model URL, log level, and flush tuning (see
     * {@link VoskSttOptions}).
     * @param loadModule - Module loader override for tests.
     */
    constructor(options: VoskSttOptions = {}, loadModule?: VoskModuleLoader) {
        this.modelUrl = options.modelUrl ?? DEFAULT_VOSK_MODEL_URL;
        this.logLevel = options.logLevel ?? -1;
        this.flushWaitMs = options.flushWaitMs ?? DEFAULT_FLUSH_WAIT_MS;
        this.loadModule = loadModule ?? defaultLoadModule;
    }

    /** Current provider lifecycle, for UI display. */
    get state(): SttState {
        return this.engineState;
    }

    /**
     * Starts one recognition session: loads the model (cached across
     * sessions), opens the echo-cancelled mic, and feeds the recognizer
     * through the Web Audio graph.
     *
     * @param callbacks - Deliveries for this session only.
     * @param options - Per-session capture options. `{ continuous: true }`
     * keeps every recognized segment streaming to `onResult` while capture
     * continues (the VAD-owning controller accumulates and endpoints);
     * without it the first final is the whole transcript and the session
     * settles after delivering it.
     * @returns Resolves once the engine is capturing.
     */
    async start(
        callbacks: SttCallbacks,
        options?: SttStartOptions,
    ): Promise<void> {
        if (this.engineState !== "idle") {
            throw this.voiceError("engine", "recognition is already active");
        }
        const getUserMedia = findUserMedia();
        const contextCtor = findAudioContextCtor();
        if (getUserMedia === null || contextCtor === null) {
            throw this.voiceError(
                "unsupported",
                "speech recognition is unavailable in this browser",
            );
        }
        const session = ++this.sessionCounter;
        this.callbacks = callbacks;
        this.activeSession = session;
        this.continuousSession = options?.continuous ?? false;
        this.usableFinal = false;
        this.errorDelivered = false;
        this.engineState = "starting";
        try {
            const model = await this.loadModel();
            if (session !== this.activeSession) {
                return; // Cancelled while the model loaded; nothing to do.
            }
            let stream: MediaStreamLike | null = null;
            let context: AudioContextLike;
            try {
                stream = await getUserMedia({
                    audio: { echoCancellation: true },
                });
                context = new contextCtor();
            } catch (err) {
                this.releaseStream(stream);
                throw this.voiceError(
                    err instanceof Error &&
                        /permission|denied|not allowed/i.test(err.message)
                        ? "permission-denied"
                        : "engine",
                    err instanceof Error
                        ? err.message
                        : "could not open the microphone",
                );
            }
            if (session !== this.activeSession) {
                this.releaseStream(stream);
                return; // Cancelled while the mic opened.
            }
            const recognizer = new model.KaldiRecognizer(context.sampleRate);
            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(4096, 1, 1);
            // The processor only fires while the graph pulls it; a zero-gain
            // hop to the destination keeps it running without echoing the
            // microphone to the speakers.
            const gain = context.createGain();
            gain.gain.value = 0;
            source.connect(processor);
            processor.connect(gain);
            gain.connect(context);
            processor.onaudioprocess = (event) => {
                this.onAudio(session, event.inputBuffer);
            };
            recognizer.on("partialresult", (message) => {
                this.onPartialResult(session, message);
            });
            recognizer.on("result", (message) => {
                this.onFinalResult(session, message);
            });
            recognizer.on("error", (message) => {
                this.onRecognizerError(session, message);
            });
            const track = stream.getTracks()[0];
            if (track !== undefined) {
                track.onended = () => {
                    this.fail(
                        this.voiceError("engine", "the microphone track ended"),
                    );
                };
            }
            this.stream = stream;
            this.context = context;
            this.source = source;
            this.processor = processor;
            this.gain = gain;
            this.recognizer = recognizer;
            await context.resume().catch(() => {
                // A context that will not resume is already running or dead;
                // the first audio chunk decides which.
            });
            if (session !== this.activeSession) {
                return; // Cancelled while resuming; teardown already ran.
            }
            this.engineState = "running";
        } catch (err) {
            this.settle();
            throw toVoiceError(err, "could not start recognition");
        }
    }

    /**
     * Stops capture and flushes: the mic is released, the engine is asked to
     * finalize its pending audio (`retrieveFinalResult()`), and the
     * resulting text — or the last spontaneously finalized segment, whichever
     * the worker delivers first — is delivered through `onResult` before the
     * session settles. Continuous sessions settle silently when the flush
     * produced nothing (the controller owns the quiet no-speech path);
     * engine-native sessions report `no-speech` instead, mirroring the Web
     * Speech provider.
     *
     * @returns Resolves when the engine has fully stopped.
     */
    async stop(): Promise<void> {
        if (this.engineState === "idle") {
            return;
        }
        if (this.engineState === "starting") {
            await this.cancel();
            return;
        }
        if (this.engineState === "stopping") {
            await this.parkUntilSettled();
            return;
        }
        this.engineState = "stopping";
        this.teardownCapture();
        const recognizer = this.recognizer;
        if (recognizer !== null) {
            try {
                recognizer.retrieveFinalResult();
            } catch {
                // Settlement below owns the outcome either way.
            }
        }
        const flushed = await this.awaitFinalFlush();
        if (
            flushed !== null &&
            flushed !== "" &&
            !this.errorDelivered &&
            this.callbacks !== null
        ) {
            this.usableFinal = true;
            this.callbacks.onResult?.(flushed);
        }
        if (
            !this.usableFinal &&
            !this.errorDelivered &&
            !this.continuousSession
        ) {
            this.errorDelivered = true;
            this.callbacks?.onError?.(
                this.voiceError("no-speech", "no transcript was produced"),
            );
        }
        this.settle();
    }

    /**
     * Aborts the session and discards everything captured. Resolves only
     * after settlement, after which no callback for this session fires.
     */
    async cancel(): Promise<void> {
        if (this.engineState === "idle") {
            return;
        }
        this.settle();
    }

    /**
     * Releases the engine-wide resources: the active session (if any) is
     * cancelled first, then the model's worker and memory are freed and the
     * cached load promises are dropped, so a later session reloads from the
     * (browser-persistent) model cache.
     */
    async dispose(): Promise<void> {
        this.settle();
        const model = this.model;
        this.model = null;
        this.modelPromise = null;
        this.modulePromise = null;
        if (model !== null) {
            try {
                model.terminate();
            } catch {
                // A worker that will not die is already gone.
            }
        }
    }

    /**
     * Loads (or reuses) the shared model. A failed load resets the pending
     * promise so a later session retries — e.g. after the server finishes
     * downloading the model on first request.
     *
     * @returns The loaded model.
     */
    private async loadModel(): Promise<ModelLike> {
        if (this.model !== null) {
            return this.model;
        }
        if (this.modelPromise === null) {
            this.modelPromise = this.loadModule()
                .then((vosk) => vosk.createModel(this.modelUrl, this.logLevel))
                .then((model) => {
                    model.on("error", (message) => {
                        if (message.event !== "error") {
                            return;
                        }
                        this.fail(
                            this.voiceError(
                                "engine",
                                `the speech model failed: ${message.error ?? "unknown error"}`,
                            ),
                        );
                    });
                    this.model = model;
                    return model;
                })
                .catch((err: unknown) => {
                    this.modelPromise = null;
                    throw err;
                });
        }
        return this.modelPromise;
    }

    /**
     * One mic chunk: hands the engine the raw float samples at the
     * recognizer's own sample rate (vosk resamples internally to the
     * model's rate). No-ops for stale sessions or once capture stopped.
     *
     * @param session - Session the chunk belongs to.
     * @param buffer - The processed mic buffer.
     */
    private onAudio(session: number, buffer: AudioBufferLike): void {
        const recognizer = this.recognizer;
        if (
            session !== this.activeSession ||
            recognizer === null ||
            this.engineState !== "running"
        ) {
            return;
        }
        try {
            recognizer.acceptWaveformFloat(
                buffer.getChannelData(0),
                buffer.sampleRate,
            );
        } catch {
            this.fail(
                this.voiceError("engine", "the recognizer rejected audio"),
            );
        }
    }

    /**
     * Interim recognition text: live UI display only (trimmed, non-empty).
     *
     * @param session - Session the message belongs to.
     * @param message - The worker's `partialresult`.
     */
    private onPartialResult(
        session: number,
        message: VoskRecognizerMessage,
    ): void {
        if (session !== this.activeSession || this.callbacks === null) {
            return;
        }
        const text = (message.result?.partial ?? "").trim();
        if (text !== "") {
            this.callbacks.onPartial?.(text);
        }
    }

    /**
     * A final result: during the flush wait it is the forced final (its
     * text is handed to the parked `stop()`); while running it is a
     * recognized segment — delivered to `onResult`, and in engine-native
     * sessions it ends the capture (the engine has spoken its final word).
     *
     * @param session - Session the message belongs to.
     * @param message - The worker's `result`.
     */
    private onFinalResult(
        session: number,
        message: VoskRecognizerMessage,
    ): void {
        if (session !== this.activeSession) {
            return;
        }
        const text = (message.result?.text ?? "").trim();
        if (this.flushWaiter !== null) {
            this.resolveFlush(text);
            return;
        }
        if (this.engineState !== "running" || text === "") {
            return;
        }
        this.usableFinal = true;
        this.callbacks?.onResult?.(text);
        if (!this.continuousSession) {
            this.settle();
        }
    }

    /**
     * The recognizer failed mid-session.
     *
     * @param session - Session the message belongs to.
     * @param message - The worker's `error`.
     */
    private onRecognizerError(
        session: number,
        message: VoskRecognizerMessage,
    ): void {
        if (session !== this.activeSession) {
            return;
        }
        this.fail(
            this.voiceError(
                "engine",
                `recognition failed: ${message.error ?? "unknown error"}`,
            ),
        );
    }

    /**
     * Waits for the engine's forced final result, bounded by the flush
     * deadline. Resolved by the next `result` event (its text), or by the
     * deadline (null).
     *
     * @returns The flushed text, or `null` when the deadline fired first.
     */
    private awaitFinalFlush(): Promise<string | null> {
        return new Promise((resolve) => {
            this.flushWaiter = resolve;
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                const waiter = this.flushWaiter;
                this.flushWaiter = null;
                waiter?.(null);
            }, this.flushWaitMs);
        });
    }

    /**
     * Hands the flushed text to a pending `stop()` (empty string counts as
     * "flushed, nothing recognized") and cancels the deadline.
     *
     * @param text - The flushed text ("" when the engine had none).
     */
    private resolveFlush(text: string): void {
        this.clearFlushTimer();
        const waiter = this.flushWaiter;
        this.flushWaiter = null;
        waiter?.(text);
    }

    /** Cancels the pending flush deadline, if any. */
    private clearFlushTimer(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * Ends the session with a delivered error (mid-session failures only —
     * `start()` rejections go to the caller directly). Idempotent per
     * session: the first failure wins.
     *
     * @param error - The failure to deliver.
     */
    private fail(error: VoiceError): void {
        if (this.activeSession === null || this.errorDelivered) {
            return;
        }
        this.errorDelivered = true;
        const callbacks = this.callbacks;
        this.settle();
        callbacks?.onError?.(error);
    }

    /**
     * Returns the provider to `idle` and releases the session: capture is
     * torn down, the recognizer is freed, callbacks are dropped (no further
     * deliveries), and parked `stop()` waiters — plus any pending flush —
     * are woken.
     */
    private settle(): void {
        this.engineState = "idle";
        this.teardownCapture();
        const recognizer = this.recognizer;
        this.recognizer = null;
        if (recognizer !== null) {
            try {
                recognizer.remove();
            } catch {
                // A recognizer that will not free is already gone.
            }
        }
        this.callbacks = null;
        this.activeSession = null;
        this.continuousSession = false;
        const waiters = this.stopWaiters;
        this.stopWaiters = [];
        for (const waiter of waiters) {
            waiter();
        }
        if (this.flushWaiter !== null) {
            this.resolveFlush("");
        }
    }

    /**
     * Parks a concurrent `stop()` until the session settles (the parked
     * resolver is woken by {@link settle}).
     *
     * @returns Resolves once the engine has fully stopped.
     */
    private parkUntilSettled(): Promise<void> {
        return new Promise((resolve) => {
            this.stopWaiters.push(resolve);
        });
    }

    /**
     * Releases the capture pipeline: the processor stops firing, the graph
     * is disconnected, the mic tracks are stopped, and the audio context is
     * closed. Safe to call repeatedly.
     */
    private teardownCapture(): void {
        const processor = this.processor;
        this.processor = null;
        if (processor !== null) {
            processor.onaudioprocess = null;
            try {
                processor.disconnect();
            } catch {
                // A node that will not disconnect is already dead.
            }
        }
        for (const node of [
            this.source,
            this.gain,
        ] as Array<AudioNodeLike | null>) {
            if (node !== null) {
                try {
                    node.disconnect();
                } catch {
                    // Same posture as the processor.
                }
            }
        }
        this.source = null;
        this.gain = null;
        this.releaseStream(this.stream);
        this.stream = null;
        const context = this.context;
        this.context = null;
        if (context !== null) {
            void context.close().catch(() => {
                // A context that will not close is already unusable.
            });
        }
    }

    /**
     * Stops every track of a stream, ignoring failures.
     *
     * @param stream - The stream to release, or `null`.
     */
    private releaseStream(stream: MediaStreamLike | null): void {
        if (stream === null) {
            return;
        }
        for (const track of stream.getTracks()) {
            track.onended = null;
            try {
                track.stop();
            } catch {
                // A track that will not stop is already dead.
            }
        }
    }

    /**
     * Builds a {@link VoiceError} (used for throws as well as deliveries).
     *
     * @param code - Machine-readable failure class.
     * @param message - Human-readable detail.
     * @returns The error object.
     */
    private voiceError(code: VoiceError["code"], message: string): VoiceError {
        return { code, message };
    }
}

/**
 * Creates the local WASM STT provider.
 *
 * @param options - Provider options (model URL, log level, flush tuning).
 * @param loadModule - Module loader override for tests.
 * @returns A `VoskSttProvider`, or `null` when the runtime lacks mic
 * access, Web Audio, or WebAssembly — callers fall back to the next engine
 * in their chain (the Web Speech provider in the chat client).
 */
export function createVoskStt(
    options?: VoskSttOptions,
    loadModule?: VoskModuleLoader,
): SttProvider | null {
    if (!isVoskSupported()) {
        return null;
    }
    return new VoskSttProvider(options, loadModule);
}

/**
 * Normalizes an unknown `start()` rejection into a {@link VoiceError}
 * (`VoiceError`-shaped values pass through; anything else becomes an
 * engine error).
 *
 * @param err - The thrown value.
 * @param fallback - Message for the generic engine error.
 * @returns A voice error.
 */
function toVoiceError(err: unknown, fallback: string): VoiceError {
    if (typeof err === "object" && err !== null) {
        const candidate = err as { code?: unknown; message?: unknown };
        if (
            typeof candidate.code === "string" &&
            typeof candidate.message === "string"
        ) {
            return {
                code: candidate.code as VoiceError["code"],
                message: candidate.message,
            };
        }
    }
    return {
        code: "engine",
        message: err instanceof Error ? err.message : fallback,
    };
}
