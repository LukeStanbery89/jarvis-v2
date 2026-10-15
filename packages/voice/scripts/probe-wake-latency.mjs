/**
 * Probes where the openWakeWord detector fires inside a recording (#121).
 *
 * The wake→command path's hardest constraint is not the phrase or the splice —
 * it is *when* the detector reports a match relative to the phrase and the
 * command. This script answers that offline, with no browser and no
 * microphone: it replays a fixture frame by frame (80 ms @ 16 kHz) through the
 * exact pipeline the browser provider drives (`openwakeword-web` + ONNX
 * Runtime Web, from the models the server caches in `~/.jarvis/wake`) and
 * prints, per frame, the audio RMS and the detector's score, marking the frame
 * that crossed the threshold.
 *
 * Two facts it exists to keep checkable (they drove the #121 redesign — see
 * `test/fixtures/README.md` for the measured table):
 *
 * - the crossing lands shortly **after** the phrase ends and, on the real
 *   fixtures, before the command starts, so cutting the stream at the crossing
 *   frame is phrase-free *and* command-complete;
 * - the score then stays high for several hundred milliseconds, because the
 *   feature pipeline only reaches the phrase after ingesting the audio that
 *   followed it — the window in which captured frames must be *queued*, not
 *   dropped, or the command's opening is lost.
 *
 * Maintenance tool, not part of the build or CI: it needs the cached models
 * (`JARVIS_WAKE_PROVIDER=openwakeword` and one armed client, or the server's
 * own download), a built `dist/` (it decodes WAVs with the package's codec),
 * and ORT's Node build, which reads model files from disk — hence a filesystem
 * `baseUrl`.
 *
 * Usage (from `packages/voice`):
 *
 *     npm run build && node scripts/probe-wake-latency.mjs <fixture.wav> [threshold] [gain]
 *
 * `gain` scales the samples before they reach the detector, which is how the
 * score's dependence on input level is checked: the mel features are built
 * from unnormalized int16 magnitudes, so a quieter microphone shifts the
 * threshold crossing but not where the score starts to rise.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const PACKAGE_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);

/** Where the server caches the wake models (see config.ts). */
const MODEL_DIR = path.join(homedir(), ".jarvis", "wake");

/** The detector's frame size and rate — the provider's constants. */
const FRAME_SAMPLES = 1280;
const MIC_SAMPLE_RATE = 16000;

const file = process.argv[2];
const threshold = Number(process.argv[3] ?? 0.5);
const gain = Number(process.argv[4] ?? 1);
if (file === undefined) {
    console.error(
        "usage: node scripts/probe-wake-latency.mjs <fixture.wav> [threshold] [gain]",
    );
    process.exit(2);
}

const require = createRequire(import.meta.url);
const { CUT_SCAN_FRAMES, SCORE_FLOOR } = require(
    path.join(PACKAGE_ROOT, "dist", "providers", "openWakeWord.js"),
);
const { decodeWav } = require(path.join(PACKAGE_ROOT, "dist", "wav.js"));

const audio = decodeWav(readFileSync(file));
if (audio.sampleRate !== MIC_SAMPLE_RATE) {
    throw new Error(
        `the fixture must be 16 kHz mono WAV; got ${audio.sampleRate} Hz`,
    );
}

const pcm = Int16Array.from(audio.pcm, (sample) =>
    Math.max(-32768, Math.min(32767, Math.round(sample * 32768 * gain))),
);
const frames = Math.floor(pcm.length / FRAME_SAMPLES);

// ORT's Node build reads model files from disk, so `baseUrl` is a directory
// path here rather than the /api/wake/model/ URL a browser would use.
const { OpenWakeWord } = await import("openwakeword-web");

const scores = [];
const rms = [];
let firedAt = null;
let firedScore = null;

const instance = await OpenWakeWord.create({
    baseUrl: `${MODEL_DIR}${path.sep}`,
    wakewordModels: ["hey_jarvis"],
    threshold,
    ort: { wasmPaths: undefined, numThreads: 1, simd: true },
    onDetection: (event) => {
        if (firedAt === null) {
            firedAt = scores.length;
            firedScore = event.score;
        }
    },
});

for (let i = 0; i < frames; i += 1) {
    const frame = pcm.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES);
    let sum = 0;
    for (const sample of frame) {
        sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / frame.length) / 32768);
    scores.push(Math.max(...Object.values(await instance.predict(frame))));
}

const ms = (i) => ((i * FRAME_SAMPLES) / MIC_SAMPLE_RATE) * 1000;

/**
 * The provider's cut, mirrored (#121): at the crossing, walk back to the most
 * recent frame still at the noise floor; the command starts one frame later.
 * Falls back to the crossing frame when the window holds no quiet frame.
 *
 * @param crossing - Index of the frame whose score crossed the threshold.
 * @returns The index the command stream starts at.
 */
function cutIndex(crossing) {
    const from = Math.max(0, crossing - CUT_SCAN_FRAMES);
    for (let i = crossing - 1; i >= from; i -= 1) {
        if (scores[i] < SCORE_FLOOR) {
            return i + 1;
        }
    }
    return crossing;
}

const cut = firedAt === null ? null : cutIndex(firedAt);

console.log(
    `${path.basename(file)}  ${((audio.pcm.length / MIC_SAMPLE_RATE) * 1000).toFixed(0)} ms  ${frames} frames  threshold ${threshold}  gain ${gain}`,
);
console.log("frame  start_ms     rms   score");
for (let i = 0; i < frames; i += 1) {
    const marks = [
        i === firedAt ? "<-- fired" : "",
        i === cut ? "<== stream starts here" : "",
    ]
        .filter(Boolean)
        .join("  ");
    console.log(
        `f${String(i).padStart(3)}  ${ms(i).toFixed(0).padStart(7)}  ${rms[i].toFixed(4)}  ${scores[i].toFixed(3)}${
            marks === "" ? "" : `   ${marks}`
        }`,
    );
}
console.log(
    firedAt === null
        ? "no detection"
        : `fired at frame ${firedAt} (${ms(firedAt).toFixed(0)} ms), score ${firedScore.toFixed(3)}; stream starts at frame ${cut} (${ms(cut).toFixed(0)} ms)`,
);
