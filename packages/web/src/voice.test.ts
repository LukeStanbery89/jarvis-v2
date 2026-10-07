/**
 * Voice controller tests (issue #84, phase 2).
 *
 * The controller is driven with a scripted fake STT engine and a
 * controllable submit promise, asserting on the observable VoiceSnapshot
 * after each step — including identity semantics inherited from the
 * lifecycle reducer (stale events return the same snapshot).
 */
import { describe, expect, it } from "vitest";
import {
    initialVoiceSnapshot,
    type SttCallbacks,
    type SttProvider,
    type SttState,
    type VoiceError,
    type VoiceSnapshot,
} from "@lukestanbery/jarvis-voice";
import { VoiceController } from "./voice";

/** Scripted STT double: the test drives deliveries directly. */
class FakeStt implements SttProvider {
    readonly id = "fake";
    state: SttState = "idle";
    startCalls = 0;
    stopCalls = 0;
    cancelCalls = 0;
    /** Set to reject the next start(). */
    startError: VoiceError | null = null;
    private callbacks: SttCallbacks | null = null;

    async start(callbacks: SttCallbacks): Promise<void> {
        this.startCalls += 1;
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

/** Test harness: controller + its fakes + the snapshot notifications. */
interface Harness {
    stt: FakeStt;
    controller: VoiceController;
    snapshots: VoiceSnapshot[];
    submitControl: SubmitControl;
}

function makeHarness(): Harness {
    const stt = new FakeStt();
    const submitControl = makeSubmit();
    const resolvers: Array<() => void> = [];
    const rejecters: Array<(err: Error) => void> = [];
    const snapshots: VoiceSnapshot[] = [];
    const controller = new VoiceController({
        stt,
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
