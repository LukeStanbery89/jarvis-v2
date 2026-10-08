/**
 * Web Speech API implementation of the {@link SttProvider} seam (issue #84,
 * phase 2 — the first browser engine; a local WASM model follows behind the
 * same interface).
 *
 * Chrome/Edge expose `SpeechRecognition`, Safari `webkitSpeechRecognition`;
 * both are looked up structurally from `globalThis` so this package needs no
 * DOM lib and never touches browser APIs at module scope (node tests import
 * this file freely). Chrome's recognition is cloud-backed — the egress fact
 * is documented in the README and accepted for phase 2; the local provider
 * becomes the default once it lands.
 *
 * Engine contract honored here:
 * - Interim results stream to `onPartial` (trimmed, non-empty) for live UI.
 * - Final results stream to `onResult` (trimmed, non-empty) exactly once;
 *   a final that trims to empty is treated as "no transcript", not silence.
 * - `stop()` flushes: the engine delivers its final (if any) through the
 *   callbacks and `onend` settles the provider back to `idle`.
 * - `cancel()` aborts and settles before resolving — no callback for the
 *   cancelled session fires after it, and stale engine events (a late
 *   `onresult`/`onend` from a previous session) are dropped by session id.
 * - Errors map to {@link VoiceError} codes: `no-speech`, `permission-denied`
 *   (not-allowed / service-not-allowed), `engine` (audio-capture, network,
 *   anything else); the engine's own `aborted` code is ignored (it belongs
 *   to cancellation, which has its own path).
 */
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    SttState,
    VoiceError,
} from "../types";

/** One recognized alternative (structural slice of the DOM type). */
interface SpeechAlternativeLike {
    readonly transcript: string;
}

/** One recognition result: final or interim, indexable by alternative. */
interface SpeechResultLike {
    readonly isFinal: boolean;
    readonly length: number;
    [index: number]: SpeechAlternativeLike;
}

/** The result list delivered with every `onresult`. */
interface SpeechResultListLike {
    readonly length: number;
    [index: number]: SpeechResultLike;
}

/** `onresult` event (structural slice). */
interface SpeechResultEventLike {
    /** Index into `results` where new results start this event. */
    readonly resultIndex: number;
    readonly results: SpeechResultListLike;
}

/** `onerror` event (structural slice). */
interface SpeechErrorEventLike {
    readonly error: string;
}

/** The slice of `SpeechRecognition` this provider drives. */
interface SpeechRecognitionLike {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    maxAlternatives: number;
    onresult: ((event: SpeechResultEventLike) => void) | null;
    onerror: ((event: SpeechErrorEventLike) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

/** Constructor for a recognition engine, as found on `globalThis`. */
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * Options for {@link WebSpeechSttProvider}.
 */
export interface WebSpeechSttOptions {
    /**
     * BCP-47 language tag for recognition (e.g. `"en-US"`). Defaults to the
     * browser locale at `start()` time.
     */
    readonly lang?: string;
}

/**
 * Finds the browser's recognition constructor, standard or prefixed.
 *
 * @returns The constructor, or `null` outside a browser that offers one
 * (node, Firefox, plain-HTTP non-localhost origins).
 */
function findRecognitionCtor(): SpeechRecognitionCtor | null {
    const globals = globalThis as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return globals.SpeechRecognition ?? globals.webkitSpeechRecognition ?? null;
}

/**
 * Whether the current runtime offers Web Speech recognition at all. Cheap
 * and side-effect free — UIs call this to decide whether the mic button
 * renders enabled (see `createBrowserStt`).
 */
export function isWebSpeechSupported(): boolean {
    return findRecognitionCtor() !== null;
}

/**
 * The Web Speech {@link SttProvider}. One instance serves any number of
 * sequential sessions; `start()` rejects while a session is live.
 */
export class WebSpeechSttProvider implements SttProvider {
    readonly id = "web-speech";

    private engineState: SttState = "idle";
    private recognition: SpeechRecognitionLike | null = null;
    /** Callbacks for the active session; dropped when the session settles. */
    private callbacks: SttCallbacks | null = null;
    /** Id of the active session; events from any other id are dropped. */
    private activeSession: number | null = null;
    private sessionCounter = 0;
    /** Set when this session delivered a usable (non-empty) final result. */
    private usableFinal = false;
    /** Set when this session already delivered an error. */
    private errorDelivered = false;
    /** Resolvers parked by `stop()` until the engine settles. */
    private stopWaiters: Array<() => void> = [];

    constructor(private readonly options: WebSpeechSttOptions = {}) {}

    /** Current provider lifecycle, for UI display. */
    get state(): SttState {
        return this.engineState;
    }

    /**
     * Starts one recognition session.
     *
     * @param callbacks - Deliveries for this session only.
     * @param options - Per-session capture options. `{ continuous: true }`
     * keeps the engine capturing across pauses — final-segment results may
     * arrive while recognition continues — and is how a VAD-owning caller
     * (issue #84, phase 3) takes over endpointing from the engine's own
     * silence detection.
     * @returns Resolves once the engine is capturing (it may already have
     * been told to start; results arrive via the callbacks).
     */
    async start(
        callbacks: SttCallbacks,
        options?: SttStartOptions,
    ): Promise<void> {
        if (this.engineState !== "idle") {
            throw this.voiceError("engine", "recognition is already active");
        }
        const ctor = findRecognitionCtor();
        if (ctor === null) {
            throw this.voiceError(
                "unsupported",
                "speech recognition is unavailable in this browser",
            );
        }
        const recognition = new ctor();
        const session = ++this.sessionCounter;
        this.recognition = recognition;
        this.callbacks = callbacks;
        this.activeSession = session;
        this.usableFinal = false;
        this.errorDelivered = false;
        recognition.continuous = options?.continuous ?? false;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang =
            this.options.lang ??
            (typeof navigator !== "undefined" && navigator.language
                ? navigator.language
                : "en-US");
        recognition.onresult = (event) => {
            this.onResults(session, event);
        };
        recognition.onerror = (event) => {
            this.onEngineError(session, event.error);
        };
        recognition.onend = () => {
            this.onEngineEnd(session);
        };
        this.engineState = "starting";
        try {
            // Throws synchronously on invalid state (e.g. an engine that
            // never fully released the microphone); permission problems
            // surface asynchronously as onerror instead.
            recognition.start();
        } catch (err) {
            this.settle();
            throw this.voiceError(
                "engine",
                err instanceof Error ? err.message : "could not start capture",
            );
        }
        this.engineState = "running";
    }

    /**
     * Stops capture and flushes: the engine delivers its final transcript
     * (if any) through the active callbacks, then the session settles.
     *
     * @returns Resolves when the engine has fully stopped.
     */
    async stop(): Promise<void> {
        if (this.engineState === "idle") {
            return;
        }
        this.engineState = "stopping";
        const recognition = this.recognition;
        if (recognition !== null) {
            try {
                recognition.stop();
            } catch {
                // onend owns settlement regardless.
            }
        }
        await new Promise<void>((resolve) => {
            this.stopWaiters.push(resolve);
        });
    }

    /**
     * Aborts the session and discards everything captured. Resolves only
     * after settlement, after which no callback for this session fires.
     */
    async cancel(): Promise<void> {
        if (this.engineState === "idle") {
            return;
        }
        const recognition = this.recognition;
        if (recognition !== null) {
            try {
                recognition.abort();
            } catch {
                // Settlement below makes further deliveries impossible.
            }
        }
        this.settle();
    }

    /**
     * Handles one batch of engine results for a session.
     *
     * @param session - Session the engine is delivering for.
     * @param event - The `onresult` event.
     */
    private onResults(session: number, event: SpeechResultEventLike): void {
        if (session !== this.activeSession || this.callbacks === null) {
            return;
        }
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            const text = (result[0]?.transcript ?? "").trim();
            if (result.isFinal) {
                // An empty final is not a transcript — it is the absence of
                // one; onend reports it as no-speech.
                if (text !== "") {
                    this.usableFinal = true;
                    this.callbacks.onResult?.(text);
                }
            } else if (text !== "") {
                this.callbacks.onPartial?.(text);
            }
        }
    }

    /**
     * Maps an engine error to a {@link VoiceError} and delivers it once.
     *
     * @param session - Session the error belongs to.
     * @param code - The engine's error string.
     */
    private onEngineError(session: number, code: string): void {
        if (session !== this.activeSession || this.errorDelivered) {
            return;
        }
        if (code === "aborted") {
            // Cancellation's own signal — cancel() has its own path.
            return;
        }
        const error =
            code === "no-speech"
                ? this.voiceError("no-speech", "no speech was detected")
                : code === "not-allowed" || code === "service-not-allowed"
                  ? this.voiceError(
                        "permission-denied",
                        "microphone access was denied",
                    )
                  : this.voiceError("engine", `recognition failed: ${code}`);
        this.errorDelivered = true;
        this.callbacks?.onError?.(error);
    }

    /**
     * Settles the session when the engine stops: reports a missing
     * transcript (no final, no error) and returns to `idle`.
     *
     * @param session - Session that ended.
     */
    private onEngineEnd(session: number): void {
        if (session !== this.activeSession) {
            return;
        }
        if (!this.usableFinal && !this.errorDelivered) {
            this.errorDelivered = true;
            this.callbacks?.onError?.(
                this.voiceError("no-speech", "no transcript was produced"),
            );
        }
        this.settle();
    }

    /**
     * Returns the provider to `idle` and releases the session: callbacks
     * are dropped (no further deliveries) and parked `stop()` waiters wake.
     */
    private settle(): void {
        this.engineState = "idle";
        this.recognition = null;
        this.callbacks = null;
        this.activeSession = null;
        const waiters = this.stopWaiters;
        this.stopWaiters = [];
        for (const waiter of waiters) {
            waiter();
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
 * Creates the browser's default STT provider.
 *
 * @param options - Provider options (recognition language).
 * @returns A `WebSpeechSttProvider`, or `null` when Web Speech is
 * unavailable — callers hide the mic affordance and explain why (the
 * secure-context rule: HTTPS or localhost).
 */
export function createBrowserStt(
    options?: WebSpeechSttOptions,
): SttProvider | null {
    if (!isWebSpeechSupported()) {
        return null;
    }
    return new WebSpeechSttProvider(options);
}
