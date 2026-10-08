/**
 * Voice-controller wake-word tests (issue #84, phase 4).
 *
 * The controller is driven with a scripted fake wake detector, fake STT
 * engines (one primary, one for wake sessions), a fake VAD, and a fake
 * scheduler — asserting on the observable `VoiceSnapshot` after each step:
 * arming/disarming, the wake session opening on its own engine, look-back
 * replay into that engine, phrase stripping, and automatic re-arming once
 * a wake-opened turn settles. Timer expiry is fired by hand, never by real
 * clocks.
 */
import { describe, expect, it } from "vitest";
import { END_OF_SPEECH_MS, NO_SPEECH_MS, VoiceController } from "../src/index";
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    SttState,
    VadCallbacks,
    VadProvider,
    VoiceError,
    VoiceSnapshot,
    WakeCallbacks,
    WakeDetection,
    WakeWordProvider,
} from "../src/index";

/** Scripted STT double; the test drives deliveries directly. */
class FakeStt implements SttProvider {
    readonly id: string;
    state: SttState = "idle";
    startCalls = 0;
    stopCalls = 0;
    cancelCalls = 0;
    prepareCalls = 0;
    /** Rejects the next start() when set. */
    startError: VoiceError | null = null;
    lastStartOptions: SttStartOptions | undefined = undefined;
    fed: Array<{ pcm: Float32Array; sampleRate: number }> = [];
    private callbacks: SttCallbacks | null = null;

    constructor(id = "fake") {
        this.id = id;
    }

    async start(
        callbacks: SttCallbacks,
        options?: SttStartOptions,
    ): Promise<void> {
        this.startCalls += 1;
        this.lastStartOptions = options;
        if (this.startError !== null) {
            throw this.startError;
        }
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

    async prepare(): Promise<void> {
        this.prepareCalls += 1;
    }

    feed(pcm: Float32Array, sampleRate: number): void {
        this.fed.push({ pcm, sampleRate });
    }

    emitPartial(text: string): void {
        this.callbacks?.onPartial?.(text);
    }

    emitResult(text: string): void {
        this.callbacks?.onResult?.(text);
    }

    emitError(error: VoiceError): void {
        this.callbacks?.onError?.(error);
    }
}

/** Scripted VAD double; the test drives speech events directly. */
class FakeVad implements VadProvider {
    readonly id = "fake-vad";
    startCalls = 0;
    stopCalls = 0;
    private callbacks: VadCallbacks | null = null;

    async start(callbacks: VadCallbacks): Promise<void> {
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
}

/** Scripted wake detector; the test fires matches and errors by hand. */
class FakeWake implements WakeWordProvider {
    readonly id = "fake-wake";
    startCalls = 0;
    stopCalls = 0;
    private callbacks: WakeCallbacks | null = null;

    async start(callbacks: WakeCallbacks): Promise<void> {
        this.startCalls += 1;
        this.callbacks = callbacks;
    }

    async stop(): Promise<void> {
        this.stopCalls += 1;
        this.callbacks = null;
    }

    emitWake(detection: WakeDetection): void {
        this.callbacks?.onWake(detection);
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
    };
}

/** Test harness: controller + its fakes + the snapshot notifications. */
interface Harness {
    stt: FakeStt;
    wakeStt: FakeStt;
    vad: FakeVad | null;
    wake: FakeWake;
    scheduler: FakeScheduler;
    controller: VoiceController;
    snapshots: VoiceSnapshot[];
    submits: string[];
    settleSubmit(): void;
}

function makeHarness(vad = true): Harness {
    const stt = new FakeStt("primary");
    const wakeStt = new FakeStt("wake");
    const vadProvider = vad ? new FakeVad() : null;
    const wake = new FakeWake();
    const scheduler = makeScheduler();
    const snapshots: VoiceSnapshot[] = [];
    const submits: string[] = [];
    const submitResolvers: Array<() => void> = [];
    const controller = new VoiceController({
        stt,
        wakeStt,
        vad: vadProvider,
        wake,
        wakePhrase: "Hey JARVIS",
        schedule: scheduler.schedule,
        unschedule: scheduler.unschedule,
        submit: (text) => {
            submits.push(text);
            return new Promise<void>((resolve) => {
                submitResolvers.push(resolve);
            });
        },
    });
    controller.subscribe(() => snapshots.push(controller.getSnapshot()));
    return {
        stt,
        wakeStt,
        vad: vadProvider,
        wake,
        scheduler,
        controller,
        snapshots,
        submits,
        settleSubmit: () => {
            submitResolvers.shift()?.();
        },
    };
}

/** Drains the controller's async chains (several microtasks). */
async function drain(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
}

/** The look-back buffer a wake match carries ("Hey JARVIS, turn on…"). */
const lookback = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

describe("wake arming", () => {
    it("enableWake arms the detector and warms the wake engine", async () => {
        const harness = makeHarness();
        const { wake, wakeStt, controller } = harness;
        await controller.enableWake();
        await drain();
        expect(wake.startCalls).toBe(1);
        expect(controller.getSnapshot().wakeArmed).toBe(true);
        expect(wakeStt.prepareCalls).toBe(1);
    });

    it("disableWake disarms and keeps the detector off", async () => {
        const harness = makeHarness();
        const { wake, controller } = harness;
        await controller.enableWake();
        await controller.disableWake();
        expect(wake.stopCalls).toBe(1);
        expect(controller.getSnapshot().wakeArmed).toBe(false);
    });

    it("a start failure is recorded and nothing is armed", async () => {
        const wake = new (class extends FakeWake {
            async start(_callbacks: WakeCallbacks): Promise<void> {
                this.startCalls += 1;
                throw { code: "engine", message: "no model" };
            }
        })();
        const other = makeHarness();
        const failing = new VoiceController({
            stt: other.stt,
            wakeStt: other.wakeStt,
            wake,
            submit: async () => {},
        });
        await failing.enableWake();
        expect(failing.getSnapshot().wakeArmed).toBe(false);
        expect(failing.getSnapshot().error).toMatchObject({
            code: "engine",
        });
        await failing.dispose();
    });
});

describe("wake sessions", () => {
    it("a match opens a session on the wake engine, replaying the look-back", async () => {
        const harness = makeHarness();
        const { stt, wakeStt, wake, controller } = harness;
        await controller.enableWake();
        await drain();
        expect(controller.getSnapshot().wakeArmed).toBe(true);
        expect(controller.getSnapshot().state).toBe("idle");

        wake.emitWake({ confidence: 0.91, lookback });
        await drain();

        // The detector disarmed in favor of the session; the wake engine
        // (not the primary) owns the mic and received the look-back.
        expect(controller.getSnapshot().wakeArmed).toBe(false);
        expect(controller.getSnapshot().state).toBe("listening");
        expect(stt.startCalls).toBe(0);
        expect(wakeStt.startCalls).toBe(1);
        expect(wakeStt.fed).toHaveLength(1);
        expect(wakeStt.fed[0].sampleRate).toBe(16000);
        expect(Array.from(wakeStt.fed[0].pcm)).toEqual([...lookback]);
    });

    it("phrase stripping turns the transcript into the command", async () => {
        // No VAD: the wake session is engine-native, so the final is the
        // whole transcript and strips to the command before it is submitted.
        const harness = makeHarness(false);
        const { wakeStt, wake, controller, submits } = harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9, lookback });
        await drain();
        wakeStt.emitResult("Hey JARVIS, turn on the living room light");
        await drain();
        expect(submits).toEqual(["turn on the living room light"]);
        expect(controller.getSnapshot().transcript).toBe(
            "turn on the living room light",
        );
    });

    it("VAD-owned wake sessions strip accumulated segments for display and submit", async () => {
        const harness = makeHarness();
        const { wakeStt, wake, scheduler, controller, submits } = harness;
        const vad = harness.vad as FakeVad;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.85 });
        await drain();
        // VAD armed the continuous mode; segments (incl. the phrase, heard
        // in the flushed look-back) accumulate and are stripped on display.
        expect(wakeStt.lastStartOptions).toEqual({ continuous: true });
        wakeStt.emitResult("Hey JARVIS");
        wakeStt.emitResult("turn on the lights");
        expect(controller.getSnapshot().state).toBe("listening");
        expect(controller.getSnapshot().partial).toBe("turn on the lights");
        vad.emitSpeechEnd();
        scheduler.fireByMs(END_OF_SPEECH_MS);
        await drain();
        // The flush deadline fires because the fake engine never delivers a
        // final on stop; the accumulated segments submit as the command.
        scheduler.fireByMs(NO_SPEECH_MS);
        await drain();
        expect(submits).toEqual(["turn on the lights"]);
    });

    it("a wake during a live turn is ignored (barge-in comes later)", async () => {
        const harness = makeHarness();
        const { wakeStt, wake, controller } = harness;
        await controller.enableWake();
        await drain();
        controller.press();
        await drain();
        expect(controller.getSnapshot().state).toBe("listening");
        wake.emitWake({ confidence: 0.9, lookback });
        await drain();
        expect(wakeStt.startCalls).toBe(0);
        expect(controller.getSnapshot().state).toBe("listening");
    });

    it("a session that fails to open re-arms the detector", async () => {
        const harness = makeHarness();
        const { wakeStt, wake, controller } = harness;
        await controller.enableWake();
        wakeStt.startError = { code: "engine", message: "no model" };
        wake.emitWake({ confidence: 0.9 });
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        // Back to idle is armed again, ready for the next phrase; a
        // successful re-arm also clears the failure error.
        expect(wake.startCalls).toBe(2);
        expect(controller.getSnapshot().wakeArmed).toBe(true);
    });
});

describe("re-arming after turns", () => {
    it("a wake-opened turn that settles re-arms the detector", async () => {
        // Engine-native wake session: the final submits straight away.
        const harness = makeHarness(false);
        const { wake, wakeStt, controller, settleSubmit } = harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        wakeStt.emitResult("what time is it");
        await drain();
        expect(controller.getSnapshot().state).toBe("waiting");
        settleSubmit();
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().wakeArmed).toBe(true);
        expect(wake.startCalls).toBe(2);
    });

    it("a press-to-talk turn that settles re-arms a disabled-for-the-session detector", async () => {
        const harness = makeHarness(false);
        const { stt, wake, controller, settleSubmit } = harness;
        await controller.enableWake();
        await drain();
        controller.press();
        await drain();
        // The press disarmed the detector so the mic is single-owner; the
        // flag says re-arm once this turn settles.
        expect(controller.getSnapshot().wakeArmed).toBe(false);
        stt.emitResult("shuffle my playlist");
        await drain();
        settleSubmit();
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().wakeArmed).toBe(true);
        // Armed once at enable, once at re-arm.
        expect(wake.startCalls).toBe(2);
    });

    it("disableWake during a wake session keeps it off", async () => {
        const harness = makeHarness(false);
        const { wake, wakeStt, controller, settleSubmit } = harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        void controller.disableWake();
        wakeStt.emitResult("stop the music");
        await drain();
        settleSubmit();
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().wakeArmed).toBe(false);
        expect(wake.startCalls).toBe(1);
    });
});

describe("wake failures", () => {
    it("a mid-run detector failure records the error and stays disarmed", async () => {
        const harness = makeHarness();
        const { wake, controller } = harness;
        await controller.enableWake();
        wake.emitError({ code: "engine", message: "the mic track ended" });
        await drain();
        expect(controller.getSnapshot().wakeArmed).toBe(false);
        expect(controller.getSnapshot().error).toMatchObject({
            code: "engine",
            message: "the mic track ended",
        });
        // No auto-retry: arming requires the user's toggle again.
        await drain();
        expect(wake.startCalls).toBe(1);
    });
});
