/**
 * Corpus access for the wake→command tests (issue #121).
 *
 * Loads the committed WAV fixtures (and, when the maintainer has recorded any,
 * the gitignored `local/` captures) as decoded mono PCM, and slices them by
 * time, so a test can hand the pipeline the *actual* audio of an utterance
 * instead of a hand-built sample array. The slices model the provider
 * contract under test: today's "ring ends at match time" feeds the phrase
 * into the engine, which is exactly what the corpus pins.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { decodeWav, type WavAudio } from "../../src/index";

/** The committed fixture shapes (see `fixtures/README.md`). */
export type FixtureName =
    | "one-breath"
    | "pause-then-command"
    | "phrase-only"
    | "command-only"
    | "silence";

/** The committed fixtures, in the order the corpus documents them. */
export const FIXTURE_NAMES: readonly FixtureName[] = [
    "one-breath",
    "pause-then-command",
    "phrase-only",
    "command-only",
    "silence",
];

/** Absolute path of the fixtures directory (repo layout, not cwd-dependent). */
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

/**
 * Reads and decodes one WAV fixture.
 *
 * @param file - Absolute path of the file.
 * @returns The decoded mono PCM and its sample rate.
 */
export function loadWav(file: string): WavAudio {
    return decodeWav(new Uint8Array(readFileSync(file)));
}

/**
 * Loads one committed fixture by name.
 *
 * @param name - The fixture shape.
 * @returns The decoded mono PCM and its sample rate.
 */
export function loadFixture(name: FixtureName): WavAudio {
    return loadWav(path.join(FIXTURES_DIR, `${name}.wav`));
}

/**
 * Loads one of the maintainer's real recordings (`fixtures/real/`), committed
 * for the corpus — same shapes as the synthetic set, real acoustics. These
 * are the fixtures that can reproduce the failure class synthetic speech
 * cannot (see `fixtures/README.md`).
 *
 * @param name - The fixture shape.
 * @returns The decoded mono PCM and its sample rate.
 */
export function loadRealFixture(name: FixtureName): WavAudio {
    return loadWav(path.join(FIXTURES_DIR, "real", `${name}.wav`));
}

/**
 * Per-window root-mean-square energy of a decoded recording, in order — the
 * shape probe the corpus tests use to assert an utterance really has the
 * structure it claims (speech, a pause, speech), rather than trusting a
 * hand-chosen millisecond offset.
 *
 * @param audio - The decoded audio.
 * @param windowMs - Window length (default 100 ms).
 * @returns One RMS value per whole window; a trailing partial is dropped.
 */
export function windowRms(audio: WavAudio, windowMs = 100): number[] {
    const size = Math.max(1, Math.round((windowMs / 1000) * audio.sampleRate));
    const out: number[] = [];
    for (let start = 0; start + size <= audio.pcm.length; start += size) {
        let sum = 0;
        for (let i = start; i < start + size; i += 1) {
            const sample = audio.pcm[i]!;
            sum += sample * sample;
        }
        out.push(Math.sqrt(sum / size));
    }
    return out;
}

/** A quiet span that sits between two energy regions. */
export interface Pause {
    /** Start of the quiet span, in milliseconds. */
    readonly startMs: number;
    /** End of the quiet span, in milliseconds. */
    readonly endMs: number;
}

/**
 * Finds the first quiet gap that separates two energy regions — the pause a
 * pause-then-command utterance has and a one-breath utterance does not. Used
 * to derive the "match instant" for a fixture from its own audio instead of a
 * magic offset.
 *
 * @param audio - The decoded audio.
 * @param options - Tuning: `windowMs` (default 100), `quietRms` (default
 *   0.01 — a window counts as silence below this), `minQuietMs` (default
 *   400 — shorter gaps are the natural inter-word pause, not a silence).
 * @returns The gap's bounds, or `null` when no qualifying gap exists.
 */
export function findPause(
    audio: WavAudio,
    options: { windowMs?: number; quietRms?: number; minQuietMs?: number } = {},
): Pause | null {
    const windowMs = options.windowMs ?? 100;
    const quietRms = options.quietRms ?? 0.01;
    const minWindows = Math.max(
        1,
        Math.ceil((options.minQuietMs ?? 400) / windowMs),
    );
    const rms = windowRms(audio, windowMs);
    for (let start = 0; start < rms.length; start += 1) {
        if (rms[start]! >= quietRms) {
            continue;
        }
        let end = start;
        while (end < rms.length && rms[end]! < quietRms) {
            end += 1;
        }
        const hasSpeechBefore = rms.slice(0, start).some((v) => v >= quietRms);
        const hasSpeechAfter = rms.slice(end).some((v) => v >= quietRms);
        if (end - start >= minWindows && hasSpeechBefore && hasSpeechAfter) {
            return { startMs: start * windowMs, endMs: end * windowMs };
        }
        start = end - 1;
    }
    return null;
}

/**
 * Lists the maintainer's local (uncommitted) captures, if any were recorded.
 * Used by the browser replay harness, and skipped silently when the directory
 * is absent.
 *
 * @returns Absolute paths of `local/*.wav`, sorted.
 */
export function listLocalCaptures(): string[] {
    const dir = path.join(FIXTURES_DIR, "local");
    try {
        return readdirSync(dir)
            .filter((name) => name.toLowerCase().endsWith(".wav"))
            .sort()
            .map((name) => path.join(dir, name));
    } catch {
        return [];
    }
}

/**
 * Slices a decoded fixture by time, clamped to its length — the sample window
 * a test hands the pipeline for one region of the utterance.
 *
 * @param audio - The decoded audio.
 * @param fromMs - Window start, in milliseconds.
 * @param toMs - Window end, in milliseconds (exclusive).
 * @returns The window's samples (a copy).
 */
export function sliceMs(
    audio: WavAudio,
    fromMs: number,
    toMs: number,
): Float32Array {
    const from = clampIndex(
        Math.round((fromMs / 1000) * audio.sampleRate),
        audio.pcm.length,
    );
    const to = clampIndex(
        Math.round((toMs / 1000) * audio.sampleRate),
        audio.pcm.length,
    );
    return audio.pcm.slice(from, Math.max(from, to));
}

/**
 * Clamps a sample index into `[0, length]`.
 *
 * @param index - The requested index.
 * @param length - The buffer length.
 * @returns The clamped index.
 */
function clampIndex(index: number, length: number): number {
    return Math.max(0, Math.min(length, index));
}
