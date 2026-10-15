/**
 * `BargeWatch` unit tests (issue #110).
 *
 * The extracted watch is driven over a fake {@link VoiceCore} — a scripted
 * VAD (speech events + raw-audio tap), a hand-fired scheduler, and a captured
 * log sink — so its own contract is pinned independently of the controller:
 * arming/disarming, the sustained-speech trigger and one-shot semantics, the
 * look-back ring and its pruning, the start/stop generation interlock (#104,
 * race 3), and every degraded path (no VAD, no client callback, busy/dead
 * VAD, throwing client callback).
 */
import { describe, expect, it } from "vitest";
import {
    BARGE_IN_ARM_ATTEMPTS,
    BARGE_IN_LOOKBACK_MS,
    BARGE_IN_RETRY_MS,
    BARGE_IN_SPEECH_MS,
    BargeWatch,
} from "../src/barge";
import type { BargeInDetection } from "../src/barge";
import type { VoiceCore } from "../src/core";
import { initialVoiceSnapshot } from "../src/lifecycle";
import type { VadCallbacks, VadProvider, VoiceError } from "../src/types";

/** Scripted VAD double with the raw-audio tap; the test drives events. */
class FakeVad implements VadProvider {
    readonly id = "fake-vad";
    startCalls = 0;
    stopCalls = 0;
    /** Parks `start()` (callbacks installed) until `releaseStart()`. */
    deferStart = false;
    /** Refuses this many upcoming `start()` calls (a busy VAD, #114). */
    refuseStart = 0;
    private releaseStartFn: (() => void) | null = null;
    private callbacks: VadCallbacks | null = null;

    async start(callbacks: VadCallbacks): Promise<void> {
        if (this.callbacks !== null) {
            throw { code: "engine", message: "already active" };
        }
        this.startCalls += 1;
        if (this.refuseStart > 0) {
            this.refuseStart -= 1;
            throw { code: "engine", message: "busy" };
        }
        this.callbacks = callbacks;
        if (this.deferStart) {
            await new Promise<void>((resolve) => {
                this.releaseStartFn = resolve;
            });
        }
    }

    releaseStart(): void {
        this.releaseStartFn?.();
        this.releaseStartFn = null;
    }

    async stop(): Promise<void> {
        this.stopCalls += 1;
        this.callbacks = null;
    }

    emitSpeechStart(): void {
        this.callbacks?.onSpeechStart?.();
    }

    emitSpeechEnd(): void {
        this.callbacks?.onSpeechEnd?.();
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

interface Harness {
    vad: FakeVad;
    scheduler: FakeScheduler;
    core: VoiceCore;
    fires: BargeInDetection[];
    feeds: Array<{ pcm: Float32Array; sampleRate: number } | undefined>;
    logged: unknown[];
    /** The message half of every `core.log` call, in order. */
    messages: string[];
    setDisposed(value: boolean): void;
}

function makeHarness(options?: {
    vad?: FakeVad | null;
    onBargeIn?: (detection: BargeInDetection) => void | Promise<void>;
}): Harness {
    const vad = options?.vad === undefined ? new FakeVad() : options.vad;
    const scheduler = makeScheduler();
    const fires: BargeInDetection[] = [];
    const feeds: Array<{ pcm: Float32Array; sampleRate: number } | undefined> =
        [];
    const logged: unknown[] = [];
    const messages: string[] = [];
    const disposed = { value: false };
    const core: VoiceCore = {
        snapshot: () => initialVoiceSnapshot,
        reduce: () => {},
        vad,
        schedule: scheduler.schedule,
        unschedule: scheduler.unschedule,
        log: (message, error) => {
            messages.push(message);
            logged.push(error);
        },
        traceTranscript: () => {},
        isDisposed: () => disposed.value,
        stopVad: async () => {
            await vad?.stop();
        },
    };
    return {
        vad: vad as FakeVad,
        scheduler,
        core,
        fires,
        feeds,
        logged,
        messages,
        setDisposed: (value) => {
            disposed.value = value;
        },
    };
}

/** Builds a watch whose client trigger records into the harness. */
function makeWatch(
    harness: Harness,
    onBargeIn: (detection: BargeInDetection) => void | Promise<void>,
): BargeWatch {
    return new BargeWatch(harness.core, {
        onBargeIn,
        onDetected: (feed) => harness.feeds.push(feed),
    });
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BargeWatch", () => {
    it("arms, fires once on sustained speech, and hands over the ring", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        await watch.start();
        expect(harness.vad.startCalls).toBe(1);
        expect(watch.active).toBe(true);

        harness.vad.emitAudio(new Float32Array(480).fill(0.5), 48000);
        harness.vad.emitAudio(new Float32Array(480).fill(0.5), 48000);
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);

        expect(harness.fires).toHaveLength(1);
        expect(harness.fires[0]!.lookbackSampleRate).toBe(48000);
        expect(harness.fires[0]!.lookback?.length).toBe(960);
        expect(harness.feeds[0]).toEqual({
            pcm: harness.fires[0]!.lookback,
            sampleRate: 48000,
        });
        // One-shot: the watch disarmed itself.
        expect(watch.active).toBe(false);
        expect(harness.vad.stopCalls).toBe(1);
    });

    it("does not fire when speech releases before the deadline", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        await watch.start();
        harness.vad.emitSpeechStart();
        harness.vad.emitSpeechEnd();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.fires).toHaveLength(0);
        // Still armed: a later sustained onset fires normally.
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.fires).toHaveLength(1);
    });

    it("stop cancels a pending trigger and releases the VAD", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        await watch.start();
        harness.vad.emitSpeechStart();
        expect(harness.scheduler.pendingMs()).toContain(BARGE_IN_SPEECH_MS);
        await watch.stop();
        expect(harness.scheduler.pendingMs()).not.toContain(BARGE_IN_SPEECH_MS);
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        expect(harness.fires).toHaveLength(0);
        expect(watch.active).toBe(false);
        expect(harness.vad.stopCalls).toBe(1);
    });

    it("prunes the look-back ring to the window", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        await watch.start();
        // 25 chunks × 100 ms at a 10 kHz analysis rate.
        for (let i = 0; i < 25; i += 1) {
            harness.vad.emitAudio(new Float32Array(1000), 10000);
        }
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        const lookback = harness.fires[0]!.lookback!;
        const ms = (lookback.length / 10000) * 1000;
        expect(ms).toBeGreaterThan(BARGE_IN_LOOKBACK_MS - 200);
        expect(ms).toBeLessThanOrEqual(BARGE_IN_LOOKBACK_MS + 200);
    });

    it("is a silent no-op without a VAD", async () => {
        const harness = makeHarness({ vad: null });
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        await watch.start();
        expect(watch.active).toBe(false);
        expect(harness.vad).toBeNull();
    });

    it("is a silent no-op without a client callback", async () => {
        const harness = makeHarness();
        const watch = new BargeWatch(harness.core, {
            onDetected: (feed) => harness.feeds.push(feed),
        });
        await watch.start();
        expect(harness.vad.startCalls).toBe(0);
        expect(watch.active).toBe(false);
    });

    it("logs when it arms and when it disarms (#114)", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, () => {});
        await watch.start();
        // The state travels with the arm log: #114's question is whether the
        // watch came up before playback (responding) or only at audioStart
        // (speaking).
        expect(harness.messages).toContain("barge-in watch armed (state=idle)");
        await watch.stop();
        expect(harness.messages).toContain("barge-in watch disarmed");
    });

    it("logs a busy VAD and retries rather than staying off for the turn (#114)", async () => {
        const harness = makeHarness();
        // Occupy the VAD (a recognition session owns it).
        await harness.vad.start({
            onSpeechStart: () => {},
            onSpeechEnd: () => {},
        });
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        await watch.start();
        expect(watch.active).toBe(false);
        expect(harness.logged).toHaveLength(1);
        expect(harness.messages[0]).toContain("failed to arm; retrying");
        // The watch still wants the VAD: the re-attempt is armed.
        expect(harness.scheduler.pendingMs()).toContain(BARGE_IN_RETRY_MS);
    });

    it("arms on the re-attempt once the VAD frees up (#114)", async () => {
        const vad = new FakeVad();
        vad.refuseStart = 1;
        const harness = makeHarness({ vad });
        const watch = makeWatch(harness, () => {});

        await watch.start();
        expect(watch.active).toBe(false);
        expect(vad.startCalls).toBe(1);

        harness.scheduler.fireByMs(BARGE_IN_RETRY_MS);
        await settle();

        expect(watch.active).toBe(true);
        expect(vad.startCalls).toBe(2);
    });

    it("a stop cancels a pending re-attempt (#114)", async () => {
        const vad = new FakeVad();
        vad.refuseStart = 9;
        const harness = makeHarness({ vad });
        const watch = makeWatch(harness, () => {});

        await watch.start();
        await watch.stop();
        expect(harness.scheduler.pendingMs()).not.toContain(BARGE_IN_RETRY_MS);

        harness.scheduler.fireByMs(BARGE_IN_RETRY_MS);
        await settle();
        expect(vad.startCalls).toBe(1);
        expect(watch.active).toBe(false);
    });

    it("gives up after the bounded number of attempts (#114)", async () => {
        const vad = new FakeVad();
        vad.refuseStart = 99;
        const harness = makeHarness({ vad });
        const watch = makeWatch(harness, () => {});

        await watch.start();
        for (let i = 0; i < BARGE_IN_ARM_ATTEMPTS + 2; i += 1) {
            harness.scheduler.fireByMs(BARGE_IN_RETRY_MS);
            await settle();
        }

        expect(vad.startCalls).toBe(BARGE_IN_ARM_ATTEMPTS);
        expect(watch.active).toBe(false);
        expect(harness.messages.some((m) => m.includes("giving up"))).toBe(
            true,
        );
    });

    it("a dead VAD disarms quietly", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        await watch.start();
        harness.vad.emitError({ code: "engine", message: "track ended" });
        await settle();
        expect(watch.active).toBe(false);
        expect(harness.vad.stopCalls).toBe(1);
    });

    it("a rejecting client callback is logged and the handoff proceeds", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, () =>
            Promise.reject(new Error("client stop failed")),
        );
        await watch.start();
        harness.vad.emitSpeechStart();
        harness.scheduler.fireByMs(BARGE_IN_SPEECH_MS);
        await settle();
        expect(harness.logged.some((e) => e instanceof Error)).toBe(true);
        expect(harness.feeds).toHaveLength(1);
    });

    it("releases the VAD when a stop supersedes an in-flight arm (#104)", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        harness.vad.deferStart = true;
        const arming = watch.start();
        await Promise.resolve();
        expect(harness.vad.startCalls).toBe(1);
        await watch.stop();
        harness.vad.releaseStart();
        await arming;
        await settle();
        expect(harness.vad.stopCalls).toBe(1);
        expect(watch.active).toBe(false);
    });

    it("releases the VAD when dispose supersedes an in-flight arm (#104)", async () => {
        const harness = makeHarness();
        const watch = makeWatch(harness, (detection) => {
            harness.fires.push(detection);
        });
        harness.vad.deferStart = true;
        const arming = watch.start();
        await Promise.resolve();
        watch.dispose();
        harness.vad.releaseStart();
        await arming;
        await settle();
        expect(harness.vad.stopCalls).toBe(1);
        expect(watch.active).toBe(false);
    });
});
