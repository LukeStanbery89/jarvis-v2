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
import {
    END_OF_SPEECH_MS,
    MAX_COMMAND_MS,
    NO_SPEECH_MS,
    VoiceSession,
} from "../src/session";
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
    /** Every `feed()` chunk, in order (#121). */
    fed: Array<{ pcm: Float32Array; sampleRate: number }> = [];
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

interface Harness {
    stt: FakeStt;
    core: VoiceCore;
    /** Submissions recorded, in order. */
    submitted: string[];
    /** Debug log messages emitted, in order. */
    logs: string[];
    /** Raw-vs-submitted traces recorded, in order (#121). */
    traces: Array<{ raw: string; submitted: string }>;
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
    external?: { sampleRate: number };
}): Built {
    const stt = new FakeStt();
    const submitted: string[] = [];
    const logs: string[] = [];
    const traces: Array<{ raw: string; submitted: string }> = [];
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
        log: (message) => {
            logs.push(message);
        },
        traceTranscript: (raw, submittedText) => {
            traces.push({ raw, submitted: submittedText });
        },
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
        ...(options?.external !== undefined
            ? { external: options.external }
            : {}),
    });
    const h: Harness = {
        stt,
        core,
        submitted,
        logs,
        traces,
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

/** Rounds a sample to the precision `Float32Array` round-trips readably at. */
function round3(value: number): number {
    return Number(value.toFixed(3));
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
        // A dropped utterance is otherwise invisible: no status, no error
        // banner, and (after a barge-in) no other trace (#114).
        expect(h.logs.some((m) => m.includes("nothing recognized"))).toBe(true);
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

    it("traces the raw transcript against the stripped submission (#121)", async () => {
        // Lesson 6: "what was heard" vs "what was sent" must be recoverable
        // from the seam, so a mangled phrase is diagnosable without a repro.
        const { h, session } = harness({ fromWake: true });
        await session.start(null);
        h.stt.emitResult("hey jarvis how's the weather");
        await drain();
        expect(h.traces).toEqual([
            {
                raw: "hey jarvis how's the weather",
                submitted: "how's the weather",
            },
        ]);
    });

    it("traces the accumulated segments in a VAD-owned wake session (#121)", async () => {
        const { h, session } = harness({ fromWake: true });
        session.setVadOwned(true);
        await session.start(null);
        h.stt.emitResult("Hey JARVIS");
        h.stt.emitResult("turn on the lights");
        await session.finish();
        await drain();
        expect(h.submitted).toEqual(["turn on the lights"]);
        expect(h.traces).toEqual([
            {
                raw: "Hey JARVIS turn on the lights",
                submitted: "turn on the lights",
            },
        ]);
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

describe("VoiceSession external (wake) capture (#121)", () => {
    it("opens microphone-free at the detector's rate", async () => {
        const { h, session } = harness({ external: { sampleRate: 16000 } });
        await session.start(null);
        expect(h.stt.lastOptions).toEqual({
            source: "external",
            sampleRate: 16000,
        });
    });

    it("holds command frames until the engine is running, in order", async () => {
        const { h, session } = harness({ external: { sampleRate: 16000 } });
        // The engine is mid-open (cold model load) when the detector's first
        // frames land: they must survive, because the command's opening is in
        // them (#121).
        h.stt.state = "starting";
        session.pushCommandAudio(Float32Array.from([0.1]), 16000);
        session.pushCommandAudio(Float32Array.from([0.2]), 16000);
        session.pushCommandAudio(Float32Array.from([0.3]), 16000);
        expect(h.stt.fed).toEqual([]);
        h.stt.state = "idle";
        await session.start(null);
        expect(
            h.stt.fed.map((chunk) => Array.from(chunk.pcm).map(round3)),
        ).toEqual([[0.1], [0.2], [0.3]]);
    });

    it("feeds frames straight through once running", async () => {
        const { h, session } = harness({ external: { sampleRate: 16000 } });
        await session.start(null);
        session.pushCommandAudio(Float32Array.from([0.4]), 16000);
        expect(
            h.stt.fed.map((chunk) => Array.from(chunk.pcm).map(round3)),
        ).toEqual([[0.4]]);
    });

    it("drops frames once the session is no longer listening", async () => {
        const { h, session } = harness({
            external: { sampleRate: 16000 },
            fromWake: true,
        });
        await session.start(null);
        session.pushCommandAudio(Float32Array.from([0.5]), 16000);
        h.stt.emitResult("what time is it");
        await drain();
        session.pushCommandAudio(Float32Array.from([0.6]), 16000);
        expect(h.stt.fed).toHaveLength(1);
    });

    it("ignores a frame on a non-external session", async () => {
        const { h, session } = harness();
        await session.start(null);
        session.pushCommandAudio(Float32Array.from([0.7]), 16000);
        expect(h.stt.fed).toEqual([]);
    });

    it("submits the engine's final on its own silence detection", async () => {
        const { h, session } = harness({
            external: { sampleRate: 16000 },
            fromWake: true,
        });
        await session.start(null);
        // Two guards are armed: the silence guard and the command bound.
        expect(h.pendingTimerCount()).toBe(2);
        h.stt.emitResult("hey jarvis what time is it");
        await drain();
        expect(h.submitted).toEqual(["what time is it"]);
        expect(h.pendingTimerCount()).toBe(0);
    });

    it("ignores an empty final, so a leading pause cannot end the command", async () => {
        const { h, session } = harness({ external: { sampleRate: 16000 } });
        await session.start(null);
        h.stt.emitResult("");
        await drain();
        expect(h.snapshot().state).toBe("listening");
        expect(h.submitted).toEqual([]);
        expect(h.stt.cancelCalls).toBe(0);
        // The guards are still armed: the command may yet follow the pause.
        expect(h.pendingTimerCount()).toBe(2);
    });

    it("ends quietly when the phrase heard nothing", async () => {
        const { h, session } = harness({ external: { sampleRate: 16000 } });
        await session.start(null);
        h.fireTimer(NO_SPEECH_MS);
        await drain();
        expect(h.snapshot().state).toBe("idle");
        expect(h.snapshot().error).toBeNull();
        expect(h.stt.cancelCalls).toBe(1);
        expect(h.submitted).toEqual([]);
    });

    it("flushes what was heard when the command bound elapses", async () => {
        const { h, session } = harness({ external: { sampleRate: 16000 } });
        await session.start(null);
        h.stt.emitPartial("tell me about abraham lincoln");
        h.stt.resultOnStop = "tell me about abraham lincoln";
        h.fireTimer(MAX_COMMAND_MS);
        await drain();
        expect(h.stt.stopCalls).toBe(1);
        expect(h.submitted).toEqual(["tell me about abraham lincoln"]);
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
