/**
 * Web Audio energy-based {@link VadProvider} (issue #84, phase 3) — the
 * first browser VAD engine behind the seam.
 *
 * A dedicated `getUserMedia` track (echo-cancelled, matching the P2 capture
 * choice) feeds an `AnalyserNode`; a fixed-cadence loop computes the RMS
 * level and runs a two-edge state machine: speech must exceed the threshold
 * for `onsetMs` before `onSpeechStart`, and must stay below it for
 * `releaseMs` before `onSpeechEnd`. The detector is deliberately dumb — it
 * only answers "is someone speaking"; the controller builds the
 * "pause ⇒ send" and "press with silence ⇒ idle" timeouts from its events.
 *
 * Like the Web Speech provider, browser APIs are looked up structurally from
 * `globalThis` so this package needs no DOM lib and never touches browser
 * APIs at module scope (node tests install fakes on `globalThis`). This is
 * the energy-detector MVP: robust enough for headset/quiet-room use; a
 * model-backed engine (e.g. Silero WASM) can replace it behind the same
 * seam without touching any client.
 */
import type { VadCallbacks, VadProvider, VoiceError } from "../types";

/** Options for {@link BrowserVadProvider}. */
export interface BrowserVadOptions {
    /**
     * RMS level above which the mic is considered to carry speech. Defaults
     * to `0.02` (quiet room ≈ <0.005, speech ≈ 0.05–0.3 after AEC/AGC).
     */
    readonly threshold?: number;
    /** Loudness sustained this long before `onSpeechStart`. Defaults to 120 ms. */
    readonly onsetMs?: number;
    /** Silence sustained this long before `onSpeechEnd`. Defaults to 350 ms. */
    readonly releaseMs?: number;
    /** Analysis cadence. Defaults to 50 ms. */
    readonly intervalMs?: number;
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

/** The slice of `MediaDevices` the detector needs. */
interface MediaDevicesLike {
    getUserMedia(constraints: {
        audio: { echoCancellation: boolean };
    }): Promise<MediaStreamLike>;
}

/** The slice of `AnalyserNode` the detector reads. */
interface AnalyserNodeLike {
    fftSize: number;
    getFloatTimeDomainData(array: Float32Array): void;
}

/** An analyser's upstream source node. */
interface MediaStreamAudioSourceNodeLike {
    connect(destination: AnalyserNodeLike): void;
}

/** The slice of `AudioContext` the detector needs. */
interface AudioContextLike {
    createMediaStreamSource(
        stream: MediaStreamLike,
    ): MediaStreamAudioSourceNodeLike;
    createAnalyser(): AnalyserNodeLike;
    close(): Promise<void>;
}

/** Constructor for an audio context, as found on `globalThis`. */
type AudioContextCtor = new () => AudioContextLike;

/**
 * Finds `getUserMedia`, standard or vendor-prefixed paths.
 *
 * The function is returned **bound to its `MediaDevices` receiver**: the
 * browser requires it to be invoked with the `mediaDevices` object as
 * `this` (Chrome throws `Illegal invocation` otherwise), and the caller
 * here holds it detached from its own object.
 *
 * @returns The function, or `null` outside a browser that offers one
 * (node, plain-HTTP non-localhost origins, permission-less contexts).
 */
function findUserMedia(): MediaDevicesLike["getUserMedia"] | null {
    const globals = globalThis as {
        navigator?: { mediaDevices?: MediaDevicesLike };
    };
    const devices = globals.navigator?.mediaDevices;
    if (devices?.getUserMedia === undefined) {
        return null;
    }
    return devices.getUserMedia.bind(devices);
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
 * Whether the current runtime offers everything the energy detector needs.
 * Cheap and side-effect free — UIs call this to decide whether VAD-driven
 * endpointing is available (see `createBrowserVad`).
 */
export function isVadSupported(): boolean {
    return findUserMedia() !== null && findAudioContextCtor() !== null;
}

/**
 * The energy-level {@link VadProvider}. One instance serves any number of
 * sequential sessions; `start()` rejects while a session is live.
 */
export class BrowserVadProvider implements VadProvider {
    readonly id = "browser-energy";

    private readonly threshold: number;
    private readonly onsetMs: number;
    private readonly releaseMs: number;
    private readonly intervalMs: number;
    /** Callbacks for the active session; dropped when the session settles. */
    private callbacks: VadCallbacks | null = null;
    private sessionActive = false;
    private stream: MediaStreamLike | null = null;
    private context: AudioContextLike | null = null;
    private analyser: AnalyserNodeLike | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private buffer: Float32Array = new Float32Array(0);
    /** Two-edge state machine: currently inside detected speech. */
    private speaking = false;
    /** Timestamp loudness was first seen in the current onset run (`Date.now()`). */
    private loudSince: number | null = null;
    /** Timestamp silence was first seen in the current release run (`Date.now()`). */
    private quietSince: number | null = null;

    /**
     * @param options - Threshold and debounce tuning (see
     * {@link BrowserVadOptions}).
     */
    constructor(options: BrowserVadOptions = {}) {
        this.threshold = options.threshold ?? 0.02;
        this.onsetMs = options.onsetMs ?? 120;
        this.releaseMs = options.releaseMs ?? 350;
        this.intervalMs = options.intervalMs ?? 50;
    }

    /**
     * Arms detection on its own echo-cancelled microphone track.
     *
     * @param callbacks - Where speech-start/speech-end events are delivered.
     * @returns Resolves once the detector is monitoring the microphone;
     * rejects when the track or audio context cannot be established, so a
     * caller can degrade to engine-native endpointing instead of surfacing
     * an error.
     */
    async start(callbacks: VadCallbacks): Promise<void> {
        if (this.sessionActive) {
            throw this.voiceError(
                "engine",
                "voice activity detection is already active",
            );
        }
        const getUserMedia = findUserMedia();
        const contextCtor = findAudioContextCtor();
        if (getUserMedia === null || contextCtor === null) {
            throw this.voiceError(
                "unsupported",
                "voice activity detection is unavailable in this browser",
            );
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
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(stream).connect(analyser);
        this.stream = stream;
        this.context = context;
        this.analyser = analyser;
        this.buffer = new Float32Array(analyser.fftSize);
        this.speaking = false;
        this.loudSince = null;
        this.quietSince = null;
        this.callbacks = callbacks;
        this.sessionActive = true;
        // A revoked/reaped track ends detection mid-session.
        const track = stream.getTracks()[0];
        if (track !== undefined) {
            track.onended = () => {
                this.fail(
                    this.voiceError("engine", "the microphone track ended"),
                );
            };
        }
        this.timer = setInterval(() => {
            this.tick();
        }, this.intervalMs);
    }

    /**
     * Disarms detection; no callback fires after the returned promise
     * resolves. Idempotent.
     */
    async stop(): Promise<void> {
        if (!this.sessionActive) {
            return;
        }
        this.sessionActive = false;
        this.callbacks = null;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.releaseStream(this.stream);
        this.stream = null;
        const context = this.context;
        this.context = null;
        this.analyser = null;
        this.speaking = false;
        this.loudSince = null;
        this.quietSince = null;
        if (context !== null) {
            await context.close().catch(() => {
                // A context that will not close is already unusable.
            });
        }
    }

    /**
     * One analysis step: read the level and advance the two-edge state
     * machine. No-ops once the session has settled.
     */
    private tick(): void {
        const callbacks = this.callbacks;
        if (callbacks === null || this.analyser === null) {
            return;
        }
        let rms: number;
        try {
            this.analyser.getFloatTimeDomainData(this.buffer);
            let sum = 0;
            for (let i = 0; i < this.buffer.length; i += 1) {
                sum += this.buffer[i] * this.buffer[i];
            }
            rms = Math.sqrt(sum / this.buffer.length);
        } catch {
            this.fail(this.voiceError("engine", "the audio analyser failed"));
            return;
        }
        const now = Date.now();
        if (rms >= this.threshold) {
            this.quietSince = null;
            if (!this.speaking) {
                if (this.loudSince === null) {
                    this.loudSince = now;
                } else if (now - this.loudSince >= this.onsetMs) {
                    this.speaking = true;
                    callbacks.onSpeechStart();
                }
            }
        } else {
            this.loudSince = null;
            if (this.speaking) {
                if (this.quietSince === null) {
                    this.quietSince = now;
                } else if (now - this.quietSince >= this.releaseMs) {
                    this.speaking = false;
                    callbacks.onSpeechEnd();
                }
            }
        }
    }

    /**
     * Ends the session with a delivered error (mid-session failures only —
     * `start()` rejections go to the caller directly).
     *
     * @param error - The failure to deliver.
     */
    private fail(error: VoiceError): void {
        if (this.callbacks === null) {
            return;
        }
        const callbacks = this.callbacks;
        void this.stop();
        callbacks.onError?.(error);
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
 * Creates the browser's default VAD provider.
 *
 * @param options - Detector tuning (see {@link BrowserVadOptions}).
 * @returns A `BrowserVadProvider`, or `null` when Web Audio + mic access
 * are unavailable — callers fall back to engine-native endpointing (the
 * same secure-context rule the STT provider shares: HTTPS or localhost).
 */
export function createBrowserVad(
    options?: BrowserVadOptions,
): VadProvider | null {
    if (!isVadSupported()) {
        return null;
    }
    return new BrowserVadProvider(options);
}
