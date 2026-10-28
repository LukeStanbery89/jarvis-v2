import { describe, expect, it } from "vitest";
import { decodeWav } from "@lukestanbery/jarvis-voice";
import { pcmS16leToWav } from "../src/audio";

describe("pcmS16leToWav", () => {
    it("wraps mono s16le samples in a decodable WAV", () => {
        const pcm = Buffer.alloc(4);
        pcm.writeInt16LE(0, 0);
        pcm.writeInt16LE(16_384, 2);
        const bytes = pcmS16leToWav(pcm, 16_000);
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
        const decoded = decodeWav(bytes);
        expect(decoded.sampleRate).toBe(16_000);
        expect(decoded.pcm).toHaveLength(2);
        expect(decoded.pcm[0]).toBe(0);
        expect(decoded.pcm[1]).toBeCloseTo(0.5, 2);
    });
});
