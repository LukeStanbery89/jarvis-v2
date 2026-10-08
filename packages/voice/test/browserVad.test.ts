/**
 * Browser VAD provider tests (issue #84, phase 3).
 *
 * Fakes for `navigator.mediaDevices.getUserMedia` and the Web Audio graph
 * are installed on `globalThis` per test (the same approach as the Web
 * Speech provider tests), and vitest's fake timers drive both the analysis
 * interval and `Date.now()` — so the energy state machine's onset/release
 * timing is exercised deterministically with no real clock or microphone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    BrowserVadProvider,
    createBrowserVad,
    isVadSupported,
} from "../src/providers/browserVad";
import type { VadCallbacks, VoiceError } from "../src/types";

/** Recording sink for provider deliveries. */
interface Recorder {
    started: number;
    ended: number;
    errors: VoiceError[];
    callbacks: VadCallbacks;
}

function makeRecorder(): Recorder {
    const recorder: Recorder = {
        started: 0,
        ended: 0,
        errors: [],
        callbacks: {
            onSpeechStart: () => {
                recorder.started += 1;
            },
            onSpeechEnd: () => {
                recorder.ended += 1;
            },
            onError: (error) => {
                recorder.errors.push(error);
            },
        },
    };
    return recorder;
}

/** An analyser whose read buffer the test fills directly. */
class FakeAnalyser {
    fftSize = 2048;
    private buffer = new Float32Array(2048);

    getFloatTimeDomainData(array: Float32Array): void {
        array.set(this.buffer);
    }

    /** Test driver: set the level every subsequent tick reports (as RMS). */
    setLevel(level: number): void {
        this.buffer.fill(level);
    }
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

/** An audio-context double exposing the two nodes the provider wires. */
class FakeAudioContext {
    /** Every instance ever created (the provider builds its own). */
    static instances: FakeAudioContext[] = [];
    closed = false;
    readonly analyser = new FakeAnalyser();

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    createMediaStreamSource(_stream: FakeStream): {
        connect(destination: FakeAnalyser): void;
    } {
        return {
            connect: () => {
                // The provider reads levels from the context's analyser.
            },
        };
    }

    createAnalyser(): FakeAnalyser {
        return this.analyser;
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

/** Installed browser fakes for the current test. */
interface Fakes {
    /** The provider's audio context (created inside `start`). */
    readonly context: FakeAudioContext;
    /** The mic track the fake stream carries. */
    readonly track: FakeTrack;
    /** The `getUserMedia` mock (call + constraint assertions). */
    readonly getUserMedia: ReturnType<typeof vi.fn>;
    /** Makes the next `getUserMedia` reject with the given error. */
    failGetUserMedia(err: Error): void;
    /** Fires the track's `onended` (mid-session death). */
    endTrack(): void;
}

/**
 * Installs `navigator.mediaDevices.getUserMedia` and `AudioContext` on
 * `globalThis` for one test.
 *
 * @returns The handles the test drives.
 */
function installFakes(): Fakes {
    const track = new FakeTrack();
    const state: { rejectError: Error | null } = { rejectError: null };
    const getUserMedia = vi.fn(() => {
        if (state.rejectError !== null) {
            return Promise.reject(state.rejectError);
        }
        return Promise.resolve(new FakeStream(track));
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    return {
        get context() {
            return FakeAudioContext.latest();
        },
        track,
        getUserMedia,
        failGetUserMedia: (err) => {
            state.rejectError = err;
        },
        endTrack: () => {
            track.onended?.();
        },
    };
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
        expect(isVadSupported()).toBe(false);
        expect(createBrowserVad()).toBeNull();
    });

    it("creates a provider when the browser fakes are installed", () => {
        installFakes();
        expect(isVadSupported()).toBe(true);
        expect(createBrowserVad()).toBeInstanceOf(BrowserVadProvider);
    });
});

describe("session lifecycle", () => {
    it("arms its own echo-cancelled track and stops it on stop()", async () => {
        const fakes = installFakes();
        const provider = new BrowserVadProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        expect(fakes.getUserMedia).toHaveBeenCalledTimes(1);
        expect(fakes.getUserMedia.mock.calls[0][0]).toEqual({
            audio: { echoCancellation: true },
        });
        await provider.stop();
        expect(fakes.track.stopped).toBe(true);
        expect(fakes.context.closed).toBe(true);
        // Idempotent: a second stop is a no-op.
        await provider.stop();
    });

    it("rejects a second start while a session is live", async () => {
        installFakes();
        const provider = new BrowserVadProvider();
        await provider.start(makeRecorder().callbacks);
        await expect(
            provider.start(makeRecorder().callbacks),
        ).rejects.toMatchObject({ code: "engine" });
        await provider.stop();
    });

    it("rejects start when the microphone cannot be opened", async () => {
        const fakes = installFakes();
        fakes.failGetUserMedia(new Error("Permission denied by the user"));
        const provider = new BrowserVadProvider();
        await expect(
            provider.start(makeRecorder().callbacks),
        ).rejects.toMatchObject({ code: "permission-denied" });
        fakes.failGetUserMedia(new Error("device busy"));
        await expect(
            provider.start(makeRecorder().callbacks),
        ).rejects.toMatchObject({ code: "engine" });
    });

    it("stop() guarantees no callback fires afterwards", async () => {
        const fakes = installFakes();
        const provider = new BrowserVadProvider({ intervalMs: 10 });
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        await provider.stop();
        fakes.context.analyser.setLevel(0.3);
        vi.advanceTimersByTime(500);
        expect(recorder.started).toBe(0);
        expect(recorder.ended).toBe(0);
    });
});

describe("energy state machine", () => {
    it("fires onSpeechStart after sustained loudness", async () => {
        const fakes = installFakes();
        const provider = new BrowserVadProvider({
            intervalMs: 10,
            onsetMs: 30,
            releaseMs: 25,
        });
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.context.analyser.setLevel(0.3);
        vi.advanceTimersByTime(20); // two loud ticks: below onset
        expect(recorder.started).toBe(0);
        vi.advanceTimersByTime(20); // more loud ticks: onset reached
        expect(recorder.started).toBe(1);
        expect(recorder.ended).toBe(0);
        await provider.stop();
    });

    it("fires onSpeechEnd after sustained silence", async () => {
        const fakes = installFakes();
        const provider = new BrowserVadProvider({
            intervalMs: 10,
            onsetMs: 30,
            releaseMs: 25,
        });
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.context.analyser.setLevel(0.3);
        vi.advanceTimersByTime(40);
        expect(recorder.started).toBe(1);
        fakes.context.analyser.setLevel(0);
        vi.advanceTimersByTime(15); // silence, but below release
        expect(recorder.ended).toBe(0);
        vi.advanceTimersByTime(30); // release reached
        expect(recorder.ended).toBe(1);
        await provider.stop();
    });

    it("a brief dip does not split speech into two utterances", async () => {
        const fakes = installFakes();
        const provider = new BrowserVadProvider({
            intervalMs: 10,
            onsetMs: 30,
            releaseMs: 25,
        });
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.context.analyser.setLevel(0.3);
        vi.advanceTimersByTime(40);
        fakes.context.analyser.setLevel(0);
        vi.advanceTimersByTime(10); // one quiet tick: below release
        fakes.context.analyser.setLevel(0.3);
        vi.advanceTimersByTime(30);
        expect(recorder.started).toBe(1);
        expect(recorder.ended).toBe(0);
        await provider.stop();
    });

    it("sub-onset loudness never starts a session", async () => {
        const fakes = installFakes();
        const provider = new BrowserVadProvider({
            intervalMs: 10,
            onsetMs: 30,
            releaseMs: 25,
        });
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.context.analyser.setLevel(0.3);
        vi.advanceTimersByTime(20); // loud, but never for onsetMs
        fakes.context.analyser.setLevel(0);
        vi.advanceTimersByTime(100);
        expect(recorder.started).toBe(0);
        await provider.stop();
    });
});

describe("mid-session failures", () => {
    it("a track end delivers one error and settles the session", async () => {
        const fakes = installFakes();
        const provider = new BrowserVadProvider({ intervalMs: 10 });
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        fakes.endTrack();
        expect(recorder.errors).toEqual([
            { code: "engine", message: "the microphone track ended" },
        ]);
        // Settled: no further events.
        fakes.context.analyser.setLevel(0.3);
        vi.advanceTimersByTime(500);
        expect(recorder.started).toBe(0);
        expect(fakes.track.stopped).toBe(true);
    });
});
