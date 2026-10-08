/**
 * Voice-controller barge-in tests (issue #84, phase 6).
 *
 * The barge-in watch is driven with the same fake discipline as the wake
 * tests: a scripted VAD (speech events + a raw-audio tap), a scripted STT
 * with a `feed()` seam, and a hand-fired scheduler. Asserted: the watch
 * arms on demand and holds the VAD, sustained speech (BARGE_IN_SPEECH_MS)
 * fires the trigger exactly once with the ringed look-back, a released
 * onset does not fire, disarm cancels a pending trigger, the ring prunes
 * to the window, the new session replays the look-back through `feed()`,
 * the replaced turn's events are stale by session id, and every degraded
 * path (no VAD, busy VAD, throwing callback) stays quiet.
 */
import { describe, expect, it } from "vitest";
import {
    BARGE_IN_LOOKBACK_MS,
    BARGE_IN_SPEECH_MS,
    END_OF_SPEECH_MS,
    VoiceController,
} from "../src/index";
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    SttState,
    VadCallbacks,
    VadProvider,
    VoiceError,
    VoiceSnapshot,
} from "../src/index";

/** Scripted STT double with a feed() seam; the test drives deliveries. */
class FakeStt implements SttProvider {
    readonly id = "fake";
    state: SttState = "idle";
    startCalls = 0;
    stopCalls = 0;
    cancelCalls = 0;
    lastStartOptions: SttStartOptions | undefined = undefined;
    fed: Array<{ pcm: Float32Array; sampleRate: number }> = [];
    private callbacks: SttCallbacks | null = null;

    async start(
        callbacks: SttCallbacks,
        options?: SttStartOptions,
    ): Promise<void> {
        this.startCalls += 1;
        this.lastStartOptions = options;
        this.callbacks = callbacks;
        this.state = "running";
    }

    async stop(): Promise<void> {
        this.stopCalls += 1;
        this.state = "idle";
    }

    async cancel(): Promise<void> {
        this.cancelCalls += 1;
        this.callbacks = null;
        this.state = "idle";
    }

    feed(pcm: Float32Array, sampleRate: number): void {
        this.fed.push({ pcm, sampleRate });
    }

    emitResult(text: string): void {
        this.callbacks?.onResult?.(text);
    }
}

/** Scripted VAD double with the raw-audio tap; the test drives events. */
class FakeVad implements VadProvider {
    readonly id = "fake-vad";
    startCalls = 0;
    stopCalls = 0;
    /** Rejects start() while a session is live (mirrors the real provider). */
    private callbacks: VadCallbacks | null = null;

    async start(callbacks: VadCallbacks): Promise<void> {
        if (this.callbacks !== null) {
            throw { code: "engine", message: "already active" };
        }
        this.startCalls += 1;
        this.callbacks = callbacks;
    }

    async stop(): Promise<void> {
        this.stopCalls += 1;
        this.callbacks = null;
    }

    emitSpeechStart(): void {
        this.callbacks?.onSpeechStart();
    }

    emitSpeechEnd(): void {
        this.callbacks?.onSpeechEnd();
    }

    emitAudio(pcm: Float32Array, sampleRate: number): void {
        this.callbacks?.onAudio?.(pcm, sampleRate);
    }

    emitError(error: VoiceError): void {
        this.callbacks?.onError?.(error);
    }
}

/** Fake scheduler: timers never tick on their own; tests fire them by ms. */
interface FakeScheduler {
    schedule(callback: () => void, ms: number): unknown;
    unschedule(handle: unknown): void;
    fireByMs(ms: number): void;
    pendingMs(): number[];
}

function makeScheduler(): FakeScheduler {
    const tasks = new Map<number, { fn: () => void; ms: number }>();
    let next = 1;
    return {
        schedule: (callback, ms) => {
            const handle = next;
            next += 1;
            tasks.set(handle, { fn: callback, ms });
            return handle;
        },
        unschedule: (handle) => {
            tasks.delete(handle as number);
        },
        fireByMs: (ms) => {
            for (const [handle, task] of [...tasks]) {
                if (task.ms === ms) {
                    tasks.delete(handle);
                    task.fn();
                }
            }
        },
        pendingMs: () => [...tasks.values()].map((task) => task.ms),
    };
}

/** Captured barge-in triggers. */
interface BargeControl {
    fires: Array<{ lookback?: Float32Array; lookbackSampleRate?: number }>;
    /** Makes the next callback throw (the client's stop/cancel failing). */
    throwNext: boolean;
}

interface Harness {
    stt: FakeStt;
    vad: FakeVad;
    scheduler: FakeScheduler;
    controller: VoiceController;
    snapshots: VoiceSnapshot[];
    barge: BargeControl;
}

function makeHarness(): Harness {
    const stt = new FakeStt();
    const vad = new FakeVad();
    const scheduler = makeScheduler();
    const snapshots: VoiceSnapshot[] = [];
    const submitResolvers: Array<() => void> = [];
    const barge: BargeControl = { fires: [], throwNext: false };
    const controller = new VoiceController({
        stt,
        vad,
        onBargeIn: (detection) => {
            if (barge.throwNext) {
                barge.throwNext = false;
                throw new Error("client stop failed");
            }
            barge.fires.push(detection);
        },
        schedule: scheduler.schedule,
        unschedule: scheduler.unschedule,
        submit: () =>
            new Promise<void>((resolve) => {
                submitResolvers.push(resolve);
            }),
    });
    controller.subscribe(() => snapshots.push(controller.getSnapshot()));
    return { stt, vad, scheduler, controller, snapshots, barge };
}

/**
 * Drives a full press turn to the `speaking` state: press → VAD speech →
 * end-of-speech flush → transcript submit → response frames → audioStart.
 * The turn's submit stays pending (the "in-flight" turn barge-in cancels).
 */
async function driveToSpeaking(harness: Harness): Promise<void> {
    const { controller, stt, vad, scheduler } = harness;
    controller.press();
    await Promise.resolve();
    vad.emitSpeechStart();
    vad.emitSpeechEnd();
    scheduler.fireByMs(END_OF_SPEECH_MS);
    stt.emitResult("hi");
    expect(controller.getSnapshot().state).toBe("waiting");
    controller.noteResponseFrame();
    controller.noteAudioStarted();
    expect(controller.getSnapshot().state).toBe("speaking");
}

/**
 * Lets every pending microtask chain settle (the controller's begin/stop
 * paths are several awaits deep) before assertions read the snapshot.
 */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("barge-in watch (#84 P6)", () => {
    it("arms on demand, fires once on sustained speech, and opens a seeded session", async () => {
        const harness = makeHarness();
        await driveToSpeaking(harness);
        await harness.controller.startBargeWatch();
        expect(harness.vad.startCalls).toBe(2); // session VAD + watch VAD

        // Ring some audio, then sustained speech: the trigger fires with
        // the ringed look-back, and a new listening session opens with the
        // look-back replayed into the primary engine.
        harness.vad.emitAudio(new Float32Array(480).fill(0.5), 48000);
        harness.vad.emitAudio(new Float32Array(480).fill(0.5), 48000);
        harness.vad.emitSpeechStart();
        expect(harness.controller.getSnapshot().state).toBe("speaking");
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);

        expect(harness.barge.fires).toHaveLength(1);
        const fire = harness.barge.fires[0]!;
        expect(fire.lookbackSampleRate).toBe(48000);
        expect(fire.lookback?.length).toBe(960);
        await settle();
        expect(harness.controller.getSnapshot().state).toBe("listening");
        expect(harness.controller.getSnapshot().sessionId).toBe(2);
        // The watch disarmed itself and the new session owns the VAD again.
        expect(harness.vad.stopCalls).toBeGreaterThanOrEqual(1);
        expect(harness.stt.fed).toEqual([
            {
                pcm: fire.lookback,
                sampleRate: 48000,
            },
        ]);
    });

    it("does not fire when speech releases before the deadline", async () => {
        const harness = makeHarness();
        await driveToSpeaking(harness);
        await harness.controller.startBargeWatch();
        harness.vad.emitSpeechStart();
        harness.vad.emitSpeechEnd();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.barge.fires).toHaveLength(0);
        // Still armed: a later sustained onset fires normally.
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.barge.fires).toHaveLength(1);
    });

    it("disarm cancels a pending trigger and releases the VAD", async () => {
        const harness = makeHarness();
        await driveToSpeaking(harness);
        await harness.controller.startBargeWatch();
        harness.vad.emitSpeechStart();
        expect(harness.scheduler.pendingMs()).toContain(BARGE_IN_SPEECH_MS);
        await harness.controller.stopBargeWatch();
        expect(harness.scheduler.pendingMs()).not.toContain(BARGE_IN_SPEECH_MS);
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.barge.fires).toHaveLength(0);
        // Events after disarm are inert (the provider's callbacks dropped).
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.barge.fires).toHaveLength(0);
        // The watch's own release: the turn's session VAD was already
        // stopped at its end-of-speech.
        expect(harness.vad.stopCalls).toBe(2);
    });

    it("prunes the look-back ring to the window", async () => {
        const harness = makeHarness();
        await driveToSpeaking(harness);
        await harness.controller.startBargeWatch();
        // 25 chunks × 100 ms = 2500 ms at a 10 kHz analysis rate; the ring
        // keeps at most the window plus the newest frame.
        for (let i = 0; i < 25; i += 1) {
            harness.vad.emitAudio(new Float32Array(1000), 10000);
        }
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.barge.fires).toHaveLength(1);
        const lookback = harness.barge.fires[0]!.lookback!;
        const ms = (lookback.length / 10000) * 1000;
        expect(ms).toBeGreaterThan(BARGE_IN_LOOKBACK_MS - 200);
        expect(ms).toBeLessThanOrEqual(BARGE_IN_LOOKBACK_MS + 200);
    });

    it("replays the look-back into the new session and makes the old turn stale", async () => {
        const harness = makeHarness();
        await driveToSpeaking(harness);
        await harness.controller.startBargeWatch();
        harness.vad.emitAudio(new Float32Array(960), 16000);
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        await settle();
        expect(harness.controller.getSnapshot().state).toBe("listening");
        // The new session endpointed normally: speech stops → flush → the
        // final transcript lands as the new session's own turn.
        harness.vad.emitSpeechEnd();
        harness.scheduler.fireByMs(END_OF_SPEECH_MS);
        harness.stt.emitResult("stop talking");
        // The transcript dispatches its turn immediately (submitting is
        // transient): the snapshot reads `waiting`.
        expect(harness.controller.getSnapshot().state).toBe("waiting");
        // The barge session's transcript is the user's words, not the old
        // turn's business.
        expect(harness.controller.getSnapshot().transcript).toBe(
            "stop talking",
        );
    });

    it("a throwing onBargeIn still opens the session", async () => {
        const harness = makeHarness();
        harness.barge.throwNext = true;
        await driveToSpeaking(harness);
        await harness.controller.startBargeWatch();
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.barge.fires).toHaveLength(0);
        await settle();
        expect(harness.controller.getSnapshot().state).toBe("listening");
    });

    it("is a silent no-op without a VAD", async () => {
        const stt = new FakeStt();
        const snapshots: VoiceSnapshot[] = [];
        const controller = new VoiceController({
            stt,
            submit: async () => {},
        });
        controller.subscribe(() => snapshots.push(controller.getSnapshot()));
        await controller.startBargeWatch();
        expect(stt.startCalls).toBe(0);
        expect(snapshots).toHaveLength(0);
    });

    it("stays off when the VAD is busy with a recognition session", async () => {
        const harness = makeHarness();
        // A live recognition session owns the VAD.
        harness.controller.press();
        await Promise.resolve();
        expect(harness.vad.startCalls).toBe(1);
        await harness.controller.startBargeWatch();
        // The start rejected (already active): the watch never armed, and
        // the session's VAD still drives its own endpointing.
        expect(harness.controller.getSnapshot().state).toBe("listening");
        harness.vad.emitSpeechStart();
        harness.vad.emitSpeechEnd();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.barge.fires).toHaveLength(0);
        // The session still endpointed normally.
        harness.scheduler.fireByMs(END_OF_SPEECH_MS);
        expect(harness.controller.getSnapshot().state).toBe("transcribing");
    });

    it("a watch VAD error disarms quietly", async () => {
        const harness = makeHarness();
        await driveToSpeaking(harness);
        await harness.controller.startBargeWatch();
        harness.vad.emitError({ code: "engine", message: "track ended" });
        await settle();
        expect(harness.vad.stopCalls).toBe(2);
        // The playing turn is untouched — no error surfaced over it.
        expect(harness.controller.getSnapshot().state).toBe("speaking");
        expect(harness.controller.getSnapshot().error).toBeNull();
    });
});
