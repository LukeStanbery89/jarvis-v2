/**
 * Local TTS harness (issue #83, phase 1): text in, PCM out, played aloud.
 *
 * The manual acceptance tool for the Kokoro provider — it exercises the
 * real lazy module load, the first-use model download into the private
 * cache dir, one synthesis, and playback through the platform player
 * (`afplay` on macOS, `aplay` on Linux). Nothing here touches the wire
 * protocol; the orchestrator phase (#83 P3+) is what hooks synthesis into
 * the `/ws` stream.
 *
 * Run from `packages/server`:
 *
 *     npm run tts:harness
 *     JARVIS_TTS_VOICE=bm_george JARVIS_TTS_TEXT="Systems online." npm run tts:harness
 *
 * First run downloads the quantized checkpoint (~100 MB) into
 * `~/.jarvis/tts` (or `JARVIS_TTS_CACHE_DIR`) — expect the init step to
 * dominate the first timing; later runs init from cache in seconds.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lukestanbery/jarvis-logger";
import {
    DEFAULT_KOKORO_CACHE_DIR,
    DEFAULT_KOKORO_MODEL_ID,
    DEFAULT_KOKORO_VOICE,
    KokoroTtsProvider,
} from "../src/tts/kokoro";
import type { SynthesizedSpeech } from "../src/tts/types";

const logger = createLogger({ tag: "tts-harness" });

const text =
    process.env.JARVIS_TTS_TEXT ??
    process.argv[2] ??
    "The living room light is now on.";
const voice = process.env.JARVIS_TTS_VOICE ?? DEFAULT_KOKORO_VOICE;
const speed = Number(process.env.JARVIS_TTS_SPEED ?? "1");
const modelId = process.env.JARVIS_TTS_MODEL_ID ?? DEFAULT_KOKORO_MODEL_ID;
const dtype = (process.env.JARVIS_TTS_DTYPE ?? "q8") as
    "fp32" | "fp16" | "q8" | "q4" | "q4f16";
const cacheDir = process.env.JARVIS_TTS_CACHE_DIR ?? DEFAULT_KOKORO_CACHE_DIR;

/**
 * Encodes mono float PCM as a 16-bit PCM WAV file buffer.
 *
 * @param speech - The synthesis result.
 * @returns WAV bytes.
 */
function encodeWav(speech: SynthesizedSpeech): Buffer {
    const { pcm, sampleRate } = speech;
    const bytesPerSample = 2;
    const dataSize = pcm.length * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
    buffer.writeUInt16LE(bytesPerSample, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < pcm.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, pcm[i] ?? 0));
        buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
    }
    return buffer;
}

/**
 * Plays a WAV through the platform player when one exists.
 *
 * @param path - The WAV file.
 * @returns Whether playback (attempt) succeeded.
 */
function play(path: string): boolean {
    const player =
        process.platform === "darwin"
            ? "afplay"
            : process.platform === "linux"
              ? "aplay"
              : null;
    if (player === null) {
        return false;
    }
    const result = spawnSync(player, [path], { stdio: "ignore" });
    return result.status === 0;
}

/** Runs one synthesis + playback pass. */
async function main(): Promise<void> {
    const provider = new KokoroTtsProvider({
        modelId,
        dtype,
        voice,
        speed,
        cacheDir,
    });

    const startedAt = Date.now();
    const speech = await provider.synthesize(text);
    const synthMs = Date.now() - startedAt;

    const path = join(tmpdir(), `jarvis-tts-harness-${Date.now()}.wav`);
    writeFileSync(path, encodeWav(speech));

    const seconds = (speech.pcm.length / speech.sampleRate).toFixed(2);
    logger.info(
        `synthesized ${seconds}s of audio in ${synthMs}ms ` +
            `(${speech.sampleRate}Hz, ${modelId}/${dtype}, cache: ${cacheDir})`,
    );
    logger.sensitive("harness text", text);
    logger.info(`WAV written to ${path}`);

    if (play(path)) {
        logger.info("played via platform player");
    } else {
        logger.warn(
            "no platform player found (afplay/aplay) — play the WAV by hand",
        );
    }
}

void main();
