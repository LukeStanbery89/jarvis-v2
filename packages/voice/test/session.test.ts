/**
 * `VoiceSession` unit tests (issue #110).
 *
 * The extracted session is driven over a fake {@link VoiceCore} — a scripted
 * STT engine, a controllable timer queue, and a real `reduceVoice`-backed
 * reducer — so its own contract is pinned independently of the controller:
 * VAD-owned vs engine-native endpointing, the pause-window flush, transcript
 * accumulation and wake-phrase stripping, the quiet no-speech path, the
 * manual stop, and the failure/staleness guards.
 */
import { describe, expect, it } from "vitest";
import type { VoiceCore } from "../src/core";
import { initialVoiceSnapshot, reduceVoice } from "../src/lifecycle";
import type { VoiceSnapshot } from "../src/lifecycle";
import { END_OF_SPEECH_MS, NO_SPEECH_MS, VoiceSession } from "../src/session";
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    SttState,
    VoiceError,
} from "../src/types";

/** Scripted STT engine; the test fires callbacks and inspects call counts. */
class FakeStt implements SttProvider {
    readonly id = "fake-stt";
    state: SttState = "idle";
    startCalls = 0;
    stopCalls = 0;
    cancelCalls = 0;
    lastOptions: SttStartOptions | undefined;
    /** Rejects the next `start()` when set. */
    startError: VoiceError | null = null;
    /** Delivered as a final result when `stop()` flushes (engine vendors do). */
    resultOnStop: string | null = null;
    /** Makes `stop()` never resolve, simulating a wedged engine. */
    hangOnStop = false;
    private callbacks: SttCallbacks | null = null;

    async start(
        callbacks: SttCallbacks,
        options?: SttStartOptions,
    ): Promise<void> {
        this.startCalls += 1;
        this.lastOptions = options;
        if (this.startError !== null) {
            this.state = "idle";
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
        if (this.hangOnStop) {
            return new Promise<void>(() => {});
        }
    }

    async cancel(): Promise<void> {
        this.cancelCalls += 1;
        this.state = "idle";
        this.callbacks = null;
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

interface Harness {
    stt: FakeStt;
    core: VoiceCore;
    /** Submissions recorded, in order. */
    submitted: string[];
    /** Reject the next submission when set. */
    rejectNext: { value: boolean };
    snapshot(): VoiceSnapshot;
    setSnapshot(next: VoiceSnapshot): void;
    stopVadCalls(): number;
    /** Fires the pending timer armed for `ms`, if any. */
    fireTimer(ms: number): void;
    pendingTimerCount(): number;
}

interface Built {
    h: Harness;
    session: VoiceSession;
}

/**
 * Builds a session over a fake `VoiceCore`. The reducer opens on an active
 * session (so `sessionId` matches) unless `idle` is set.
 */
function harness(options?: {
    fromWake?: boolean;
    wakePhrase?: string;
    vadOwned?: boolean;
    submit?: (text: string) => Promise<void>;
    idle?: boolean;
}): Built {
    const stt = new FakeStt();
    const submitted: string[] = [];
    const rejectNext = { value: false };
    let stopVadCalls = 0;
    let snapshot = options?.idle
        ? initialVoiceSnapshot
        : reduceVoice(initialVoiceSnapshot, { type: "activate" });
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let nextHandle = 1;
    const core: VoiceCore = {
        snapshot: () => snapshot,
        reduce: (event) => {
            snapshot = reduceVoice(snapshot, event);
        },
        vad: null,
        schedule: (callback, ms) => {
            const handle = nextHandle;
            nextHandle += 1;
            timers.set(handle, { callback, ms });
            return handle;
        },
        unschedule: (handle) => {
            timers.delete(handle as number);
        },
        log: () => {},
        isDisposed: () => false,
        stopVad: async () => {
            stopVadCalls += 1;
        },
    };
    const submit =
        options?.submit ??
        (async (text: string) => {
            if (rejectNext.value) {
                rejectNext.value = false;
                throw new Error("busy");
            }
            submitted.push(text);
        });
    const session = new VoiceSession(core, {
        sessionId: snapshot.sessionId,
        engine: stt,
        fromWake: options?.fromWake ?? false,
        wakePhrase: options?.wakePhrase ?? "Hey JARVIS",
        submit,
    });
    const h: Harness = {
        stt,
        core,
        submitted,
        rejectNext,
        snapshot: () => snapshot,
        setSnapshot: (next) => {
            snapshot = next;
        },
        stopVadCalls: () => stopVadCalls,
        fireTimer: (ms) => {
            for (const [handle, timer] of timers) {
                if (timer.ms === ms) {
                    timers.delete(handle);
                    timer.callback();
                    return;
                }
            }
            throw new Error(`no pending timer for ${ms}ms`);
        },
        pendingTimerCount: () => timers.size,
    };
    return { h, session };
}

/** Lets queued microtasks/promises settle. */
async function drain(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
    }
}

describe("VoiceSession VAD-owned endpointing", () => {
    it("opens continuous capture with the replayed audio", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        const pcm = Float32Array.from([0.1, 0.2]);
        await session.start({ pcm, sampleRate: 16000 });
        expect(h.stt.startCalls).toBe(1);
        expect(h.stt.lastOptions).toEqual({
            continuous: true,
            feed: { pcm, sampleRate: 16000 },
        });
    });

    it("opens engine-native capture without options when no VAD owns it", async () => {
        const { h, session } = harness();
        await session.start(null);
        expect(h.stt.lastOptions).toBeUndefined();
    });

    it("arms the no-speech guard on start and cancels it on speech start", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        expect(h.pendingTimerCount()).toBe(1);
        session.vadCallbacks().onSpeechStart?.();
        expect(h.pendingTimerCount()).toBe(0);
    });

    it("speech end arms the pause window; expiry flushes and submits the final", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        session.vadCallbacks().onSpeechStart?.();
        session.vadCallbacks().onSpeechEnd?.();
        // The engine delivers its flush final while `stop()` settles.
        h.stt.resultOnStop = "turn on the lights";
        h.fireTimer(END_OF_SPEECH_MS);
        await drain();
        expect(h.stt.stopCalls).toBe(1);
        expect(h.submitted).toEqual(["turn on the lights"]);
        expect(h.snapshot().state).toBe("idle");
    });

    it("resuming speech inside the window cancels the pause window", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        session.vadCallbacks().onSpeechStart?.();
        session.vadCallbacks().onSpeechEnd?.();
        const before = h.pendingTimerCount();
        session.vadCallbacks().onSpeechStart?.();
        expect(h.pendingTimerCount()).toBe(before - 1);
    });

    it("accumulates continuous final segments for display, then submits them", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        session.vadCallbacks().onSpeechStart?.();
        h.stt.emitResult("hello");
        expect(h.snapshot().partial).toBe("hello");
        h.stt.emitResult("world");
        expect(h.snapshot().partial).toBe("hello world");
        h.stt.resultOnStop = "again";
        session.vadCallbacks().onSpeechEnd?.();
        h.fireTimer(END_OF_SPEECH_MS);
        await drain();
        expect(h.submitted).toEqual(["hello world again"]);
    });

    it("a flush that recognizes nothing ends the session quietly", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        session.vadCallbacks().onSpeechStart?.();
        session.vadCallbacks().onSpeechEnd?.();
        h.fireTimer(END_OF_SPEECH_MS);
        await drain();
        expect(h.snapshot().state).toBe("idle");
        expect(h.snapshot().error).toBeNull();
        expect(h.stt.cancelCalls).toBe(1);
    });
});

describe("VoiceSession engine-native endpointing", () => {
    it("submits the engine's final transcript", async () => {
        const { h, session } = harness();
        await session.start(null);
        h.stt.emitResult("good morning");
        await drain();
        expect(h.submitted).toEqual(["good morning"]);
    });

    it("strips the wake phrase from a wake session's final", async () => {
        const { h, session } = harness({ fromWake: true });
        await session.start(null);
        h.stt.emitResult("hey jarvis good morning");
        await drain();
        expect(h.submitted).toEqual(["good morning"]);
    });

    it("manual finish stops the engine and flushes its final", async () => {
        const { h, session } = harness();
        await session.start(null);
        await session.finish();
        expect(h.stt.stopCalls).toBe(1);
    });

    it("a submit rejection lands the session on rejected", async () => {
        const { h, session } = harness();
        await session.start(null);
        h.rejectNext.value = true;
        h.stt.emitResult("hello");
        await drain();
        expect(h.snapshot().state).toBe("idle");
        expect(h.snapshot().error).toMatchObject({ code: "rejected" });
    });
});

describe("VoiceSession failure + staleness guards", () => {
    it("an engine error ends the session with the error", async () => {
        const { h, session } = harness();
        await session.start(null);
        h.stt.emitError({ code: "engine", message: "boom" });
        expect(h.snapshot().state).toBe("idle");
        expect(h.snapshot().error).toMatchObject({ message: "boom" });
    });

    it("a VAD error cancels the engine and ends the session", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        session.vadCallbacks().onError?.({ code: "engine", message: "track" });
        await drain();
        expect(h.stt.cancelCalls).toBe(1);
        expect(h.snapshot().error).toMatchObject({ message: "track" });
    });

    it("a start failure records the error and stops the VAD", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        h.stt.startError = { code: "engine", message: "no model" };
        await session.start(null);
        expect(h.snapshot().error).toMatchObject({ message: "no model" });
        expect(h.stopVadCalls()).toBeGreaterThanOrEqual(1);
    });

    it("events from a stale session id are ignored", async () => {
        const { h, session } = harness();
        await session.start(null);
        // A newer session supersedes this one.
        h.setSnapshot({
            ...h.snapshot(),
            sessionId: h.snapshot().sessionId + 1,
        });
        h.stt.emitResult("stale");
        await drain();
        expect(h.submitted).toEqual([]);
    });

    it("defers an end-of-speech that arrives while the engine is starting", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        // The engine is mid-open (cold model load) when speech ends.
        h.stt.state = "starting";
        session.vadCallbacks().onSpeechEnd?.();
        expect(h.pendingTimerCount()).toBe(0);
        // The engine finishes opening; the deferred pause window arms now.
        h.stt.state = "idle";
        await session.start(null);
        expect(h.pendingTimerCount()).toBe(1);
    });

    it("dispose clears pending timers", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        expect(h.pendingTimerCount()).toBe(1);
        session.dispose();
        expect(h.pendingTimerCount()).toBe(0);
    });
});

describe("VoiceSession no-speech deadline", () => {
    it("fires quietly when pressed with no speech", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        h.fireTimer(NO_SPEECH_MS);
        await drain();
        expect(h.snapshot().state).toBe("idle");
        expect(h.snapshot().error).toBeNull();
        expect(h.stt.cancelCalls).toBe(1);
    });

    it("submits what was heard when the flush deadline finds accumulated finals", async () => {
        const { h, session } = harness();
        session.setVadOwned(true);
        await session.start(null);
        session.vadCallbacks().onSpeechStart?.();
        h.stt.emitResult("partial words");
        // The engine wedges on flush and never delivers a final.
        h.stt.hangOnStop = true;
        session.vadCallbacks().onSpeechEnd?.();
        h.fireTimer(END_OF_SPEECH_MS);
        await drain();
        // The silence guard fires and submits the segments already heard.
        h.fireTimer(NO_SPEECH_MS);
        await drain();
        expect(h.submitted).toEqual(["partial words"]);
    });
});
