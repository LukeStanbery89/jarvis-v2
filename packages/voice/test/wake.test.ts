/**
 * `WakeManager` unit tests (issue #110).
 *
 * The extracted manager is driven over a fake {@link VoiceCore} — a scripted
 * wake detector, a wake STT engine that counts pre-warms, and a real
 * `reduceVoice`-backed reducer — so its own contract is pinned independently
 * of the controller: arming (and pre-warming), the defer-while-busy interlock
 * (#104 race 6), the press/wake session interlocks (stop for a press, keep
 * capturing for a wake, #121), command-audio forwarding, match delivery
 * (including the failed-open restart), and the failure/dispose paths.
 */
import { describe, expect, it } from "vitest";
import type { VoiceCore } from "../src/core";
import { initialVoiceSnapshot, reduceVoice } from "../src/lifecycle";
import type { VoiceSnapshot } from "../src/lifecycle";
import { DEFAULT_WAKE_PHRASE, WakeManager } from "../src/wake";
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
    /** Command frames the manager forwarded, in order (#121). */
    commandAudio: Array<{ pcm: Float32Array; sampleRate: number }>;
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
    const commandAudio: Array<{ pcm: Float32Array; sampleRate: number }> = [];
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
        onCommandAudio: (pcm, sampleRate) => {
            commandAudio.push({ pcm, sampleRate });
        },
    });
    const h: Harness = {
        wake: wake as FakeWake,
        wakeStt: wakeStt as FakeStt,
        core,
        matches,
        commandAudio,
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
    it("disarmForSession stops the detector and maybeReArm restarts it once idle", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        expect(h.snapshot().wakeArmed).toBe(true);
        // A press session begins: the manager stops the detector for it.
        manager.disarmForSession();
        expect(h.wake.stopCalls).toBe(1);
        expect(h.snapshot().wakeArmed).toBe(false);
        // While not idle, the restart stays put.
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "activate" }));
        manager.maybeReArm();
        await drain();
        expect(h.wake.startCalls).toBe(1);
        // Session lands idle: the detector comes back (stop + arm).
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "cancel" }));
        manager.maybeReArm();
        await drain();
        expect(h.wake.stopCalls).toBe(2);
        expect(h.wake.startCalls).toBe(2);
        expect(h.snapshot().wakeArmed).toBe(true);
    });

    it("disarmForSession is a no-op when already disarmed", async () => {
        const { h, manager } = harness();
        manager.disarmForSession();
        expect(h.wake.stopCalls).toBe(0);
    });

    it("beginCommand keeps the detector capturing but marks it disarmed (#121)", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        manager.beginCommand();
        // The microphone stays open — the frames that follow are the command.
        expect(h.wake.stopCalls).toBe(0);
        expect(h.snapshot().wakeArmed).toBe(false);
        // Once the turn lands idle the detector is restarted, not just
        // re-armed: it is still live, so start() alone would reject.
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "activate" }));
        manager.beginCommand();
        h.setSnapshot(reduceVoice(h.snapshot(), { type: "cancel" }));
        manager.maybeReArm();
        await drain();
        expect(h.wake.stopCalls).toBe(1);
        expect(h.wake.startCalls).toBe(2);
        expect(h.snapshot().wakeArmed).toBe(true);
    });
});

describe("WakeManager command audio", () => {
    it("forwards the detector's post-match frames in order", async () => {
        const { h, manager } = harness();
        await manager.enable();
        await drain();
        const first = Float32Array.from([0.1, 0.2]);
        const second = Float32Array.from([0.3]);
        h.wake.emitCommandAudio(first);
        h.wake.emitCommandAudio(second, 48000);
        expect(h.commandAudio).toEqual([
            { pcm: first, sampleRate: 16000 },
            { pcm: second, sampleRate: 48000 },
        ]);
    });

    it("drops frames when no callback is wired", async () => {
        const wake = new FakeWake();
        const wakeStt = new FakeStt();
        let snapshot = initialVoiceSnapshot;
        const core: VoiceCore = {
            snapshot: () => snapshot,
            reduce: (event) => {
                snapshot = reduceVoice(snapshot, event);
            },
            vad: null,
            schedule: () => 0,
            unschedule: () => {},
            log: () => {},
            traceTranscript: () => {},
            isDisposed: () => false,
            stopVad: async () => {},
        };
        const manager = new WakeManager(core, {
            wake,
            wakeStt,
            onMatch: () => {},
        });
        await manager.enable();
        await drain();
        expect(() =>
            wake.emitCommandAudio(Float32Array.from([0.5])),
        ).not.toThrow();
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

    it("a match whose session fails to open restarts the detector", async () => {
        // Mirror the controller's failed open: `begin()` pauses the detector
        // for the session, fails, and lands back on `idle`. The manager then
        // treats it as a failed open and restarts the pair.
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

describe("WakeManager dispose", () => {
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

describe("DEFAULT_WAKE_PHRASE", () => {
    it("is the trained phrase", () => {
        expect(DEFAULT_WAKE_PHRASE).toBe("Hey JARVIS");
    });
});
