import { describe, expect, it } from "vitest";
import { SpeechSegmenter } from "../src/vad";

const FRAME_MS = 20;
const SAMPLE_RATE = 1_000;

/** Builds one fixed-size frame of the given int16 amplitude. */
function frame(amplitude: number): Int16Array {
    return new Int16Array(Math.round((SAMPLE_RATE * FRAME_MS) / 1000)).fill(
        amplitude,
    );
}

/** Feeds frames in one chunk, as the capture process would. */
function feed(
    segmenter: SpeechSegmenter,
    frames: readonly Int16Array[],
): Float32Array[] {
    const total = frames.reduce((sum, value) => sum + value.length, 0);
    const samples = new Int16Array(total);
    let offset = 0;
    for (const value of frames) {
        samples.set(value, offset);
        offset += value.length;
    }
    return segmenter.feed(samples);
}

/** A segmenter with short windows so tests stay readable. */
function segmenter(): SpeechSegmenter {
    return new SpeechSegmenter({
        threshold: 0.01,
        frameMs: FRAME_MS,
        sampleRate: SAMPLE_RATE,
        onsetMs: 40,
        silenceMs: 40,
        preRollMs: 200,
        maxUtteranceMs: 1_000,
    });
}

describe("SpeechSegmenter", () => {
    it("keeps the pre-roll and the first speech frame", () => {
        const sut = segmenter();
        const silence = frame(0);
        const speech = frame(1_000);

        const completed = feed(sut, [
            silence,
            silence,
            silence,
            silence,
            silence,
            speech,
            speech,
            silence,
            silence,
            silence,
        ]);

        expect(completed).toHaveLength(1);
        const utterance = completed[0]!;
        // 5 pre-roll frames + 2 speech frames + 2 trailing silence frames.
        expect(utterance).toHaveLength(9 * silence.length);
        expect(utterance[0]).toBe(0);
        expect(utterance[5 * silence.length]!).toBeCloseTo(1_000 / 32_768, 5);
    });

    it("emits separate utterances and drops pure silence", () => {
        const sut = segmenter();
        const silence = frame(0);
        const speech = frame(1_000);

        expect(feed(sut, [silence, silence])).toHaveLength(0);
        const first = feed(sut, [speech, speech, silence, silence]);
        expect(first).toHaveLength(1);
        const second = feed(sut, [silence, speech, speech, silence, silence]);
        expect(second).toHaveLength(1);
        expect(second[0]!.length).toBeGreaterThan(0);
    });

    it("caps one utterance at maxUtteranceMs", () => {
        const sut = new SpeechSegmenter({
            threshold: 0.01,
            frameMs: FRAME_MS,
            sampleRate: SAMPLE_RATE,
            onsetMs: 20,
            silenceMs: 1_000,
            preRollMs: 0,
            maxUtteranceMs: 200,
        });
        const speech = frame(1_000);
        const completed = feed(
            sut,
            Array.from({ length: 10 }, () => speech),
        );

        expect(completed).toHaveLength(1);
        expect(completed[0]!.length).toBe(10 * speech.length);
    });

    it("notifies once when speech onset is confirmed", () => {
        let starts = 0;
        const sut = new SpeechSegmenter({
            threshold: 0.01,
            frameMs: FRAME_MS,
            sampleRate: SAMPLE_RATE,
            onsetMs: 40,
            silenceMs: 40,
            preRollMs: 200,
            maxUtteranceMs: 1_000,
            onSpeechStart: () => {
                starts += 1;
            },
        });
        const silence = frame(0);
        const speech = frame(1_000);
        feed(sut, [silence, silence, speech, speech, silence, silence]);
        expect(starts).toBe(1);
    });

    it("ignores quiet input", () => {
        const sut = segmenter();
        const quiet = frame(100);
        expect(
            feed(
                sut,
                Array.from({ length: 20 }, () => quiet),
            ),
        ).toHaveLength(0);
    });
});
