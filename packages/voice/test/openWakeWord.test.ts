/**
 * openWakeWord provider tests.
 *
 * The provider is driven with a fake engine module (a fake `OpenWakeWord`
 * instance whose `fire()` the test uses to simulate the library detecting a
 * phrase mid-`predict`, and a fake `Microphone` whose frames the test pushes
 * by hand) — no network, no WASM, no AudioWorklet. Assertions cover the
 * command stream (frames after the match, and only after it, are delivered —
 * the phrase never reaches the recognition engine, #121), busy-drop
 * prediction serialization, firing-at-most-once, clean start/stop cycles, and
 * the injected-loader path the browser client (and any future client) relies
 * on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    OpenWakeWordWakeProvider,
    createOpenWakeWord,
    isWakeSupported,
} from "../src/index";
import type { OpenWakeWordModuleLike, OpenWakeWordOptions } from "../src/index";
import type { VoiceError } from "../src/index";

/** The slice of create options the fake records and honors. */
interface CreateOptionsRecord {
    readonly baseUrl?: string;
    readonly wakewordModels?: string[];
    readonly threshold?: number;
    readonly onDetection?: (event: { label: string; score: number }) => void;
    readonly ort?: {
        wasmPaths?: string;
        numThreads?: number;
        simd?: boolean;
    };
}

/** Per-test knobs a fake `Microphone` consults. */
interface MicKnobs {
    startError: Error | null;
}

/** Fake `OpenWakeWord` instance: the test calls `fire()` to detect. */
class FakeOww {
    predictCalls = 0;
    resetCalls = 0;
    private readonly onDetection:
        ((event: { label: string; score: number }) => void) | null;

    constructor(
        onDetection: ((event: { label: string; score: number }) => void) | null,
    ) {
        this.onDetection = onDetection;
    }

    async predict(): Promise<Record<string, number>> {
        this.predictCalls += 1;
        return {};
    }

    /** Simulates the library detecting a phrase from within `predict`. */
    fire(label: string, score: number): void {
        this.onDetection?.({ label, score });
    }

    async reset(): Promise<void> {
        this.resetCalls += 1;
    }
}

/** Fake `Microphone`: the test pushes 16-bit frames by hand. */
class FakeMicrophone {
    sampleRate: number | null = 16000;
    startCalls = 0;
    stopCalls = 0;
    private readonly onFrame: (frame: Int16Array) => void;
    private readonly knobs: MicKnobs;

    constructor(
        onFrame: (frame: Int16Array) => void,
        _opts: { workletUrl?: string },
        knobs: MicKnobs,
    ) {
        this.onFrame = onFrame;
        this.knobs = knobs;
    }

    emitFrame(samples: number[]): void {
        this.onFrame(Int16Array.from(samples));
    }

    async start(): Promise<void> {
        this.startCalls += 1;
        if (this.knobs.startError !== null) {
            throw this.knobs.startError;
        }
    }

    async stop(): Promise<void> {
        this.stopCalls += 1;
    }
}

/**
 * Per-test knobs the fake `Microphone` consults. Held in a module-scope
 * binding rather than closed over a constructor parameter: esbuild cannot
 * scope a field-initialized nested class back to the enclosing constructor's
 * parameter (it renames the parameter without updating the reference), which
 * surfaces as `X is not defined` at runtime. A module-level `let` is a
 * binding both the field initializer and its nested class see.
 */
let liveKnobs: MicKnobs = { startError: null };

/** Live registry of created microphones (see the field-initializer note). */
let liveMics: FakeMicrophone[] = [];

/** Fake module: `create` feeds the instance the armed onDetection callback. */
class FakeModule implements OpenWakeWordModuleLike {
    createCalls = 0;
    createOptions: CreateOptionsRecord | null = null;
    createError: Error | null = null;
    instances: FakeOww[] = [];
    /** The microphones created through `Microphone` this session. */
    get mics(): FakeMicrophone[] {
        return liveMics;
    }
    readonly OpenWakeWord = {
        create: async (options?: CreateOptionsRecord) => {
            this.createCalls += 1;
            this.createOptions = options ?? null;
            if (this.createError !== null) {
                throw this.createError;
            }
            const instance = new FakeOww(options?.onDetection ?? null);
            this.instances.push(instance);
            return instance;
        },
    };
    readonly Microphone = class extends FakeMicrophone {
        constructor(
            onFrame: (frame: Int16Array) => void,
            opts?: { workletUrl?: string },
        ) {
            super(onFrame, opts ?? {}, liveKnobs);
            liveMics.push(this);
        }
    };
}

/** Harness: provider under test plus its fake module. */
interface Harness {
    module: FakeModule;
    knobs: MicKnobs;
    provider: OpenWakeWordWakeProvider;
}

function makeHarness(options: OpenWakeWordOptions = {}): Harness {
    const knobs: MicKnobs = { startError: null };
    liveKnobs = knobs;
    liveMics = [];
    const module = new FakeModule();
    const provider = new OpenWakeWordWakeProvider(options, async () => module);
    return { module, knobs, provider };
}

/** A recording of the wake deliveries and errors on the armed pass. */
interface WakeRecord {
    wakes: Array<{ confidence: number }>;
    commandAudio: Array<{ pcm: Float32Array; sampleRate: number }>;
    errors: VoiceError[];
    callbacks: Parameters<OpenWakeWordWakeProvider["start"]>[0];
}

function makeRecord(): WakeRecord {
    const record: WakeRecord = {
        wakes: [],
        commandAudio: [],
        errors: [],
        callbacks: {
            onWake: (detection) =>
                record.wakes.push({ confidence: detection.confidence ?? 0 }),
            onCommandAudio: (pcm, sampleRate) =>
                record.commandAudio.push({ pcm, sampleRate }),
            onError: (error) => record.errors.push(error),
        },
    };
    return record;
}

/** The microphone the most recent `start()` opened. */
function lastMic(module: FakeModule): FakeMicrophone {
    return module.mics[module.mics.length - 1]!;
}

/** The instance the most recent `start()` created. */
function lastInstance(module: FakeModule): FakeOww {
    return module.instances[module.instances.length - 1]!;
}

/** A recognizable frame: content starts at `offset` (mod 32767). */
function frameWith(offset: number, length = 1280): number[] {
    return Array.from({ length }, (_, i) => (i + offset) % 32767);
}

describe("isWakeSupported", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("is false outside a secure Web Audio runtime", () => {
        vi.unstubAllGlobals();
        expect(isWakeSupported()).toBe(false);
        expect(createOpenWakeWord()).toBeNull();
    });

    it("is true when a secure context offers mic, Web Audio, and worklets", () => {
        vi.stubGlobal("isSecureContext", true);
        vi.stubGlobal("AudioWorkletNode", class {});
        vi.stubGlobal("AudioContext", class {});
        vi.stubGlobal("navigator", { mediaDevices: {} });
        expect(isWakeSupported()).toBe(true);
        expect(createOpenWakeWord()).toBeInstanceOf(OpenWakeWordWakeProvider);
    });
});

describe("OpenWakeWordWakeProvider", () => {
    it("arms the detector with the configured models and URLs", async () => {
        const { module, provider } = makeHarness({
            baseUrl: "/api/wake/model/",
            wakewordModels: ["hey_jarvis"],
            threshold: 0.5,
        });
        await provider.start(makeRecord().callbacks);
        expect(module.createCalls).toBe(1);
        expect(module.createOptions?.baseUrl).toBe("/api/wake/model/");
        expect(module.createOptions?.wakewordModels).toEqual(["hey_jarvis"]);
        expect(module.createOptions?.threshold).toBe(0.5);
        expect(module.createOptions?.ort).toEqual({
            wasmPaths: undefined,
            numThreads: 1,
            simd: true,
        });
        expect(module.mics).toHaveLength(1);
        expect(module.mics[0].startCalls).toBe(1);
        await provider.stop();
    });

    it("reports the match and streams the command that follows", async () => {
        const { module, provider } = makeHarness();
        const record = makeRecord();
        await provider.start(record.callbacks);
        // Pre-match frames are the phrase: predicted, never emitted.
        lastMic(module).emitFrame(frameWith(1));
        lastMic(module).emitFrame(frameWith(2));
        expect(record.commandAudio).toEqual([]);
        // The frame that crosses the threshold is only predicted too, so it
        // is not part of the stream.
        lastMic(module).emitFrame(frameWith(3));
        lastInstance(module).fire("hey_jarvis", 0.92);
        expect(record.errors).toEqual([]);
        expect(record.wakes).toHaveLength(1);
        expect(record.wakes[0].confidence).toBe(0.92);
        expect(record.commandAudio).toEqual([]);
        // Everything after is the command, frame by frame, at 16 kHz.
        lastMic(module).emitFrame(frameWith(7));
        lastMic(module).emitFrame(frameWith(9));
        expect(record.commandAudio).toHaveLength(2);
        expect(record.commandAudio[0]!.sampleRate).toBe(16000);
        expect(record.commandAudio[0]!.pcm.length).toBe(1280);
        expect(Array.from(record.commandAudio[0]!.pcm.slice(0, 3))).toEqual([
            7 / 32768,
            8 / 32768,
            9 / 32768,
        ]);
        expect(Array.from(record.commandAudio[1]!.pcm.slice(0, 1))).toEqual([
            9 / 32768,
        ]);
        await provider.stop();
    });

    it("busy-drops frames while a predict is in flight", async () => {
        const { module, provider } = makeHarness();
        await provider.start(makeRecord().callbacks);
        module.mics[0].emitFrame(frameWith(1));
        module.mics[0].emitFrame(frameWith(2));
        expect(module.instances[0].predictCalls).toBe(1); // only the first
        await Promise.resolve();
        expect(module.instances[0].predictCalls).toBe(1); // second was dropped
        await provider.stop();
    });

    it("fires at most once per start, even if the phrase repeats", async () => {
        const { module, provider } = makeHarness();
        const record = makeRecord();
        await provider.start(record.callbacks);
        module.mics[0].emitFrame(frameWith(1));
        module.instances[0].fire("hey_jarvis", 0.9);
        expect(record.wakes).toHaveLength(1);
        module.mics[0].emitFrame(frameWith(2));
        module.instances[0].fire("hey_jarvis", 0.95);
        expect(record.wakes).toHaveLength(1);
        await provider.stop();
    });

    it("keeps streaming every post-match frame until stop()", async () => {
        // The whole command reaches the session, however long it takes to
        // open — the reason a one-breath utterance is captured whole (#121).
        const { module, provider } = makeHarness();
        const record = makeRecord();
        await provider.start(record.callbacks);
        lastMic(module).emitFrame(frameWith(1));
        lastInstance(module).fire("hey_jarvis", 0.9);
        for (let frame = 0; frame < 30; frame += 1) {
            lastMic(module).emitFrame(frameWith(frame * 1280));
        }
        expect(record.commandAudio).toHaveLength(30);
        expect(record.commandAudio[29]!.pcm[0]).toBe(
            ((29 * 1280) % 32767) / 32768,
        );
        // stop() ends the stream: no delivery for a frame pushed after it.
        await provider.stop();
        lastMic(module).emitFrame(frameWith(1));
        expect(record.commandAudio).toHaveLength(30);
    });

    it("streams nothing before a match", async () => {
        const { module, provider } = makeHarness();
        const record = makeRecord();
        await provider.start(record.callbacks);
        lastMic(module).emitFrame(frameWith(1));
        lastMic(module).emitFrame(frameWith(2));
        expect(record.commandAudio).toEqual([]);
        await provider.stop();
    });

    it("a model load error rejects and arms nothing", async () => {
        const { module, provider } = makeHarness();
        module.createError = new Error("model fetch failed");
        await expect(
            provider.start(makeRecord().callbacks),
        ).rejects.toMatchObject({ code: "engine" });
        await provider.stop();
    });

    it("a mic start failure rejects and resets the loaded models", async () => {
        const { module, knobs, provider } = makeHarness();
        knobs.startError = new Error("the worklet died");
        const record = makeRecord();
        await expect(provider.start(record.callbacks)).rejects.toMatchObject({
            code: "engine",
        });
        expect(module.instances[0].resetCalls).toBe(1);
        expect(record.wakes).toHaveLength(0);
        await provider.stop();
    });

    it("stop() releases the mic, resets the models, and drops callbacks", async () => {
        const { module, provider } = makeHarness();
        const record = makeRecord();
        await provider.start(record.callbacks);
        const mic = module.mics[0];
        const instance = module.instances[0];
        await provider.stop();
        expect(mic.stopCalls).toBe(1);
        expect(instance.resetCalls).toBe(1);
        instance.fire("hey_jarvis", 0.99);
        expect(record.wakes).toHaveLength(0);
    });

    it("re-arms cleanly after a stop, with a fresh stream", async () => {
        const { module, provider } = makeHarness();
        const record = makeRecord();
        await provider.start(record.callbacks);
        lastMic(module).emitFrame(frameWith(1));
        lastInstance(module).fire("hey_jarvis", 0.8);
        expect(record.wakes[0]!.confidence).toBe(0.8);
        lastMic(module).emitFrame(frameWith(7));
        expect(record.commandAudio).toHaveLength(1);
        await provider.stop();
        // A second arm starts from scratch: nothing streams until it fires.
        await provider.start(record.callbacks);
        lastMic(module).emitFrame(frameWith(2));
        expect(record.commandAudio).toHaveLength(1);
        lastInstance(module).fire("hey_jarvis", 0.81);
        expect(record.wakes).toHaveLength(2);
        expect(record.wakes[1]!.confidence).toBe(0.81);
        lastMic(module).emitFrame(frameWith(3));
        expect(record.commandAudio).toHaveLength(2);
        await provider.stop();
    });
});
