/**
 * Short synthesized chimes for the voice prompt lifecycle.
 *
 * The satellite has no bundled audio assets and should not depend on a system
 * sound theme, so the two cues are generated as mono s16le PCM at runtime. They
 * are played through {@link AudioIO.playPcm}, the same path as server TTS.
 */

/** Which lifecycle event a chime announces. */
export type ChimeKind = "wake" | "complete";

/** One generated chime, ready for `AudioIO.playPcm`. */
export interface Chime {
    /** Mono little-endian signed 16-bit PCM. */
    readonly pcm: Buffer;
    readonly sampleRate: number;
}

/** Chime sample rate; independent of the 16 kHz capture path. */
export const CHIME_SAMPLE_RATE = 24_000;

/** Amplitude of each tone; deliberately quieter than normal TTS. */
const AMPLITUDE = 0.12;

/** Short fade in/out to keep the square edges from clicking. */
const FADE_SECONDS = 0.008;

/** Renders one sine tone with a linear attack and release. */
function tone(frequency: number, durationMs: number): number[] {
    const samples = Math.max(
        1,
        Math.round((CHIME_SAMPLE_RATE * durationMs) / 1000),
    );
    const fade = Math.min(
        Math.max(1, Math.round(CHIME_SAMPLE_RATE * FADE_SECONDS)),
        Math.floor(samples / 2),
    );
    const out = new Array<number>(samples);
    for (let i = 0; i < samples; i += 1) {
        let envelope = 1;
        if (i < fade) {
            envelope = i / fade;
        } else if (i >= samples - fade) {
            envelope = (samples - 1 - i) / fade;
        }
        const phase = (2 * Math.PI * frequency * i) / CHIME_SAMPLE_RATE;
        out[i] = Math.sin(phase) * AMPLITUDE * envelope;
    }
    return out;
}

/** Renders a short silence between tones. */
function gap(durationMs: number): number[] {
    return new Array<number>(
        Math.max(0, Math.round((CHIME_SAMPLE_RATE * durationMs) / 1000)),
    ).fill(0);
}

/** Converts float samples to mono s16le. */
function toPcm(samples: readonly number[]): Buffer {
    const pcm = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
        pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
    }
    return pcm;
}

/**
 * Creates one lifecycle chime.
 *
 * `wake` rises (C5 → E5) to mean “I heard you”; `complete` answers with a
 * higher, shorter pair (A5 → D6) to mean “the prompt is captured.”
 */
export function createChime(kind: ChimeKind): Chime {
    const notes =
        kind === "wake"
            ? [tone(523.25, 90), gap(18), tone(659.25, 140)]
            : [tone(880, 80), gap(18), tone(1174.66, 120)];
    return {
        pcm: toPcm(notes.flat()),
        sampleRate: CHIME_SAMPLE_RATE,
    };
}
