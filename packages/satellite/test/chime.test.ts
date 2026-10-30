import { describe, expect, it } from "vitest";
import { CHIME_SAMPLE_RATE, createChime } from "../src/chime";

describe("createChime", () => {
    it("generates mono s16le PCM at the chime rate", () => {
        const chime = createChime("wake");
        expect(chime.sampleRate).toBe(CHIME_SAMPLE_RATE);
        expect(chime.pcm.length).toBeGreaterThan(0);
        expect(chime.pcm.length % 2).toBe(0);
    });

    it("has distinct wake and completion cues", () => {
        expect(
            createChime("wake").pcm.equals(createChime("complete").pcm),
        ).toBe(false);
    });

    it("keeps every sample inside the s16 range", () => {
        for (const kind of ["wake", "complete"] as const) {
            const chime = createChime(kind);
            for (let i = 0; i < chime.pcm.length; i += 2) {
                const sample = chime.pcm.readInt16LE(i);
                expect(sample).toBeGreaterThanOrEqual(-32768);
                expect(sample).toBeLessThanOrEqual(32767);
            }
        }
    });
});
