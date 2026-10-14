/**
 * `WakeManager` unit tests (issue #110).
 *
 * The extracted manager is driven over a fake {@link VoiceCore} — a scripted
 * wake detector, a wake STT engine that counts pre-warms, and a real
 * `reduceVoice`-backed reducer — so its own contract is pinned independently
 * of the controller: arming (and pre-warming), the defer-while-busy interlock
 * (#104 race 6), session disarm + re-arm, match delivery (including the
 * failed-open re-arm), drain, and the failure/dispose paths.
 */
import { describe, expect, it } from "vitest";
import type { VoiceCore } from "../src/core";
import { initialVoiceSnapshot, reduceVoice } from "../src/lifecycle";
import type { VoiceSnapshot } from "../src/lifecycle";
import { DEFAULT_WAKE_PHRASE, WakeManager, wakeReplay } from "../src/wake";
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    SttState,
    VoiceError,
    WakeCallbacks,
    WakeDetection,
    WakeWordProvider,
} from "../src/types";

/** Scripted wake detector; the test fires matches/errors by hand. */
class FakeWake implements WakeWordProvider {
    readonly id = "fake-wake";
    startCalls = 0;
    stopCalls = 0;
    drained: Float32Array | null = null;
    /** Rejects the next `start()` when set. */
    startError: VoiceError | null = null;
    private callbacks: WakeCallbacks | null = null;

    async start(callbacks: WakeCallbacks): Promise<void> {
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

    drainPostMatch(): Float32Array | null {
        return this.drained;
    }

    emitWake(detection: WakeDetection): void {
        this.callbacks?.onWake(detection);
    }

    emitError(error: VoiceError): void {
        this.callbacks?.onError?.(error);
    }
}

/** Minimal STT double; only `prepare` matters to the manager. */
class FakeStt implements SttProvider {
    readonly id: string;
    state: SttState = "idle";
    prepareCalls = 0;

    constructor(id = "fake-stt") {
        this.id = id;
    }

    async start(
        _callbacks: SttCallbacks,
        _options?: SttStartOptions,
    ): Promise<void> {
        this.state = "running";
    }

    async stop(): Promise<void> {
        this.state = "idle";
    }

    async cancel(): Promise<void> {
        this.state = "idle";
    }

    async prepare(): Promise<void> {
        this.prepareCalls += 1;
    }

    feed(_pcm: Float32Array, _sampleRate: number): void {}
}

interface Harness {
    wake: FakeWake;
    wakeStt: FakeStt;
    core: VoiceCore;
    matches: WakeDetection[];
    logged: unknown[];
    snapshot(): VoiceSnapshot;
    setSnapshot(next: VoiceSnapshot): void;
}

/** Builds a manager over a fake `VoiceCore` (real reducer, fake providers). */
function harness(options?: {
    wake?: FakeWake | null;
    wakeStt?: FakeStt | null;
    onMatch?: (detection: WakeDetection) => void | Promise<void>;
}): { h: Harness; manager: WakeManager } {
    const wake = options?.wake === undefined ? new FakeWake() : options.wake;
    const wakeStt =
        options?.wakeStt === undefined ? new FakeStt() : options.wakeStt;
    const matches: WakeDetection[] = [];
    const logged: unknown[] = [];
    let snapshot = initialVoiceSnapshot;
    const disposed = { value: false };
    const core: VoiceCore = {
        snapshot: () => snapshot,
        reduce: (event) => {
            snapshot = reduceVoice(snapshot, event);
        },
        vad: null,
        schedule: () => 0,
        unschedule: () => {},
        log: (_message, error) => {
            logged.push(error);
        },
        traceTranscript: () => {},
        isDisposed: () => disposed.value,
        stopVad: async () => {},
    };
    const manager = new WakeManager(core, {
        wake,
        wakeStt,
        onMatch:
            options?.onMatch ??
            ((detection) => {
                matches.push(detection);
            }),
    });
    const h: Harness = {
        wake: wake as FakeWake,
        wakeStt: wakeStt as FakeStt,
        core,
        matches,
        logged,
        snapshot: () => snapshot,
        setSnapshot: (next) => {
            snapshot = next;
        },
    };
    return { h, manager };
}

async function drain(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
}

describe("WakeManager arming", () => {
    it("enable arms the detector and warms the wake engine", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        expect(h.wake.startCalls).toBe(1);
        expect(h.wakeStt.prepareCalls).toBe(1);
        expect(h.snapshot().wakeArmed).toBe(true);
    });

    it("enable while a session is live defers until idle + maybeReArm", async () => {
        const { h, manager } = harness();
        // Simulate a live session (not idle).
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "activate" }));
        await manager.enable();
        await drain();
        expect(h.wake.startCalls).toBe(0);
        // Session settles back to idle; the controller pings maybeReArm.
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "cancel" }));
        manager.maybeReArm();
        await drain();
        expect(h.wake.startCalls).toBe(1);
        expect(h.snapshot().wakeArmed).toBe(true);
    });

    it("disable disarms and keeps the detector off", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        await manager.disable();
        expect(h.wake.stopCalls).toBe(1);
        expect(h.snapshot().wakeArmed).toBe(false);
        // A later maybeReArm stays off: the user's intent is off.
        manager.maybeReArm();
        await drain();
        expect(h.wake.startCalls).toBe(1);
    });

    it("is a no-op without a detector or wake engine", async () => {
        const noWake = harness({ wake: null });
        await noWake.manager.enable();
        await drain();
        expect(noWake.h.snapshot().wakeArmed).toBe(false);
    });

    it("records a start failure and stays disarmed", async () => {
        const wake = new FakeWake();
        wake.startError = { code: "engine", message: "no model" };
        const { h, manager } = harness({ wake });
        await manager.enable();
        await drain();
        expect(h.snapshot().wakeArmed).toBe(false);
        expect(h.snapshot().error).toMatchObject({ code: "engine" });
    });

    it("records a mid-run detector failure and stays disarmed", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        h.wake.emitError({ code: "engine", message: "track ended" });
        await drain();
        expect(h.snapshot().wakeArmed).toBe(false);
        expect(h.snapshot().error).toMatchObject({ message: "track ended" });
        expect(h.wake.startCalls).toBe(1);
    });
});

describe("WakeManager session interlock", () => {
    it("disarmForSession disarms and maybeReArm brings it back once idle", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        expect(h.snapshot().wakeArmed).toBe(true);
        // A session begins: the manager disarms for it.
        manager.disarmForSession();
        expect(h.wake.stopCalls).toBe(1);
        expect(h.snapshot().wakeArmed).toBe(false);
        // While not idle, re-arm stays put.
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "activate" }));
        manager.maybeReArm();
        await drain();
        expect(h.wake.startCalls).toBe(1);
        // Session lands idle: the detector comes back.
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "cancel" }));
        manager.maybeReArm();
        await drain();
        expect(h.wake.startCalls).toBe(2);
        expect(h.snapshot().wakeArmed).toBe(true);
    });

    it("disarmForSession is a no-op when already disarmed", async () => {
        const { h, manager } = harness();
        manager.disarmForSession();
        expect(h.wake.stopCalls).toBe(0);
    });
});

describe("WakeManager matches", () => {
    it("a match hands the detection to onMatch", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        const detection: WakeDetection = { confidence: 0.9 };
        h.wake.emitWake(detection);
        await drain();
        expect(h.matches).toEqual([detection]);
    });

    it("a match during a live session is ignored", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "activate" }));
        h.wake.emitWake({ confidence: 0.9 });
        await drain();
        expect(h.matches).toHaveLength(0);
    });

    it("a match whose session fails to open re-arms the detector", async () => {
        // Mirror the controller's failed open: `begin()` disarms the
        // detector for the session, fails, and lands back on `idle`. The
        // manager then treats it as a failed open and re-arms.
        const ref: { core?: VoiceCore } = {};
        const { h, manager } = harness({
            onMatch: () => {
                ref.core?.reduce({ type: "wakeDisarmed" });
            },
        });
        ref.core = h.core;
        await manager.enable();
        await drain();
        expect(h.wake.startCalls).toBe(1);
        h.wake.emitWake({ confidence: 0.9 });
        await drain();
        expect(h.wake.startCalls).toBe(2);
        expect(h.snapshot().wakeArmed).toBe(true);
    });
});

describe("WakeManager drain + dispose", () => {
    it("drainPostMatch reads the detector's ring", async () => {
        const { h, manager } = harness();
        const ring = Float32Array.from([1, 2, 3]);
        h.wake.drained = ring;
        expect(manager.drainPostMatch()).toBe(ring);
    });

    it("drainPostMatch is null without a ring or detector", async () => {
        const none = harness({ wake: null });
        expect(none.manager.drainPostMatch()).toBeNull();
        const empty = harness();
        expect(empty.manager.drainPostMatch()).toBeNull();
    });

    it("dispose disarms and is idempotent", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        await manager.dispose();
        expect(h.snapshot().wakeArmed).toBe(false);
        await manager.dispose();
        expect(h.snapshot().wakeArmed).toBe(false);
    });
});

describe("wakeReplay", () => {
    it("joins look-back and drained audio in order", () => {
        const joined = wakeReplay(
            Float32Array.from([1, 2]),
            Float32Array.from([3, 4]),
        );
        expect(Array.from(joined ?? [])).toEqual([1, 2, 3, 4]);
    });

    it("returns the single present side", () => {
        expect(
            Array.from(wakeReplay(Float32Array.from([1]), null) ?? []),
        ).toEqual([1]);
        expect(
            Array.from(wakeReplay(undefined, Float32Array.from([2])) ?? []),
        ).toEqual([2]);
    });

    it("returns null when both are absent", () => {
        expect(wakeReplay(undefined, null)).toBeNull();
    });
});

describe("DEFAULT_WAKE_PHRASE", () => {
    it("is the trained phrase", () => {
        expect(DEFAULT_WAKE_PHRASE).toBe("Hey JARVIS");
    });
});
