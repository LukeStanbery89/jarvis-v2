/**
 * Audio player tests (#83).
 *
 * A fake AudioContext records scheduled buffer sources so the queueing
 * discipline — back-to-back scheduling, speaking flag, stop/dispose — runs
 * in node without WebAudio.
 */
import { describe, expect, it } from "vitest";
import { AudioPlayer } from "./audio";

/** A recorded buffer source plus its fake context bookkeeping. */
interface FakeSource {
    when: number | null;
    stopped: boolean;
    onended: (() => void) | null;
}

/** Builds a fake AudioContext + handles to drive it. */
function makeFakeContext() {
    const sources: FakeSource[] = [];
    const copies: Float32Array[] = [];
    let currentTime = 0;
    let resumed = 0;
    let closed = 0;
    const ctx = {
        get currentTime() {
            return currentTime;
        },
        state: "running",
        destination: {},
        resume: async () => {
            resumed += 1;
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

    it("dispose() closes the context", () => {
        const fake = makeFakeContext();
        const player = new AudioPlayer({ createContext: () => fake.ctx });
        player.play(new Float32Array(24));
        player.dispose();
        expect(fake.closed).toBe(1);
        expect(player.getSnapshot()).toBe(false);
    });
});
