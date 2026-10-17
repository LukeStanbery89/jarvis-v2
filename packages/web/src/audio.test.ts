/**
 * Audio player tests (#83).
 *
 * A fake AudioContext records scheduled buffer sources so the queueing
 * discipline — back-to-back scheduling, speaking flag, stop/dispose — runs
 * in node without WebAudio.
 */
import { describe, expect, it, vi } from "vitest";
import { AudioPlayer } from "./audio";

/** A recorded oscillator: one tone of a chime, with the frequencies it set. */
interface FakeOscillator {
    type: string;
    tones: number[];
    stopped: boolean;
    startedAt: number | null;
    frequency: { setValueAtTime(value: number, when: number): void };
    connect(): void;
    start(when: number): void;
    stop(when: number): void;
}

/** A recorded buffer source plus its fake context bookkeeping. */
interface FakeSource {
    when: number | null;
    stopped: boolean;
    onended: (() => void) | null;
}

/** Builds a fake AudioContext + handles to drive it. */
function makeFakeContext() {
    const sources: FakeSource[] = [];
    const oscillators: FakeOscillator[] = [];
    const copies: Float32Array[] = [];
    let currentTime = 0;
    let resumed = 0;
    let closed = 0;
    const ctx = {
        get currentTime() {
            return currentTime;
        },
        state: "running",
        dest: {},
        destination: {},
        resume: async () => {
            resumed += 1;
            // A real resume moves the context to `running`; the player's
            // snapshot reads that (#114).
            (ctx as { state: string }).state = "running";
        },
        close: async () => {
            closed += 1;
        },
        createBuffer: (
            _channels: number,
            length: number,
            sampleRate: number,
        ) => ({
            duration: length / sampleRate,
            copyToChannel: (src: Float32Array) => {
                copies.push(src);
            },
        }),
        createOscillator: () => {
            const osc: FakeOscillator = {
                type: "",
                tones: [],
                stopped: false,
                startedAt: null,
                frequency: {
                    setValueAtTime: (value: number) => {
                        osc.tones.push(value);
                    },
                },
                connect: () => {},
                start: (when: number) => {
                    osc.startedAt = when;
                },
                stop: () => {
                    osc.stopped = true;
                },
            };
            oscillators.push(osc);
            return osc;
        },
        createGain: () => ({
            gain: {
                setValueAtTime: () => {},
                exponentialRampToValueAtTime: () => {},
            },
            connect: () => {},
        }),
        createBufferSource: () => {
            // One object serves as both the returned source node and the
            // record — the player assigns `onended` to what it receives,
            // so the test must drive the very same object.
            const source = {
                when: null as number | null,
                stopped: false,
                onended: null as (() => void) | null,
                connect: () => {},
                start: (when: number) => {
                    source.when = when;
                },
                stop: () => {
                    source.stopped = true;
                },
            };
            sources.push(source);
            return source;
        },
    };
    return {
        ctx: ctx as unknown as AudioContext,
        sources,
        oscillators,
        copies,
        advance: (seconds: number) => {
            currentTime += seconds;
        },
        get resumed() {
            return resumed;
        },
        get closed() {
            return closed;
        },
    };
}

describe("AudioPlayer", () => {
    it("queues chunks back-to-back with no gaps", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        // Each chunk: 24_000 samples at 24 kHz = 1 second.
        player.play(new Float32Array(24_000));
        player.play(new Float32Array(24_000));
        player.play(new Float32Array(12_000));
        expect(fake.sources.map((s) => s.when)).toEqual([0, 1, 2]);
    });

    it("schedules after the context clock, not before now", () => {
        const fake = makeFakeContext();
        fake.advance(3.5);
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        player.play(new Float32Array(24_000));
        expect(fake.sources[0]?.when).toBe(3.5);
    });

    it("reports speaking from first play until the last source ends", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        expect(player.getSnapshot()).toBe(false);
        player.play(new Float32Array(24_000));
        player.play(new Float32Array(24_000));
        expect(player.getSnapshot()).toBe(true);
        // First source ends → still speaking (one queued).
        fake.sources[0]?.onended?.();
        expect(player.getSnapshot()).toBe(true);
        fake.sources[1]?.onended?.();
        expect(player.getSnapshot()).toBe(false);
    });

    it("reports not-speaking while the context cannot play (#114)", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        // A suspended context freezes its clock, so the scheduled source never
        // ends and `onended` never fires — without the state check the flag
        // would latch true forever and keep the barge watch armed.
        (fake.ctx as { state: string }).state = "suspended";
        player.play(new Float32Array(24_000));
        expect(player.getSnapshot()).toBe(false);
        // Resuming announces the flip: the audio it warned about is now real.
        const seen: boolean[] = [];
        player.subscribe(() => seen.push(player.getSnapshot()));
        player.unlock();
        return Promise.resolve().then(() => {
            expect(seen).toEqual([true]);
            expect(player.getSnapshot()).toBe(true);
        });
    });

    it("stop() drops the queue immediately", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        player.play(new Float32Array(24_000));
        player.play(new Float32Array(24_000));
        player.stop();
        expect(player.getSnapshot()).toBe(false);
        expect(fake.sources.every((s) => s.stopped)).toBe(true);
        // A play after stop schedules from now again.
        player.play(new Float32Array(24_000));
        expect(fake.sources[2]?.when).toBe(0);
    });

    it("unlock() resumes the context; play() works without it", () => {
        const fake = makeFakeContext();
        // The fake's literal `state` is readonly in the AudioContext type —
        // restate it as a mutable property on the same object.
        const mutable = fake.ctx as { state: string };
        mutable.state = "suspended";
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        player.unlock();
        expect(fake.resumed).toBe(1);
        player.play(new Float32Array(24));
        expect(fake.copies.length).toBe(1);
    });

    it("no-ops silently without a context (no WebAudio runtime)", () => {
        const player = new AudioPlayer({ createContext: () => null });
        expect(() => player.play(new Float32Array(24))).not.toThrow();
        expect(player.getSnapshot()).toBe(false);
    });

    it("ignores empty chunks", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        player.play(new Float32Array(0));
        expect(fake.sources).toEqual([]);
        expect(player.getSnapshot()).toBe(false);
    });

    it("blip() plays a cue without touching the speaking signal", () => {
        const fake = makeFakeContext();
        const oscillators: { stopped: boolean }[] = [];
        const fakeCtx = {
            ...fake.ctx,
            createOscillator: () => {
                const osc = {
                    type: "",
                    stopped: false,
                    frequency: { setValueAtTime: () => {} },
                    connect: () => {
                        oscillators.push(osc);
                    },
                    start: () => {},
                    stop: () => {
                        osc.stopped = true;
                    },
                };
                return osc;
            },
            createGain: () => ({
                gain: {
                    setValueAtTime: () => {},
                    exponentialRampToValueAtTime: () => {},
                },
                connect: () => {},
            }),
        };
        const player = new AudioPlayer({
            createContext: () => fakeCtx as unknown as AudioContext,
        });
        player.blip();
        expect(oscillators.length).toBe(1);
        expect(player.getSnapshot()).toBe(false);
    });

    it("dispose() closes the context", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        player.play(new Float32Array(24));
        player.dispose();
        expect(fake.closed).toBe(1);
        expect(player.getSnapshot()).toBe(false);
    });
});

describe("AudioPlayer: the timer ring (#90)", () => {
    /** Runs `body` with fake timers, restoring real ones even on failure. */
    async function withFakeTimers(
        body: () => void | Promise<void>,
    ): Promise<void> {
        vi.useFakeTimers();
        try {
            await body();
        } finally {
            vi.useRealTimers();
        }
    }

    /** The start instant of every pattern (its first tone is 880 Hz). */
    function patternStarts(fake: ReturnType<typeof makeFakeContext>): number[] {
        return fake.oscillators
            .filter((o) => o.tones[0] === 880)
            .map((o) => o.startedAt ?? 0);
    }

    it("queues the three-tone pattern ahead on the audio clock", () =>
        withFakeTimers(() => {
            const fake = makeFakeContext();
            const player = new AudioPlayer({ createContext: () => fake.ctx });

            player.startRing();

            // One pattern is three tones, sounding immediately: 880 → 660 → 990.
            expect(fake.oscillators.slice(0, 3).map((o) => o.tones[0])).toEqual(
                [880, 660, 990],
            );
            expect(
                fake.oscillators.slice(0, 3).map((o) => o.startedAt),
            ).toEqual([0, 0.18, 0.36]);
            // And the repeats are already queued, not left to a timer that a
            // hidden tab would throttle: two minutes of it, every three
            // seconds, with no gap.
            const starts = patternStarts(fake);
            expect(starts.length).toBeGreaterThan(30);
            expect(
                starts.every(
                    (start, index) =>
                        index === 0 ||
                        Math.abs(start - starts[index - 1] - 3) < 1e-9,
                ),
            ).toBe(true);
        }));

    it("tops the queue up without a gap after a throttled tick", () =>
        withFakeTimers(() => {
            const fake = makeFakeContext();
            const player = new AudioPlayer({ createContext: () => fake.ctx });
            player.startRing();
            const before = patternStarts(fake);

            // A background tab may run this top-up as rarely as once a minute;
            // the audio clock keeps its own time.
            fake.advance(60);
            vi.advanceTimersByTime(60_000);

            const after = patternStarts(fake);
            expect(after.length).toBeGreaterThan(before.length);
            expect(
                after.every(
                    (start, index) =>
                        index === 0 ||
                        Math.abs(start - after[index - 1] - 3) < 1e-9,
                ),
            ).toBe(true);
            expect(Math.max(...after)).toBeGreaterThan(
                Math.max(...before) + 30,
            );
        }));

    it("is idempotent, so a hand-over does not double the alarm", () =>
        withFakeTimers(() => {
            const fake = makeFakeContext();
            const player = new AudioPlayer({ createContext: () => fake.ctx });

            player.startRing();
            const once = fake.oscillators.length;
            player.startRing();

            expect(fake.oscillators).toHaveLength(once);
        }));

    it("stays silent on a suspended context until a gesture resumes it", () =>
        withFakeTimers(async () => {
            const fake = makeFakeContext();
            (fake.ctx as { state: string }).state = "suspended";
            const player = new AudioPlayer({ createContext: () => fake.ctx });

            // A timer can fire before the user has ever interacted, and the
            // browser forbids sound until they do — the overlay still shows.
            player.startRing();
            vi.advanceTimersByTime(60_000);
            expect(fake.oscillators).toHaveLength(0);

            player.unlock();
            // The resume is a promise; the queue is armed when it settles.
            await Promise.resolve();
            expect(fake.oscillators.length).toBeGreaterThan(0);
        }));

    it("does not touch the speaking signal", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });

        player.startRing();

        // A ringing timer is not the assistant speaking: the barge-in watch
        // keys on `speaking`, and arming it from an alarm would let ambient
        // speech open a voice session.
        expect(player.getSnapshot()).toBe(false);
        player.stopRing();
    });

    it("stop() silences every tone already queued ahead", () =>
        withFakeTimers(() => {
            const fake = makeFakeContext();
            const player = new AudioPlayer({ createContext: () => fake.ctx });
            player.startRing();

            player.stopRing();
            const queued = fake.oscillators.length;

            expect(fake.oscillators.every((o) => o.stopped)).toBe(true);
            vi.advanceTimersByTime(120_000);
            expect(fake.oscillators).toHaveLength(queued);
        }));

    it("dispose() stops the ring with the context", () =>
        withFakeTimers(() => {
            const fake = makeFakeContext();
            const player = new AudioPlayer({ createContext: () => fake.ctx });

            player.startRing();
            const queued = fake.oscillators.length;
            player.dispose();
            vi.advanceTimersByTime(120_000);

            expect(fake.oscillators).toHaveLength(queued);
            expect(fake.oscillators.every((o) => o.stopped)).toBe(true);
            expect(fake.closed).toBe(1);
        }));

    it("rings safely without a WebAudio runtime", () => {
        const player = new AudioPlayer({ createContext: () => null });

        expect(() => {
            player.startRing();
            player.stopRing();
        }).not.toThrow();
    });
});
