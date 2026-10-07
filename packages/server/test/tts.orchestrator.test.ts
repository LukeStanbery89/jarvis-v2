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

    async synthesize(
        text: string,
        _options?: SynthesizeOptions,
    ): Promise<SynthesizedSpeech> {
        this.calls.push(text);
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
});
