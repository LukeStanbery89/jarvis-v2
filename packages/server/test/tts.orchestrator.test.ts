/**
 * Audio orchestrator tests (issue #83, phase 3 milestone slice).
 *
 * A scripted TtsProvider with controllable synthesis promises drives the
 * ordering guarantees: sequential workers, in-order delivery, lazy
 * audioStart, exactly-one audioEnd, quiet failure, and abort. Synthesis
 * resolvers register as the pump advances, so tests settle one segment at
 * a time, letting microtasks run between settles.
 */
import { describe, expect, it } from "vitest";
import { speakTurn, type AudioTurnSink } from "../src/tts/orchestrator";
import type {
    SynthesizeOptions,
    SynthesizedSpeech,
    TtsProvider,
} from "../src/tts/types";

/** A provider whose synth calls are hand-settled, one at a time. */
class ScriptedProvider implements TtsProvider {
    readonly id = "scripted";
    readonly calls: string[] = [];
    /** Settles the oldest pending synth with PCM of the given length. */
    readonly resolvers: Array<(s: SynthesizedSpeech) => void> = [];
    /** Makes the next synth call fail. */
    failNext: Error | null = null;
    /** The signal each synth call received, in call order. */
    readonly seenSignals: (AbortSignal | undefined)[] = [];

    async synthesize(
        text: string,
        options?: SynthesizeOptions,
    ): Promise<SynthesizedSpeech> {
        this.calls.push(text);
        this.seenSignals.push(options?.signal);
        if (this.failNext !== null) {
            const err = this.failNext;
            this.failNext = null;
            throw err;
        }
        return new Promise<SynthesizedSpeech>((resolve) => {
            this.resolvers.push(resolve);
        });
    }

    /** Settles the oldest pending synthesis. */
    settle(chars = 10): void {
        this.resolvers.shift()?.({
            pcm: new Float32Array(chars),
            sampleRate: 24_000,
        });
    }
}

/**
 * A provider that mimics Kokoro's cooperative checkpoints: its pending
 * synthesis rejects the moment the call's signal aborts (and never resolves
 * otherwise — the engine work is what resolves a real provider).
 */
class AbortableProvider implements TtsProvider {
    readonly id = "abortable";

    async synthesize(
        _text: string,
        options?: SynthesizeOptions,
    ): Promise<SynthesizedSpeech> {
        const signal = options?.signal;
        if (!signal) {
            return { pcm: new Float32Array(4), sampleRate: 24_000 };
        }
        return new Promise<SynthesizedSpeech>((_resolve, reject) => {
            if (signal.aborted) {
                reject(new Error("aborted"));
                return;
            }
            signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                {
                    once: true,
                },
            );
        });
    }
}

/** Recording sink. */
function makeSink() {
    const events: string[] = [];
    const sink: AudioTurnSink = {
        audioStart: (sampleRate) => events.push(`start:${sampleRate}`),
        audio: (pcm) => events.push(`pcm:${pcm.length}`),
        audioEnd: () => events.push("end"),
    };
    return { events, sink };
}

/** Lets every pending microtask (any chain depth) run to exhaustion. */
async function pumpTicks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("speakTurn", () => {
    it("speaks completed sentences in order, audioStart once, audioEnd last", async () => {
        const provider = new ScriptedProvider();
        const { events, sink } = makeSink();
        const turn = speakTurn(provider, sink);

        turn.push("First sentence. ");
        turn.push("Second");
        turn.push(" sentence. tail");
        const finished = turn.finish();

        provider.settle(1);
        await pumpTicks();
        provider.settle(2);
        await pumpTicks();
        provider.settle(3);
        await finished;

        expect(provider.calls).toEqual([
            "First sentence.",
            "Second sentence.",
            "tail",
        ]);
        expect(events).toEqual([
            "start:24000",
            "pcm:1",
            "pcm:2",
            "pcm:3",
            "end",
        ]);
    });

    it("emits no audio callbacks for a turn with no speakable text", async () => {
        const provider = new ScriptedProvider();
        const { events, sink } = makeSink();
        const turn = speakTurn(provider, sink);
        turn.push("   \n  ");
        await turn.finish();
        expect(provider.calls).toEqual([]);
        expect(events).toEqual([]);
    });

    it("does not send audioEnd until finish drains the queue", async () => {
        const provider = new ScriptedProvider();
        const { events, sink } = makeSink();
        const turn = speakTurn(provider, sink);
        turn.push("One. Two.");
        // Only "One." is queued — the second terminator is still pending in
        // the segmenter, so settle(2) is a no-op until finish() flushes it.
        provider.settle(1);
        await pumpTicks();
        expect(events).toEqual(["start:24000", "pcm:1"]);
        const finished = turn.finish();
        provider.settle(2);
        await finished;
        expect(events).toEqual(["start:24000", "pcm:1", "pcm:2", "end"]);
    });

    it("fails quietly: onError once, no further audio, no audioEnd", async () => {
        const provider = new ScriptedProvider();
        const { events, sink } = makeSink();
        const failures: unknown[] = [];
        const turn = speakTurn(provider, sink, (err) => failures.push(err));

        turn.push("One. Two. Three.");
        const boom = new Error("engine exploded");
        provider.failNext = boom;
        provider.settle(1); // first segment OK
        await pumpTicks();
        // The second synth failed; the third is never attempted.
        expect(provider.calls).toEqual(["One.", "Two."]);
        expect(failures).toEqual([boom]);
        expect(events).toEqual(["start:24000", "pcm:1"]);
        await turn.finish();
        expect(events).toEqual(["start:24000", "pcm:1"]);
    });

    it("abort() drops the queue; only the in-flight synth is spent", async () => {
        const provider = new ScriptedProvider();
        const { events, sink } = makeSink();
        const turn = speakTurn(provider, sink);
        turn.push("One. Two. Three.");
        turn.abort();
        await turn.finish();
        // "One." entered the engine before the abort; its result is
        // discarded — the sink sees nothing.
        expect(provider.calls).toEqual(["One."]);
        expect(events).toEqual([]);
    });

    it("threads the turn's signal into every synthesize call", async () => {
        const provider = new ScriptedProvider();
        const { sink } = makeSink();
        const turn = speakTurn(provider, sink);
        turn.push("One. Two. Three.");
        provider.settle();
        await pumpTicks();
        expect(provider.seenSignals.length).toBeGreaterThan(0);
        for (const signal of provider.seenSignals) {
            expect(signal).toBeInstanceOf(AbortSignal);
        }
        // abort() fires the shared signal the calls already carry.
        const signal = provider.seenSignals[0]!;
        expect(signal.aborted).toBe(false);
        turn.abort();
        expect(signal.aborted).toBe(true);
    });

    it("an aborted in-flight synthesis reports no second failure", async () => {
        // The abort path: abort() drops the queue AND fires the signal, so
        // the engine's cooperative checkpoint rejects the in-flight call —
        // `failed` is already true, so that rejection must not surface as a
        // second onError (it is the cancellation, not a failure).
        const provider = new AbortableProvider();
        const { events, sink } = makeSink();
        const failures: unknown[] = [];
        const turn = speakTurn(provider, sink, (err) => failures.push(err));
        turn.push("One. Two. Three.");
        // One synth is in flight (pending forever until aborted).
        await pumpTicks();
        turn.abort();
        await turn.finish();
        await pumpTicks();
        expect(failures).toEqual([]);
        expect(events).toEqual([]);
    });
});

describe("granularity and onFirstSegment (#89)", () => {
    it("passes clause granularity through to the segmenter", async () => {
        const provider = new ScriptedProvider();
        const { events, sink } = makeSink();
        const turn = speakTurn(provider, sink, undefined, {
            granularity: "clause",
        });

        turn.push(
            "The weather in Paris right now is quite pleasant, with sunshine and a gentle breeze through the afternoon.",
        );
        const finished = turn.finish();

        provider.settle(48);
        await pumpTicks();
        provider.settle(56);
        await finished;

        expect(provider.calls).toEqual([
            "The weather in Paris right now is quite pleasant,",
            "with sunshine and a gentle breeze through the afternoon.",
        ]);
        expect(events[0]).toBe("start:24000");
        expect(events[events.length - 1]).toBe("end");
    });

    it("sentence granularity stays the default (commas do not split)", async () => {
        const provider = new ScriptedProvider();
        const { sink } = makeSink();
        const turn = speakTurn(provider, sink);
        turn.push(
            "The weather in Paris right now is quite pleasant, with sunshine and a gentle breeze through the afternoon.",
        );
        const finished = turn.finish();
        provider.settle(104);
        await pumpTicks();
        await finished;
        expect(provider.calls).toEqual([
            "The weather in Paris right now is quite pleasant, with sunshine and a gentle breeze through the afternoon.",
        ]);
    });

    it("fires onFirstSegment exactly once, when the first segment is queued", async () => {
        const provider = new ScriptedProvider();
        const { sink } = makeSink();
        const seen: number[] = [];
        const turn = speakTurn(provider, sink, undefined, {
            onFirstSegment: () => seen.push(1),
        });

        turn.push("First sentence. ");
        turn.push("Second sentence. ");
        turn.push("Third sentence.");
        const finished = turn.finish();
        provider.settle();
        await pumpTicks();
        provider.settle();
        await pumpTicks();
        provider.settle();
        await pumpTicks();
        await finished;

        expect(seen).toEqual([1]);
    });

    it("never fires onFirstSegment for a turn with no speakable text", async () => {
        const provider = new ScriptedProvider();
        const { sink } = makeSink();
        const seen: number[] = [];
        const turn = speakTurn(provider, sink, undefined, {
            onFirstSegment: () => seen.push(1),
        });
        turn.push("   ");
        await turn.finish();
        expect(seen).toEqual([]);
    });
});
