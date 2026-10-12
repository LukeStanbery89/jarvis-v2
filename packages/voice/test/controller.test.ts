/**
 * Voice controller tests (issue #84, phases 2–3).
 *
 * The controller is driven with a scripted fake STT engine, a fake VAD, and
 * a fake scheduler, asserting on the observable VoiceSnapshot after each
 * step — including identity semantics inherited from the lifecycle reducer
 * (stale events return the same snapshot). VAD-owned endpointing,
 * continuous-capture accumulation, and the quiet no-speech path are
 * exercised against the same fakes; timer expiry is fired by hand, never
 * by real clocks.
 */
import { describe, expect, it } from "vitest";
import {
    END_OF_SPEECH_MS,
    NO_SPEECH_MS,
    VoiceController,
    initialVoiceSnapshot,
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

/** Scripted STT double: the test drives deliveries directly. */
class FakeStt implements SttProvider {
    readonly id = "fake";
    state: SttState = "idle";
    startCalls = 0;
    stopCalls = 0;
    cancelCalls = 0;
    /** Set to reject the next start(). */
    startError: VoiceError | null = null;
    /** Options of the most recent start() (continuous flag bookkeeping). */
    lastStartOptions: SttStartOptions | undefined = undefined;
    private callbacks: SttCallbacks | null = null;

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

/** Scripted VAD double: the test drives speech events directly. */
class FakeVad implements VadProvider {
    readonly id = "fake-vad";
    startCalls = 0;
    stopCalls = 0;
    /** Set to reject the next start() (detector unavailable fallback). */
    startError: VoiceError | null = null;
    private callbacks: VadCallbacks | null = null;

    async start(callbacks: VadCallbacks): Promise<void> {
        this.startCalls += 1;
        if (this.startError !== null) {
            throw this.startError;
        }
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

    emitError(error: VoiceError): void {
        this.callbacks?.onError?.(error);
    }
}

/** Controllable submit seam: records calls, settles promises by hand. */
interface SubmitControl {
    calls: string[];
    /** Resolves the oldest pending submit. */
    resolve(): void;
    /** Rejects the oldest pending submit with the given error. */
    reject(err: Error): void;
}

function makeSubmit(): SubmitControl {
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const rejecters: Array<(err: Error) => void> = [];
    return {
        calls,
        resolve: () => {
            resolvers.shift()?.();
        },
        reject: (err) => {
            rejecters.shift()?.(err);
        },
    };
}

/**
 * Fake scheduler: timers never tick on their own; tests fire them by their
 * millisecond value (END_OF_SPEECH_MS vs NO_SPEECH_MS) and inspect what is
 * pending.
 */
interface FakeScheduler {
    /** The controller-facing schedule seam. */
    schedule(callback: () => void, ms: number): unknown;
    /** The controller-facing unschedule seam. */
    unschedule(handle: unknown): void;
    /** Fires every pending callback scheduled for the given delay. */
    fireByMs(ms: number): void;
    /** Millisecond values of currently pending callbacks. */
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

/** Test harness: controller + its fakes + the snapshot notifications. */
interface Harness {
    stt: FakeStt;
    vad: FakeVad | null;
    scheduler: FakeScheduler;
    controller: VoiceController;
    snapshots: VoiceSnapshot[];
    submitControl: SubmitControl;
}

function makeHarness(options?: { vad?: FakeVad | null }): Harness {
    const stt = new FakeStt();
    const vad = options?.vad === undefined ? null : (options.vad ?? null);
    const scheduler = makeScheduler();
    const submitControl = makeSubmit();
    const resolvers: Array<() => void> = [];
    const rejecters: Array<(err: Error) => void> = [];
    const snapshots: VoiceSnapshot[] = [];
    const controller = new VoiceController({
        stt,
        vad,
        schedule: scheduler.schedule,
        unschedule: scheduler.unschedule,
        submit: (text) => {
            submitControl.calls.push(text);
            return new Promise<void>((resolve, reject) => {
                resolvers.push(resolve);
                rejecters.push(reject);
            });
        },
    });
    controller.subscribe(() => snapshots.push(controller.getSnapshot()));
    const settle = {
        resolve: () => {
            resolvers.shift()?.();
        },
        reject: (err: Error) => {
            rejecters.shift()?.(err);
        },
    };
    return {
        stt,
        vad,
        scheduler,
        controller,
        snapshots,
        submitControl: { ...submitControl, ...settle },
    };
}

/** Drives a full press → transcript("hi") flow, leaving the turn pending. */
async function armTurn(harness: Harness): Promise<void> {
    const { stt, controller } = harness;
    controller.press();
    await Promise.resolve();
    stt.emitResult("hi");
}

/** Drains a controller press's async start chain (several microtasks). */
async function drain(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
}

describe("press-to-talk flow", () => {
    it("press → partials → final transcript → submitted → turn end → idle", async () => {
        const harness = makeHarness();
        const { stt, controller, snapshots, submitControl } = harness;
        expect(controller.getSnapshot()).toBe(initialVoiceSnapshot);

        controller.press();
        await Promise.resolve();
        expect(stt.startCalls).toBe(1);
        expect(controller.getSnapshot().state).toBe("listening");

        stt.emitPartial("turn on the");
        expect(controller.getSnapshot().partial).toBe("turn on the");

        stt.emitResult("turn on the living room light");
        // Synchronous on result: transcript → submitting → submitted → waiting.
        expect(controller.getSnapshot().state).toBe("waiting");
        expect(controller.getSnapshot().transcript).toBe(
            "turn on the living room light",
        );
        expect(submitControl.calls).toEqual(["turn on the living room light"]);

        submitControl.resolve();
        await Promise.resolve();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(snapshots.length).toBeGreaterThan(0);
    });

    it("a second press while listening stops and transcribes", async () => {
        const { stt, controller } = makeHarness();
        controller.press();
        await Promise.resolve();
        controller.press();
        await Promise.resolve();
        expect(stt.stopCalls).toBe(1);
        expect(stt.startCalls).toBe(1);
    });

    it("press during mid-flight states is inert", async () => {
        const { stt, controller } = makeHarness();
        controller.press();
        await Promise.resolve();
        stt.emitResult("hello");
        expect(controller.getSnapshot().state).toBe("waiting");
        controller.press();
        await Promise.resolve();
        expect(stt.startCalls).toBe(1);
        expect(stt.stopCalls).toBe(0);
    });
});

describe("turn outcomes", () => {
    it("a resolved submit ends the voice turn", async () => {
        const harness = makeHarness();
        await armTurn(harness);
        harness.submitControl.resolve();
        await Promise.resolve();
        expect(harness.controller.getSnapshot().state).toBe("idle");
        expect(harness.controller.getSnapshot().error).toBeNull();
    });

    it("a rejected submit records the error and returns to idle", async () => {
        const harness = makeHarness();
        await armTurn(harness);
        harness.submitControl.reject(
            new Error("another prompt is already in progress"),
        );
        // Two ticks: the rejection propagates through .then into .catch
        // before the reducer records it.
        await Promise.resolve();
        await Promise.resolve();
        expect(harness.controller.getSnapshot().state).toBe("idle");
        expect(harness.controller.getSnapshot().error).toEqual({
            code: "rejected",
            message: "another prompt is already in progress",
        });
    });

    it("response frames move waiting → responding exactly once", async () => {
        const harness = makeHarness();
        await armTurn(harness);
        expect(harness.controller.getSnapshot().state).toBe("waiting");
        harness.controller.noteResponseFrame();
        expect(harness.controller.getSnapshot().state).toBe("responding");
        harness.controller.noteResponseFrame();
        harness.controller.noteResponseFrame();
        expect(harness.controller.getSnapshot().state).toBe("responding");
        harness.submitControl.resolve();
        await Promise.resolve();
        expect(harness.controller.getSnapshot().state).toBe("idle");
    });

    it("audioStart moves a voice turn to speaking (#83)", async () => {
        const harness = makeHarness();
        await armTurn(harness);
        harness.controller.noteResponseFrame();
        harness.controller.noteAudioStarted();
        expect(harness.controller.getSnapshot().state).toBe("speaking");
        harness.submitControl.resolve();
        await Promise.resolve();
        expect(harness.controller.getSnapshot().state).toBe("idle");
    });

    it("audioStart outside a voice turn is ignored", () => {
        const { controller } = makeHarness();
        controller.noteAudioStarted();
        expect(controller.getSnapshot()).toBe(initialVoiceSnapshot);
    });

    it("response frames outside a voice turn are ignored", () => {
        const { controller } = makeHarness();
        controller.noteResponseFrame();
        expect(controller.getSnapshot()).toBe(initialVoiceSnapshot);
    });
});

describe("engine failures", () => {
    it("start rejection ends the session with the error", async () => {
        const stt = new FakeStt();
        stt.startError = { code: "permission-denied", message: "denied" };
        const controller = new VoiceController({
            stt,
            submit: async () => {},
        });
        controller.press();
        await Promise.resolve();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().error).toEqual({
            code: "permission-denied",
            message: "denied",
        });
    });

    it("engine error (e.g. no speech) ends the session without submitting", async () => {
        const harness = makeHarness();
        harness.controller.press();
        await Promise.resolve();
        harness.stt.emitError({
            code: "no-speech",
            message: "no speech was detected",
        });
        expect(harness.controller.getSnapshot().state).toBe("idle");
        expect(harness.controller.getSnapshot().error).toEqual({
            code: "no-speech",
            message: "no speech was detected",
        });
        expect(harness.submitControl.calls).toEqual([]);
    });

    it("an empty transcript never submits", async () => {
        const { stt, controller, submitControl } = makeHarness();
        controller.press();
        await Promise.resolve();
        stt.emitResult("   ");
        expect(controller.getSnapshot().state).toBe("listening");
        expect(submitControl.calls).toEqual([]);
    });

    it("dispose cancels live recognition", async () => {
        const { stt, controller } = makeHarness();
        controller.press();
        await Promise.resolve();
        await controller.dispose();
        expect(stt.cancelCalls).toBe(1);
        expect(stt.state).toBe("idle");
    });
});

describe("subscribe", () => {
    it("notifies listeners only when the snapshot changes", async () => {
        const { controller, snapshots } = makeHarness();
        controller.press();
        await Promise.resolve();
        const afterPress = snapshots.length;
        // A frame outside a turn changes nothing → no extra notification.
        controller.noteResponseFrame();
        expect(snapshots.length).toBe(afterPress);
    });
});

describe("vad endpointing", () => {
    it("arms the VAD and starts the engine continuously", async () => {
        const { stt, vad, scheduler, controller } = makeHarness({
            vad: new FakeVad(),
        });
        expect(vad).not.toBeNull();
        controller.press();
        await drain();
        expect(stt.startCalls).toBe(1);
        expect(stt.lastStartOptions?.continuous).toBe(true);
        // The silence guard is pending from the press.
        expect(scheduler.pendingMs()).toEqual([NO_SPEECH_MS]);
    });

    it("end-of-speech transcribes, flushes, and submits the final", async () => {
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        vad?.emitSpeechEnd();
        // Speech resumed inside the window would cancel the timer; here it
        // expires: transcribing + engine flush.
        scheduler.fireByMs(END_OF_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("transcribing");
        expect(stt.stopCalls).toBe(1);
        expect(vad?.stopCalls).toBe(1);
        // The flush delivers the last final segment → submit.
        stt.emitResult("hello there");
        expect(controller.getSnapshot().state).toBe("waiting");
        expect(submitControl.calls).toEqual(["hello there"]);
    });

    it("submits accumulated finals the moment the flush settles without a final", async () => {
        // The regression this pins: an engine flush that produced no final
        // (vosk's continuous mode suppresses the no-speech error) used to
        // park the user on the full NO_SPEECH_MS deadline before the
        // accumulated transcript was submitted — read as "it doesn't submit
        // until I say something else". The flush await resolves; the
        // decision is immediate.
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        stt.emitResult("what time"); // a mid-capture final segment
        vad?.emitSpeechEnd();
        scheduler.fireByMs(END_OF_SPEECH_MS);
        await drain(); // the flush await settles — FakeStt delivers no final
        expect(controller.getSnapshot().state).toBe("waiting");
        expect(submitControl.calls).toEqual(["what time"]);
        // The flush deadline was cleared, never fired.
        expect(scheduler.pendingMs()).toEqual([]);
    });

    it("ends quietly when the flush settles with nothing recognized", async () => {
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        vad?.emitSpeechEnd();
        scheduler.fireByMs(END_OF_SPEECH_MS);
        await drain();
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().error).toBeNull();
        expect(submitControl.calls).toEqual([]);
        expect(stt.cancelCalls).toBe(1);
        expect(scheduler.pendingMs()).toEqual([]);
    });

    it("continuous finals accumulate into one transcript", async () => {
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        // A final segment arrives while speech may continue: displayed, not
        // submitted.
        stt.emitResult("hello");
        expect(controller.getSnapshot().state).toBe("listening");
        expect(submitControl.calls).toEqual([]);
        expect(controller.getSnapshot().partial).toBe("hello");
        // Segment two's interim is per-segment text (the prior segment was
        // already delivered as a final): composed behind it for display.
        stt.emitPartial("world");
        expect(controller.getSnapshot().partial).toBe("hello world");
        // VAD says the user is done; the flush adds the last segment.
        vad?.emitSpeechEnd();
        scheduler.fireByMs(END_OF_SPEECH_MS);
        stt.emitResult("world");
        expect(controller.getSnapshot().state).toBe("waiting");
        expect(submitControl.calls).toEqual(["hello world"]);
    });

    it("a manual press routes through the same end-of-speech pipeline", async () => {
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        stt.emitResult("send now"); // a mid-capture final segment
        controller.press(); // stop-and-send
        await drain();
        // The flush settled (no further final); the accumulated finals
        // submitted immediately.
        expect(controller.getSnapshot().state).toBe("waiting");
        expect(stt.stopCalls).toBe(1);
        expect(vad?.stopCalls).toBe(1);
        expect(submitControl.calls).toEqual(["send now"]);
        expect(scheduler.pendingMs()).toEqual([]);
    });

    it("resumed speech dominates the end-of-speech timer", async () => {
        const { stt, vad, scheduler, controller } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        vad?.emitSpeechEnd();
        vad?.emitSpeechStart();
        // The armed end-of-speech timer was cancelled by the resume: firing
        // its slot now does nothing.
        scheduler.fireByMs(END_OF_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("listening");
        expect(stt.stopCalls).toBe(0);
        // Speech ends again → the timer arms fresh and submits on expiry.
        vad?.emitSpeechEnd();
        scheduler.fireByMs(END_OF_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("transcribing");
        expect(stt.stopCalls).toBe(1);
    });

    it("a flush deadline with captured speech submits what was recognized", async () => {
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        stt.emitResult("still here");
        vad?.emitSpeechEnd();
        scheduler.fireByMs(END_OF_SPEECH_MS);
        // The engine's flush produced no further final by the deadline.
        scheduler.fireByMs(NO_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("waiting");
        expect(submitControl.calls).toEqual(["still here"]);
    });

    it("a vad false-trigger with no recognized speech ends quietly", async () => {
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        vad?.emitSpeechStart();
        vad?.emitSpeechEnd();
        scheduler.fireByMs(END_OF_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("transcribing");
        // The flush deadline finds no finals: quiet idle, no error, no submit.
        scheduler.fireByMs(NO_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().error).toBeNull();
        expect(submitControl.calls).toEqual([]);
        expect(stt.cancelCalls).toBe(1);
    });

    it("a vad session's engine error still surfaces and stops the engine", async () => {
        const { stt, vad, controller } = makeHarness({ vad: new FakeVad() });
        controller.press();
        await drain();
        stt.emitError({ code: "engine", message: "recognition failed" });
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().error).toEqual({
            code: "engine",
            message: "recognition failed",
        });
        expect(vad?.stopCalls).toBe(1);
    });

    it("dispose stops the vad alongside the engine", async () => {
        const { stt, vad, controller } = makeHarness({ vad: new FakeVad() });
        controller.press();
        await drain();
        await controller.dispose();
        expect(stt.cancelCalls).toBe(1);
        expect(vad?.stopCalls).toBe(1);
    });
});

describe("no-speech timeout", () => {
    it("a press with silence returns to idle quietly", async () => {
        const { stt, vad, scheduler, controller, submitControl } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        scheduler.fireByMs(NO_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("idle");
        expect(controller.getSnapshot().error).toBeNull();
        expect(submitControl.calls).toEqual([]);
        expect(stt.cancelCalls).toBe(1);
        expect(vad?.stopCalls).toBe(1);
    });

    it("detected speech cancels the silence guard", async () => {
        const { vad, scheduler, controller } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        expect(scheduler.pendingMs()).toEqual([NO_SPEECH_MS]);
        vad?.emitSpeechStart();
        expect(scheduler.pendingMs()).toEqual([]);
        // Firing the (now nonexistent) slot changes nothing.
        scheduler.fireByMs(NO_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("listening");
    });

    it("interim transcripts also cancel the silence guard", async () => {
        const { stt, scheduler, controller } = makeHarness({
            vad: new FakeVad(),
        });
        controller.press();
        await drain();
        stt.emitPartial("words");
        expect(scheduler.pendingMs()).toEqual([]);
        scheduler.fireByMs(NO_SPEECH_MS);
        expect(controller.getSnapshot().state).toBe("listening");
    });
});

describe("vad unavailability fallback", () => {
    it("a vad that cannot start falls back to engine-native endpointing", async () => {
        const vad = new FakeVad();
        vad.startError = { code: "engine", message: "no microphone track" };
        const { stt, scheduler, controller, submitControl } = makeHarness({
            vad,
        });
        controller.press();
        await drain();
        // No continuous flag, no timers, no error banner.
        expect(stt.lastStartOptions).toBeUndefined();
        expect(scheduler.pendingMs()).toEqual([]);
        expect(controller.getSnapshot().state).toBe("listening");
        expect(controller.getSnapshot().error).toBeNull();
        // The engine's own final submits directly.
        stt.emitResult("native path");
        expect(controller.getSnapshot().state).toBe("waiting");
        expect(submitControl.calls).toEqual(["native path"]);
    });

    it("no vad at all never arms timers (engine-native behavior)", async () => {
        const { stt, scheduler, controller } = makeHarness();
        controller.press();
        await Promise.resolve();
        expect(stt.lastStartOptions).toBeUndefined();
        expect(scheduler.pendingMs()).toEqual([]);
        stt.emitResult("hi");
        expect(controller.getSnapshot().state).toBe("waiting");
    });

    it("logs the VAD-start failure through the injectable sink", async () => {
        // The engine-native fallback is the difference between automatic
        // submit and press-to-stop; without the sink it was invisible (the
        // exact "endpointing silently stopped working" report).
        const vad = new FakeVad();
        vad.startError = { code: "engine", message: "no microphone track" };
        const logged: Array<{ message: string; error: unknown }> = [];
        const stt = new FakeStt();
        const scheduler = makeScheduler();
        const submitControl = makeSubmit();
        const resolvers: Array<() => void> = [];
        const rejecters: Array<(err: Error) => void> = [];
        const controller = new VoiceController({
            stt,
            vad,
            schedule: scheduler.schedule,
            unschedule: scheduler.unschedule,
            log: (message, error) => logged.push({ message, error }),
            submit: (text) => {
                submitControl.calls.push(text);
                return new Promise<void>((resolve, reject) => {
                    resolvers.push(resolve);
                    rejecters.push(reject);
                });
            },
        });
        controller.press();
        await drain();
        expect(logged).toHaveLength(2);
        expect(logged[0]!.message).toMatch(/VAD unavailable/);
        expect(logged[0]!.error).toMatchObject({
            message: "no microphone track",
        });
        // And the session announces which endpointing mode it degraded to.
        expect(logged[1]!.message).toMatch(/engine-native endpointing/);
        // Degradation is otherwise unchanged: engine-native session runs.
        expect(controller.getSnapshot().state).toBe("listening");
    });
});
