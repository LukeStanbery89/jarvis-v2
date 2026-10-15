/**
 * WAV codec tests (issue #121).
 *
 * The codec is the corpus's transport, so these tests pin the two properties
 * the replay harness depends on: a round trip is lossless to 16-bit
 * quantization, and real-world header variations (extra chunks, multi-channel
 * input, float samples) decode rather than silently producing garbage.
 */
import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "../src/index";

/**
 * Builds a WAV byte string with an arbitrary `fmt ` format/channel layout and
 * a raw sample payload, so a test can speak shapes `encodeWav` never emits.
 *
 * @param opts - Format fields and the raw data-chunk bytes.
 * @returns The assembled WAV bytes.
 */
function buildWav(opts: {
    format: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    data: Uint8Array;
    extraChunk?: { id: string; body: Uint8Array };
    extensibleFormat?: number;
}): Uint8Array {
    const fmtBody = new Uint8Array(16);
    const fmtView = new DataView(fmtBody.buffer);
    fmtView.setUint16(0, opts.format, true);
    fmtView.setUint16(2, opts.channels, true);
    fmtView.setUint32(4, opts.sampleRate, true);
    const blockAlign = (opts.bitsPerSample / 8) * opts.channels;
    fmtView.setUint32(8, opts.sampleRate * blockAlign, true);
    fmtView.setUint16(12, blockAlign, true);
    fmtView.setUint16(14, opts.bitsPerSample, true);

    const chunks: Array<{ id: string; body: Uint8Array }> = [];
    if (opts.extraChunk) {
        chunks.push(opts.extraChunk);
    }
    chunks.push({ id: "fmt ", body: fmtBody });
    chunks.push({ id: "data", body: opts.data });

    const size =
        4 +
        chunks.reduce((n, c) => n + 8 + c.body.length + (c.body.length % 2), 0);
    const out = new Uint8Array(8 + size);
    const view = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    view.setUint32(4, size, true);
    out.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    let offset = 12;
    for (const chunk of chunks) {
        for (let i = 0; i < 4; i += 1) {
            out[offset + i] = chunk.id.charCodeAt(i);
        }
        view.setUint32(offset + 4, chunk.body.length, true);
        out.set(chunk.body, offset + 8);
        offset += 8 + chunk.body.length + (chunk.body.length % 2);
    }
    return out;
}

describe("encodeWav / decodeWav", () => {
    it("round-trips mono 16 kHz PCM to 16-bit fidelity", () => {
        const pcm = Float32Array.from(
            { length: 1600 },
            (_, i) => Math.sin((i / 1600) * Math.PI * 8) * 0.8,
        );
        const decoded = decodeWav(encodeWav(pcm, 16000));
        expect(decoded.sampleRate).toBe(16000);
        expect(decoded.pcm.length).toBe(pcm.length);
        for (let i = 0; i < pcm.length; i += 1) {
            // 16-bit quantization step is ~3e-5; allow a hair over it.
            expect(Math.abs(decoded.pcm[i]! - pcm[i]!)).toBeLessThan(1e-4);
        }
    });

    it("writes a canonical header the decoder can walk", () => {
        const bytes = encodeWav(Float32Array.from([0, 0.5, -0.5]), 8000);
        expect(Array.from(bytes.subarray(0, 4))).toEqual([
            0x52, 0x49, 0x46, 0x46,
        ]);
        expect(Array.from(bytes.subarray(8, 12))).toEqual([
            0x57, 0x41, 0x56, 0x45,
        ]);
        const decoded = decodeWav(bytes);
        expect(decoded.sampleRate).toBe(8000);
        expect(decoded.pcm.length).toBe(3);
    });

    it("clamps out-of-range floats instead of wrapping", () => {
        const decoded = decodeWav(encodeWav(Float32Array.from([2, -2]), 16000));
        expect(decoded.pcm[0]).toBeCloseTo(1, 3);
        expect(decoded.pcm[1]).toBeCloseTo(-1, 3);
    });

    it("decodes past a non-audio chunk before fmt/data", () => {
        const data = new Uint8Array([0x00, 0x40, 0x00, 0xc0]); // 0.5, -0.5
        const bytes = buildWav({
            format: 1,
            channels: 1,
            sampleRate: 16000,
            bitsPerSample: 16,
            data,
            extraChunk: { id: "LIST", body: new Uint8Array([1, 2, 3, 4]) },
        });
        const decoded = decodeWav(bytes);
        expect(decoded.sampleRate).toBe(16000);
        expect(decoded.pcm[0]).toBeCloseTo(0.5, 3);
        expect(decoded.pcm[1]).toBeCloseTo(-0.5, 3);
    });

    it("downmixes stereo to mono by averaging", () => {
        // Frames: (1.0, -1.0) → 0; (0.5, 0.5) → 0.5.
        const data = new Uint8Array([
            0xff, 0x7f, 0x01, 0x80, 0x00, 0x40, 0x00, 0x40,
        ]);
        const decoded = decodeWav(
            buildWav({
                format: 1,
                channels: 2,
                sampleRate: 48000,
                bitsPerSample: 16,
                data,
            }),
        );
        expect(decoded.sampleRate).toBe(48000);
        expect(decoded.pcm.length).toBe(2);
        expect(decoded.pcm[0]).toBeCloseTo(0, 3);
        expect(decoded.pcm[1]).toBeCloseTo(0.5, 3);
    });

    it("decodes 32-bit float samples", () => {
        const data = new Uint8Array(8);
        const view = new DataView(data.buffer);
        view.setFloat32(0, 0.25, true);
        view.setFloat32(4, -0.75, true);
        const decoded = decodeWav(
            buildWav({
                format: 3,
                channels: 1,
                sampleRate: 16000,
                bitsPerSample: 32,
                data,
            }),
        );
        expect(decoded.pcm[0]).toBeCloseTo(0.25, 4);
        expect(decoded.pcm[1]).toBeCloseTo(-0.75, 4);
    });

    it("decodes 24-bit PCM with sign extension", () => {
        // +0.5 → 0x400000; -1.0 → 0x800000.
        const data = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0x80]);
        const decoded = decodeWav(
            buildWav({
                format: 1,
                channels: 1,
                sampleRate: 16000,
                bitsPerSample: 24,
                data,
            }),
        );
        expect(decoded.pcm[0]).toBeCloseTo(0.5, 3);
        expect(decoded.pcm[1]).toBeCloseTo(-1, 3);
    });

    it("rejects a non-RIFF byte string", () => {
        expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow(/RIFF/);
    });

    it("rejects an unsupported encoding", () => {
        const bytes = buildWav({
            format: 0x11, // IMA ADPCM
            channels: 1,
            sampleRate: 16000,
            bitsPerSample: 4,
            data: new Uint8Array([0]),
        });
        expect(() => decodeWav(bytes)).toThrow(/unsupported/);
    });
});
