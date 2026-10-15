/**
 * Voice-controller wake-word tests (issue #84, phase 4; single-mic wake
 * sessions in #121).
 *
 * The controller is driven with a scripted fake wake detector, fake STT
 * engines (one primary, one for wake sessions), a fake VAD, and a fake
 * scheduler — asserting on the observable `VoiceSnapshot` after each step:
 * arming/disarming, the wake session opening in **external-audio mode** on its
 * own engine, the detector's live command frames fed into that engine (held
 * across the opening window, dropped afterwards), the VAD being left alone,
 * phrase stripping as a safety net, and the detector restarting once a
 * wake-opened turn settles. Timer expiry is fired by hand, never by real
 * clocks.
 */
import { describe, expect, it } from "vitest";
import { MAX_COMMAND_MS, NO_SPEECH_MS, VoiceController } from "../src/index";
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
    /** Delivered as a final result when `stop()` flushes (engine vendors do). */
    resultOnStop: string | null = null;
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
        if (this.resultOnStop !== null) {
            this.callbacks?.onResult?.(this.resultOnStop);
        }
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

/** Scripted wake detector; the test fires matches and frames by hand. */
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

    /** One live post-match command frame, as the real detector streams it. */
    emitCommandAudio(pcm: Float32Array, sampleRate = 16000): void {
        this.callbacks?.onCommandAudio?.(pcm, sampleRate);
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
    pendingCount(): number;
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
        pendingCount: () => tasks.size,
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
    traces: Array<{ raw: string; submitted: string }>;
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
    const traces: Array<{ raw: string; submitted: string }> = [];
    const submitResolvers: Array<() => void> = [];
    const controller = new VoiceController({
        stt,
        wakeStt,
        vad: vadProvider,
        wake,
        wakePhrase: "Hey JARVIS",
        schedule: scheduler.schedule,
        unschedule: scheduler.unschedule,
        traceTranscript: (raw, submitted) => {
            traces.push({ raw, submitted });
        },
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
        traces,
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

/** The frame's samples as a plain array (float PCM comparisons read better). */
function samples(pcm: Float32Array): number[] {
    return Array.from(pcm);
}

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

describe("wake sessions (single-mic, #121)", () => {
    it("opens an external wake session and feeds it the detector's frames", async () => {
        const harness = makeHarness();
        const { stt, wakeStt, vad, wake, controller } = harness;
        await controller.enableWake();
        await drain();
        expect(controller.getSnapshot().wakeArmed).toBe(true);
        expect(controller.getSnapshot().state).toBe("idle");

        wake.emitWake({ confidence: 0.91 });
        // The match fires synchronously; the session is still opening (the
        // cue and `begin()`'s awaits). The detector keeps capturing, so these
        // frames — the command's opening — must be held, not dropped.
        const opening = Float32Array.from([0.11, 0.12]);
        wake.emitCommandAudio(opening);
        await drain();

        expect(controller.getSnapshot().wakeArmed).toBe(false);
        expect(controller.getSnapshot().state).toBe("listening");
        expect(stt.startCalls).toBe(0);
        expect(wakeStt.startCalls).toBe(1);
        // External audio, at the detector's 16 kHz convention — no microphone
        // of its own and no continuous (VAD-owned) capture.
        expect(wakeStt.lastStartOptions).toEqual({
            source: "external",
            sampleRate: 16000,
        });
        // The VAD is for press and barge sessions; a wake session's command
        // endpointing is the engine's own silence detection.
        expect(vad?.startCalls).toBe(0);
        // The detector is NOT stopped: it is the wake session's microphone.
        expect(wake.stopCalls).toBe(0);

        const live = Float32Array.from([0.21]);
        wake.emitCommandAudio(live);
        expect(wakeStt.fed.map((chunk) => samples(chunk.pcm))).toEqual([
            samples(opening),
            samples(live),
        ]);
        expect(wakeStt.fed.map((chunk) => chunk.sampleRate)).toEqual([
            16000, 16000,
        ]);
    });

    it("submits nothing before any frame arrives", async () => {
        const harness = makeHarness(false);
        const { wakeStt, wake, controller } = harness;
        await controller.enableWake();
        await drain();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        expect(wakeStt.startCalls).toBe(1);
        expect(wakeStt.fed).toEqual([]);
        expect(harness.submits).toEqual([]);
    });

    it("phrase stripping turns the transcript into the command", async () => {
        const harness = makeHarness(false);
        const { wakeStt, wake, controller, submits, traces } = harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        wakeStt.emitResult("Hey JARVIS, turn on the living room light");
        await drain();
        expect(submits).toEqual(["turn on the living room light"]);
        expect(controller.getSnapshot().transcript).toBe(
            "turn on the living room light",
        );
        // The raw-vs-submitted trace still fires (#121 lesson 6).
        expect(traces).toEqual([
            {
                raw: "Hey JARVIS, turn on the living room light",
                submitted: "turn on the living room light",
            },
        ]);
    });

    it("ignores the VAD it was handed", async () => {
        // A wake session never arms the VAD (the detector already owns the
        // microphone), even though the controller has one configured.
        const harness = makeHarness(true);
        const { wakeStt, vad, wake } = harness;
        await harness.controller.enableWake();
        wake.emitWake({ confidence: 0.85 });
        await drain();
        wakeStt.emitResult("what time is it");
        await drain();
        expect(vad?.startCalls).toBe(0);
        expect(wakeStt.lastStartOptions?.continuous).toBeUndefined();
        expect(harness.submits).toEqual(["what time is it"]);
    });

    it("ends quietly when the phrase fires but no command arrives", async () => {
        const harness = makeHarness(false);
        const { wakeStt, wake, controller, scheduler, submits } = harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        expect(scheduler.pendingCount()).toBeGreaterThan(1);
        scheduler.fireByMs(NO_SPEECH_MS);
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().error).toBeNull();
        expect(wakeStt.cancelCalls).toBe(1);
        expect(submits).toEqual([]);
    });

    it("flushes what was heard when the command window elapses", async () => {
        const harness = makeHarness(false);
        const { wakeStt, wake, controller, scheduler, submits } = harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        wake.emitCommandAudio(Float32Array.from([0.3]));
        // A command that never pauses: the engine keeps decoding partials, so
        // the silence guard is cancelled and only the command bound is left.
        wakeStt.emitPartial("tell me about abraham lincoln");
        wakeStt.resultOnStop = "tell me about abraham lincoln";
        scheduler.fireByMs(MAX_COMMAND_MS);
        await drain();
        expect(wakeStt.stopCalls).toBe(1);
        expect(submits).toEqual(["tell me about abraham lincoln"]);
        expect(controller.getSnapshot().state).toBe("waiting");
    });

    it("hands the flush final through the trace when the window elapses", async () => {
        const harness = makeHarness(false);
        const { wakeStt, wake, controller, scheduler, submits, traces } =
            harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        wakeStt.resultOnStop = "hey jarvis what time is it";
        scheduler.fireByMs(MAX_COMMAND_MS);
        await drain();
        expect(submits).toEqual(["what time is it"]);
        expect(traces).toEqual([
            { raw: "hey jarvis what time is it", submitted: "what time is it" },
        ]);
    });

    it("drops frames once the session is past listening", async () => {
        const harness = makeHarness(false);
        const { wakeStt, wake, controller, settleSubmit } = harness;
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await drain();
        wake.emitCommandAudio(Float32Array.from([0.4]));
        expect(wakeStt.fed).toHaveLength(1);
        wakeStt.emitResult("what time is it");
        await drain();
        expect(controller.getSnapshot().state).toBe("waiting");
        // The detector may still be capturing until the turn lands idle; its
        // frames must not become the next command's opening.
        wake.emitCommandAudio(Float32Array.from([9, 9, 9]));
        settleSubmit();
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        wake.emitWake({ confidence: 0.9 });
        await drain();
        // The second session was fed only what the new match produced: nothing.
        expect(wakeStt.fed).toHaveLength(1);
    });

    it("a wake during a live turn is ignored (barge-in comes later)", async () => {
        const harness = makeHarness();
        const { wakeStt, wake, controller } = harness;
        await controller.enableWake();
        await drain();
        controller.press();
        await drain();
        expect(controller.getSnapshot().state).toBe("listening");
        wake.emitWake({ confidence: 0.9 });
        await drain();
        expect(wakeStt.startCalls).toBe(0);
        expect(controller.getSnapshot().state).toBe("listening");
    });

    it("a session that fails to open restarts the detector", async () => {
        const harness = makeHarness();
        const { wakeStt, wake, controller } = harness;
        await controller.enableWake();
        wakeStt.startError = { code: "engine", message: "no model" };
        wake.emitWake({ confidence: 0.9 });
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        // Back to idle is armed again, ready for the next phrase; a
        // successful restart also clears the failure error.
        expect(wake.startCalls).toBe(2);
        expect(controller.getSnapshot().wakeArmed).toBe(true);
    });
});

describe("re-arming after turns", () => {
    it("a wake-opened turn that settles restarts the detector", async () => {
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
        // The detector was still capturing for the command, so the restart
        // stops it before arming again.
        expect(wake.stopCalls).toBe(1);
        expect(wake.startCalls).toBe(2);
    });

    it("a press-to-talk turn that settles re-arms a detector disarmed for the session", async () => {
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

describe("wake race fixes (#104)", () => {
    it("a press landing while the wake cue plays is not clobbered", async () => {
        // Race 2: handleWake blocks on the cue; the user presses in that
        // window and opens a primary session. When the cue releases, the
        // wake session's begin() must find the reducer already past idle
        // and bail instead of opening a second session over the live one —
        // and must not leave the detector's held frames behind (#121).
        const stt = new FakeStt("primary");
        const wakeStt = new FakeStt("wake");
        const wake = new FakeWake();
        let releaseCue: (() => void) | null = null;
        const cue = new Promise<void>((resolve) => {
            releaseCue = resolve;
        });
        const controller = new VoiceController({
            stt,
            wakeStt,
            wake,
            wakePhrase: "Hey JARVIS",
            onWakeCue: () => cue,
            submit: async () => {},
        });
        await controller.enableWake();
        wake.emitWake({ confidence: 0.9 });
        await Promise.resolve();
        // The detector is streaming the command while the cue still plays.
        wake.emitCommandAudio(Float32Array.from([1, 2, 3]));
        // The user presses the mic button.
        controller.press();
        await drain();
        expect(controller.getSnapshot().state).toBe("listening");
        expect(stt.startCalls).toBe(1);
        // Release the cue: the stale wake open is a no-op.
        releaseCue!();
        await drain();
        expect(wakeStt.startCalls).toBe(0);
        expect(stt.startCalls).toBe(1);
        expect(controller.getSnapshot().state).toBe("listening");
        // The press session is not seeded with the held wake frames.
        expect(stt.fed).toEqual([]);
        await controller.dispose();
    });

    it("enableWake during a live session defers arming until idle", async () => {
        // Race 6: arming the detector mid-session would open a second
        // microphone alongside the live one.
        const harness = makeHarness(false);
        const { stt, wake, controller, settleSubmit } = harness;
        controller.press();
        await drain();
        expect(controller.getSnapshot().state).toBe("listening");
        void controller.enableWake();
        await drain();
        expect(wake.startCalls).toBe(0);
        expect(controller.getSnapshot().wakeArmed).toBe(false);
        // The session settles; the deferred arm now runs.
        stt.emitResult("shuffle my playlist");
        await drain();
        settleSubmit();
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(wake.startCalls).toBe(1);
        expect(controller.getSnapshot().wakeArmed).toBe(true);
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
