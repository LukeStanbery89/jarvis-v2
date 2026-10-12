/**
 * Vosk WASM STT provider tests (issue #84, phase 3b).
 *
 * The `vosk-browser` module loads through the injectable loader, so the
 * suite drives a fake module/model/recognizer trio and never touches the
 * network, WASM, or a Web Worker; `navigator.mediaDevices.getUserMedia` and
 * the Web Audio graph are installed on `globalThis` per test (the same
 * approach as the browser VAD tests), and vitest's fake timers drive the
 * flush deadline — so the whole engine contract (partials, finals,
 * continuous accumulation, flush, cancellation, error mapping) is exercised
 * deterministically with no real clock or microphone.
 */
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from "vitest";
import {
    DEFAULT_VOSK_MODEL_URL,
    VoskSttProvider,
    createVoskStt,
    isVoskSupported,
    resampleLinear,
} from "../src/providers/vosk";
import type {
    VoskModelMessage,
    VoskRecognizerMessage,
} from "../src/providers/vosk";
import type { SttCallbacks, VoiceError } from "../src/types";

/** Recording sink for provider deliveries. */
interface Recorder {
    partials: string[];
    results: string[];
    errors: VoiceError[];
    callbacks: SttCallbacks;
}

function makeRecorder(): Recorder {
    const recorder: Recorder = {
        partials: [],
        results: [],
        errors: [],
        callbacks: {
            onPartial: (text) => {
                recorder.partials.push(text);
            },
            onResult: (text) => {
                recorder.results.push(text);
            },
            onError: (error) => {
                recorder.errors.push(error);
            },
        },
    };
    return recorder;
}

/** A mic track double. */
class FakeTrack {
    stopped = false;
    onended: (() => void) | null = null;
    stop(): void {
        this.stopped = true;
    }
}

/** A stream double carrying one track. */
class FakeStream {
    constructor(readonly track: FakeTrack) {}
    getTracks(): FakeTrack[] {
        return [this.track];
    }
}

/** A mic audio buffer double. */
class FakeAudioBuffer {
    constructor(
        readonly sampleRate: number,
        private readonly data: Float32Array,
    ) {}
    getChannelData(_channel: number): Float32Array {
        return this.data;
    }
}

/** A graph node double. */
class FakeNode {
    disconnected = false;
    readonly connections: unknown[] = [];
    connect(destination: unknown): void {
        this.connections.push(destination);
    }
    disconnect(): void {
        this.disconnected = true;
    }
}

/** A script-processor double the test drives like the browser would. */
class FakeProcessor extends FakeNode {
    onaudioprocess: ((event: { inputBuffer: FakeAudioBuffer }) => void) | null =
        null;
    /** Test driver: fire one audio-processing callback. */
    dispatch(buffer: FakeAudioBuffer): void {
        this.onaudioprocess?.({ inputBuffer: buffer });
    }
}

/** A zero-gain node double. */
class FakeGain extends FakeNode {
    readonly gain = { value: 1 };
}

/** An audio-context double exposing the nodes the provider wires. */
class FakeAudioContext {
    /** Every instance ever created (the provider builds its own). */
    static instances: FakeAudioContext[] = [];
    closed = false;
    resumed = false;
    readonly sampleRate = 48000;
    readonly source = new FakeNode();
    readonly processor = new FakeProcessor();
    readonly gain = new FakeGain();
    readonly destination = new FakeNode();

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    createMediaStreamSource(_stream: FakeStream): FakeNode {
        return this.source;
    }

    createScriptProcessor(
        _bufferSize: number,
        _inputChannels: number,
        _outputChannels: number,
    ): FakeProcessor {
        return this.processor;
    }

    createGain(): FakeGain {
        return this.gain;
    }

    async resume(): Promise<void> {
        this.resumed = true;
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    /** The provider's (most recently created) context. */
    static latest(): FakeAudioContext {
        return FakeAudioContext.instances[
            FakeAudioContext.instances.length - 1
        ];
    }
}

/** A recognizer double: records chunks, delivers emitted worker messages. */
class FakeRecognizer {
    removed = false;
    readonly chunks: Array<{ data: Float32Array; sampleRate: number }> = [];
    retrieveCalls = 0;
    private readonly listeners = new Map<
        string,
        Array<(message: VoskRecognizerMessage) => void>
    >();

    constructor(
        readonly sampleRate: number,
        private readonly model: FakeModel,
    ) {
        model.recognizers.push(this);
    }

    on(
        event: "result" | "partialresult" | "error",
        listener: (message: VoskRecognizerMessage) => void,
    ): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
    }

    /** Test driver: emit one worker message to this recognizer's listeners. */
    emit(
        event: "result" | "partialresult" | "error",
        message: VoskRecognizerMessage,
    ): void {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(message);
        }
    }

    acceptWaveformFloat(data: Float32Array, sampleRate: number): void {
        this.chunks.push({ data, sampleRate });
    }

    retrieveFinalResult(): void {
        this.retrieveCalls += 1;
    }

    remove(): void {
        this.removed = true;
    }
}

/**
 * Builds the `KaldiRecognizer` constructor a fake model hands out: each
 * `new` registers the recognizer with the spawning model. A module-level
 * factory (rather than a closure over `this` in the getter) keeps
 * `@typescript-eslint/no-this-alias` quiet.
 *
 * @param model - The model the spawned recognizers register with.
 * @returns The constructor.
 */
function makeRecognizerCtor(
    model: FakeModel,
): new (sampleRate: number) => FakeRecognizer {
    return class extends FakeRecognizer {
        constructor(sampleRate: number) {
            super(sampleRate, model);
        }
    };
}

/** A model double: spawns recognizer doubles, emits model-level messages. */
class FakeModel {
    terminated = false;
    readonly recognizers: FakeRecognizer[] = [];
    private readonly listeners = new Map<
        string,
        Array<(message: VoskModelMessage) => void>
    >();

    on(
        event: "load" | "error",
        listener: (message: VoskModelMessage) => void,
    ): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
    }

    /** Test driver: emit one model-level message (load result or error). */
    emit(event: "load" | "error", message: VoskModelMessage): void {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(message);
        }
    }

    get KaldiRecognizer(): new (sampleRate: number) => FakeRecognizer {
        return makeRecognizerCtor(this);
    }

    terminate(): void {
        this.terminated = true;
    }
}

/** Installed browser + module fakes for the current test. */
interface Fakes {
    /** The mic track the fake stream carries. */
    readonly track: FakeTrack;
    /** The `getUserMedia` mock (call + constraint assertions). */
    readonly getUserMedia: ReturnType<typeof vi.fn>;
    /** The fake vosk module handed to the provider's loader. */
    readonly module: {
        createVoskClient: Mock<
            (options: {
                modelUrl: string;
                workerUrl?: string;
                wasmUrl?: string;
                logLevel?: number;
            }) => Promise<FakeModel>
        >;
    };
    /** The fake model createVoskClient resolves with. */
    readonly model: FakeModel;
    /** The provider's (most recently created) recognizer. */
    readonly recognizer: FakeRecognizer;
    /** The provider's audio context (created inside `start`). */
    readonly context: FakeAudioContext;
    /** Makes the next `getUserMedia` reject with the given error. */
    failGetUserMedia(err: Error): void;
    /** Makes `createVoskClient` reject with the given error until cleared. */
    failModelLoad(err: Error | null): void;
    /** Fires the track's `onended` (mid-session death). */
    endTrack(): void;
}

/**
 * Installs `navigator.mediaDevices.getUserMedia`, `AudioContext`, and a
 * fake engine module on `globalThis` for one test.
 *
 * @returns The handles the test drives.
 */
function installFakes(): Fakes {
    const track = new FakeTrack();
    const model = new FakeModel();
    const state: { mediaError: Error | null; modelError: Error | null } = {
        mediaError: null,
        modelError: null,
    };
    const getUserMedia = vi.fn(() => {
        if (state.mediaError !== null) {
            return Promise.reject(state.mediaError);
        }
        return Promise.resolve(new FakeStream(track));
    });
    const createVoskClient = vi.fn(() => {
        if (state.modelError !== null) {
            return Promise.reject(state.modelError);
        }
        return Promise.resolve(model);
    });
    const module = { createVoskClient };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    return {
        track,
        getUserMedia,
        module,
        model,
        get recognizer() {
            return model.recognizers[model.recognizers.length - 1];
        },
        get context() {
            return FakeAudioContext.latest();
        },
        failGetUserMedia: (err) => {
            state.mediaError = err;
        },
        failModelLoad: (err) => {
            state.modelError = err;
        },
        endTrack: () => {
            track.onended?.();
        },
    };
}

/**
 * Builds a provider wired to the fakes.
 *
 * @param fakes - The installed fakes.
 * @param flushWaitMs - Flush deadline override (short, for tests).
 * @returns The provider.
 */
function makeProvider(fakes: Fakes, flushWaitMs = 100): VoskSttProvider {
    return new VoskSttProvider(
        { modelUrl: "/api/stt/model", flushWaitMs },
        () => Promise.resolve(fakes.module),
    );
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("support probes", () => {
    it("reports unsupported in a bare node runtime", () => {
        vi.unstubAllGlobals();
        expect(isVoskSupported()).toBe(false);
        expect(createVoskStt()).toBeNull();
    });

    it("reports unsupported without WebAssembly", () => {
        installFakes();
        vi.stubGlobal("WebAssembly", undefined);
        expect(isVoskSupported()).toBe(false);
    });

    it("creates a provider when the browser fakes are installed", () => {
        installFakes();
        expect(isVoskSupported()).toBe(true);
        expect(createVoskStt()).toBeInstanceOf(VoskSttProvider);
    });

    it("defaults the model URL to the server route", () => {
        expect(DEFAULT_VOSK_MODEL_URL).toBe("/api/stt/model");
    });
});

describe("session lifecycle", () => {
    it("loads the model, opens an echo-cancelled mic, and wires the graph", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        expect(fakes.module.createVoskClient).toHaveBeenCalledTimes(1);
        expect(fakes.module.createVoskClient.mock.calls[0][0].modelUrl).toBe(
            "/api/stt/model",
        );
        expect(fakes.getUserMedia).toHaveBeenCalledTimes(1);
        expect(fakes.getUserMedia.mock.calls[0][0]).toEqual({
            audio: { echoCancellation: true },
        });
        expect(fakes.context.resumed).toBe(true);
        expect(fakes.context.source.disconnected).toBe(false);
        // The chain is source -> processor -> zero-gain hop -> destination;
        // the hop must target the context's destination, never the context
        // itself (the real DOM rejects connect(context) with an overload
        // error).
        expect(fakes.context.source.connections).toEqual([
            fakes.context.processor,
        ]);
        expect(fakes.context.processor.connections).toEqual([
            fakes.context.gain,
        ]);
        expect(fakes.context.gain.connections).toEqual([
            fakes.context.destination,
        ]);
        expect(provider.state).toBe("running");
        const stopped = provider.stop();
        vi.advanceTimersByTime(200);
        await stopped;
    });

    it("feeds mic chunks to the recognizer at the context sample rate", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        await provider.start(makeRecorder().callbacks);
        const recognizer = fakes.recognizer;
        expect(recognizer.sampleRate).toBe(48000);
        fakes.context.processor.dispatch(
            new FakeAudioBuffer(48000, new Float32Array([0.1, -0.2])),
        );
        expect(recognizer.chunks).toHaveLength(1);
        expect(recognizer.chunks[0].data[0]).toBeCloseTo(0.1, 5);
        expect(recognizer.chunks[0].data[1]).toBeCloseTo(-0.2, 5);
        expect(recognizer.chunks[0].sampleRate).toBe(48000);
        const stopped = provider.stop();
        vi.advanceTimersByTime(200);
        await stopped;
        // Capture released: the handler is detached, dispatching is inert.
        fakes.context.processor.dispatch(
            new FakeAudioBuffer(48000, new Float32Array([0.3])),
        );
        expect(recognizer.chunks).toHaveLength(1);
    });

    it("resamples look-back audio to the recognizer's rate instead of recreating it", async () => {
        // The wake/barge look-back replay is 16 kHz; the recognizer runs at
        // the context rate (48 kHz). Feeding the raw rate makes the vosk
        // worker recreate the recognizer — discarding the replayed audio's
        // recognition state and re-flipping on the next live chunk.
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        await provider.start(makeRecorder().callbacks);
        const recognizer = fakes.recognizer;
        provider.feed(new Float32Array([0, 1, 0, -1]), 16000);
        expect(recognizer.chunks).toHaveLength(1);
        expect(recognizer.chunks[0].sampleRate).toBe(48000);
        // 16k → 48k is exact ×3: each input sample lands on every third
        // output sample, linear interpolation between.
        const data = recognizer.chunks[0].data;
        expect(data.length).toBe(12);
        expect(data[0]).toBeCloseTo(0, 5);
        expect(data[1]).toBeCloseTo(1 / 3, 5);
        expect(data[2]).toBeCloseTo(2 / 3, 5);
        expect(data[3]).toBeCloseTo(1, 5);
        // The recognizer was never recreated: the same instance still
        // receives the live mic chunks afterwards.
        fakes.context.processor.dispatch(
            new FakeAudioBuffer(48000, new Float32Array([0.5])),
        );
        expect(fakes.model.recognizers).toHaveLength(1);
        expect(recognizer.chunks).toHaveLength(2);
        expect(recognizer.chunks[1].data[0]).toBeCloseTo(0.5, 5);
    });

    it("feeds the start() replay before any live capture", async () => {
        // The wake/barge replay must reach the recognizer before the
        // engine's own mic delivers: out-of-order audio garbles a streaming
        // decoder. start({ feed }) places the replay between recognizer
        // creation and the first live chunk.
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, {
            continuous: true,
            feed: { pcm: new Float32Array([0.25, -0.25]), sampleRate: 16000 },
        });
        const recognizer = fakes.recognizer;
        expect(recognizer.chunks).toHaveLength(1);
        expect(recognizer.chunks[0].sampleRate).toBe(48000);
        expect(recognizer.chunks[0].data).toHaveLength(6); // 16k → 48k ×3
        // A live chunk lands after the replay, in order.
        fakes.context.processor.dispatch(
            new FakeAudioBuffer(48000, new Float32Array([0.5])),
        );
        expect(recognizer.chunks).toHaveLength(2);
        expect(recognizer.chunks[1].data[0]).toBeCloseTo(0.5, 5);
        await provider.cancel();
    });

    it("reuses one model across sessions and frees each recognizer", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        await provider.start(makeRecorder().callbacks);
        const first = fakes.recognizer;
        const stopped = provider.stop();
        vi.advanceTimersByTime(200);
        await stopped;
        expect(first.removed).toBe(true);
        await provider.start(makeRecorder().callbacks);
        const second = fakes.recognizer;
        expect(fakes.module.createVoskClient).toHaveBeenCalledTimes(1);
        expect(second).not.toBe(first);
        await provider.cancel();
    });

    it("rejects a second start while a session is live", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        await provider.start(makeRecorder().callbacks);
        await expect(
            provider.start(makeRecorder().callbacks),
        ).rejects.toMatchObject({ code: "engine" });
        await provider.cancel();
    });

    it("rejects start when the microphone cannot be opened", async () => {
        const fakes = installFakes();
        fakes.failGetUserMedia(
            new Error("Permission denied by the user agent"),
        );
        const provider = makeProvider(fakes);
        await expect(
            provider.start(makeRecorder().callbacks),
        ).rejects.toMatchObject({ code: "permission-denied" });
        fakes.failGetUserMedia(new Error("device busy"));
        await expect(
            provider.start(makeRecorder().callbacks),
        ).rejects.toMatchObject({ code: "engine" });
    });

    it("rejects start when the model fails to load, and retries later", async () => {
        const fakes = installFakes();
        fakes.failModelLoad(new Error("download failed"));
        const provider = makeProvider(fakes);
        await expect(
            provider.start(makeRecorder().callbacks),
        ).rejects.toMatchObject({ code: "engine", message: "download failed" });
        expect(fakes.getUserMedia).not.toHaveBeenCalled();
        fakes.failModelLoad(null);
        await provider.start(makeRecorder().callbacks);
        expect(fakes.module.createVoskClient).toHaveBeenCalledTimes(2);
        const stopped = provider.stop();
        vi.advanceTimersByTime(200);
        await stopped;
    });

    it("a stop() during start cancels the session quietly", async () => {
        const fakes = installFakes();
        // Gate the model load so start() is still awaiting it.
        let release!: (model: FakeModel) => void;
        const gated = new Promise<FakeModel>((resolve) => {
            release = resolve;
        });
        fakes.module.createVoskClient.mockImplementation(() => gated);
        const provider = makeProvider(fakes);
        const startPromise = provider.start(makeRecorder().callbacks);
        await provider.stop();
        release(fakes.model);
        await startPromise;
        expect(fakes.getUserMedia).not.toHaveBeenCalled();
        expect(provider.state).toBe("idle");
    });
});

describe("deliveries", () => {
    it("streams trimmed partials", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.recognizer.emit("partialresult", {
            event: "partialresult",
            result: { partial: " hello " },
        });
        fakes.recognizer.emit("partialresult", {
            event: "partialresult",
            result: { partial: "" },
        });
        expect(recorder.partials).toEqual(["hello"]);
        await provider.cancel();
    });

    it("engine-native: the first final is the transcript and ends capture", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: " hello world " },
        });
        expect(recorder.results).toEqual(["hello world"]);
        expect(provider.state).toBe("idle");
        expect(fakes.track.stopped).toBe(true);
        expect(fakes.recognizer.removed).toBe(true);
        // Idempotent stop after an engine-native settle.
        await provider.stop();
        expect(recorder.errors).toEqual([]);
    });

    it("ignores empty finals while running", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "  " },
        });
        expect(recorder.results).toEqual([]);
        expect(provider.state).toBe("running");
        await provider.cancel();
    });

    it("continuous capture delivers every segment and keeps running", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "first segment" },
        });
        fakes.recognizer.emit("partialresult", {
            event: "partialresult",
            result: { partial: "second" },
        });
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "second segment" },
        });
        expect(recorder.results).toEqual(["first segment", "second segment"]);
        expect(provider.state).toBe("running");
        expect(fakes.track.stopped).toBe(false);
        await provider.cancel();
    });

    it("drops events from a superseded session", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const first = makeRecorder();
        await provider.start(first.callbacks);
        const stale = fakes.recognizer;
        await provider.cancel();
        const second = makeRecorder();
        await provider.start(second.callbacks);
        stale.emit("partialresult", {
            event: "partialresult",
            result: { partial: "stale" },
        });
        stale.emit("result", {
            event: "result",
            result: { text: "stale final" },
        });
        expect(first.partials).toEqual([]);
        expect(first.results).toEqual([]);
        expect(second.partials).toEqual([]);
        expect(second.results).toEqual([]);
        await provider.cancel();
    });
});

describe("flush and cancellation", () => {
    it("stop() forces the final result and delivers it", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        const stopPromise = provider.stop();
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "last words" },
        });
        await stopPromise;
        expect(fakes.recognizer.retrieveCalls).toBe(1);
        expect(recorder.results).toEqual(["last words"]);
        expect(provider.state).toBe("idle");
        expect(fakes.track.stopped).toBe(true);
    });

    it("stop() delivers the first flushed result only", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        const stopPromise = provider.stop();
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "flushed" },
        });
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "late straggler" },
        });
        await stopPromise;
        expect(recorder.results).toEqual(["flushed"]);
    });

    it("stop() settles silently when the flush produced nothing (continuous)", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        const stopPromise = provider.stop();
        vi.advanceTimersByTime(200); // flush deadline fires, no result came
        await stopPromise;
        expect(recorder.results).toEqual([]);
        expect(recorder.errors).toEqual([]); // the controller owns quiet no-speech
        expect(provider.state).toBe("idle");
    });

    it("stop() reports no-speech on an empty engine-native flush", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const stopPromise = provider.stop();
        vi.advanceTimersByTime(200);
        await stopPromise;
        expect(recorder.errors).toEqual([
            { code: "no-speech", message: "no transcript was produced" },
        ]);
        expect(provider.state).toBe("idle");
    });

    it("a concurrent stop() parks until the session settles", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        const first = provider.stop();
        const second = provider.stop();
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "flushed" },
        });
        await Promise.all([first, second]);
        expect(recorder.results).toEqual(["flushed"]);
        expect(provider.state).toBe("idle");
    });

    it("cancel() discards a session mid-flush with no deliveries", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        const stopPromise = provider.stop();
        await provider.cancel();
        await stopPromise;
        fakes.recognizer.emit("partialresult", {
            event: "partialresult",
            result: { partial: "late" },
        });
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "late final" },
        });
        expect(recorder.results).toEqual([]);
        expect(recorder.errors).toEqual([]);
        expect(provider.state).toBe("idle");
    });

    it("stop() guarantees no callback fires afterwards", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        const stopped = provider.stop();
        vi.advanceTimersByTime(200);
        await stopped;
        fakes.recognizer.emit("partialresult", {
            event: "partialresult",
            result: { partial: "late" },
        });
        fakes.recognizer.emit("result", {
            event: "result",
            result: { text: "late" },
        });
        expect(recorder.partials).toEqual([]);
        expect(recorder.results).toEqual([]);
    });
});

describe("failures", () => {
    it("a recognizer error delivers one engine error and settles", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        fakes.recognizer.emit("error", {
            event: "error",
            error: "decoder crashed",
        });
        expect(recorder.errors).toHaveLength(1);
        expect(recorder.errors[0].code).toBe("engine");
        expect(provider.state).toBe("idle");
        expect(fakes.track.stopped).toBe(true);
    });

    it("a model error delivers one engine error and settles", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        fakes.model.emit("error", { event: "error", error: "worker died" });
        expect(recorder.errors).toEqual([
            { code: "engine", message: "the speech model failed: worker died" },
        ]);
        expect(provider.state).toBe("idle");
    });

    it("a mic track end delivers one engine error and settles", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        fakes.endTrack();
        expect(recorder.errors).toEqual([
            { code: "engine", message: "the microphone track ended" },
        ]);
        expect(fakes.track.stopped).toBe(true);
    });

    it("a rejected audio chunk delivers one engine error and settles", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        fakes.recognizer.acceptWaveformFloat = () => {
            throw new Error("bad chunk");
        };
        fakes.context.processor.dispatch(
            new FakeAudioBuffer(48000, new Float32Array([0.1])),
        );
        expect(recorder.errors).toEqual([
            { code: "engine", message: "the recognizer rejected audio" },
        ]);
        expect(provider.state).toBe("idle");
    });
});

describe("dispose", () => {
    it("terminates the model and reloads it on the next session", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        await provider.start(makeRecorder().callbacks);
        const stopped = provider.stop();
        vi.advanceTimersByTime(200);
        await stopped;
        await provider.dispose();
        expect(fakes.model.terminated).toBe(true);
        await provider.start(makeRecorder().callbacks);
        expect(fakes.module.createVoskClient).toHaveBeenCalledTimes(2);
        await provider.cancel();
    });

    it("cancels a live session without deliveries and terminates the model", async () => {
        const fakes = installFakes();
        const provider = makeProvider(fakes);
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks, { continuous: true });
        await provider.dispose();
        expect(recorder.results).toEqual([]);
        expect(recorder.errors).toEqual([]);
        expect(fakes.track.stopped).toBe(true);
        expect(fakes.model.terminated).toBe(true);
        expect(provider.state).toBe("idle");
    });
});

describe("resampleLinear", () => {
    it("returns the input unchanged when the rates match", () => {
        const pcm = new Float32Array([0.1, -0.2, 0.3]);
        expect(resampleLinear(pcm, 16000, 16000)).toBe(pcm);
        expect(resampleLinear(new Float32Array(0), 16000, 48000)).toHaveLength(
            0,
        );
    });

    it("upsamples 16 kHz to 48 kHz at exact ×3 positions", () => {
        const out = resampleLinear(new Float32Array([0, 1]), 16000, 48000);
        expect(out.length).toBe(6);
        expect(out[0]).toBeCloseTo(0, 5);
        expect(out[1]).toBeCloseTo(1 / 3, 5);
        expect(out[2]).toBeCloseTo(2 / 3, 5);
        expect(out[3]).toBeCloseTo(1, 5);
        // The tail clamps at the boundary sample.
        expect(out[4]).toBeCloseTo(1, 5);
        expect(out[5]).toBeCloseTo(1, 5);
    });

    it("downsamples 48 kHz to 16 kHz by picking interpolated positions", () => {
        const out = resampleLinear(
            new Float32Array([0, 3, 0, -3]),
            48000,
            16000,
        );
        expect(out.length).toBe(1);
        expect(out[0]).toBeCloseTo(0, 5);
        const out2 = resampleLinear(
            new Float32Array([0, 3, 0, -3, 0, 3]),
            48000,
            16000,
        );
        expect(out2.length).toBe(2);
        expect(out2[0]).toBeCloseTo(0, 5);
        expect(out2[1]).toBeCloseTo(-3, 5);
    });
});
