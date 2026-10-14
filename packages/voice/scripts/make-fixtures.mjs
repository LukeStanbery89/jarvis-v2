/**
 * Regenerates the wake→command corpus fixtures (#121).
 *
 * The redesign is verified against real audio, so the corpus must be
 * reproducible and committable *without* committing anyone's voice. The
 * fixtures are synthesized from text with macOS `say`, which is a synthetic
 * speaker — no personal data — and converted to the one format the pipeline
 * speaks: 16 kHz mono 16-bit PCM WAV.
 *
 * Each fixture covers a shape the wake→command path must handle (issue #121,
 * lesson 5):
 *
 * - `one-breath.wav`         — "Hey Jarvis, turn on the living room light"
 *                              (phrase and command in one breath: the case the
 *                              look-back existed to protect, and the clip risk)
 * - `pause-then-command.wav` — "Hey Jarvis" + 900 ms silence + the question
 *                              (the 2026-10-14 failure shape: the pause the ASR
 *                              hallucinated over)
 * - `phrase-only.wav`        — "Hey Jarvis" and nothing else (must produce no
 *                              prompt)
 * - `command-only.wav`       — the command with no phrase (drives the STT
 *                              directly, so the detector need not fire)
 * - `silence.wav`            — 1.5 s of pure silence (must produce no prompt)
 *
 * `say`/`afconvert` are macOS-only; the fixtures are committed, so this script
 * is a one-off convenience (and the record of how they were made), not part of
 * the build or CI. Regenerate with `npm run fixtures` from `packages/voice`.
 *
 * Real captures of the failure (the maintainer's own voice) belong in the
 * sibling `local/` directory, which is gitignored — see
 * `test/fixtures/README.md`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const OUT_DIR = path.join(PACKAGE_ROOT, "test", "fixtures");

/** Sample rate every fixture is rendered at — the pipeline's native rate. */
const SAMPLE_RATE = 16000;

/** The `say` voice; override with `FIXTURE_VOICE` for a different timbre. */
const VOICE = process.env.FIXTURE_VOICE ?? "Samantha";

/**
 * The spoken fixtures: a name and the exact text, including `say`'s
 * `[[slnc N]]` embedded-silence command for the pause case.
 */
const SPOKEN = [
    {
        name: "one-breath",
        text: "Hey Jarvis, turn on the living room light",
    },
    {
        name: "pause-then-command",
        text: "Hey Jarvis [[slnc 900]] what's the weather",
    },
    { name: "phrase-only", text: "Hey Jarvis" },
    { name: "command-only", text: "what's the weather" },
];

/**
 * Renders one fixture with `say` → `afconvert` and writes it to `OUT_DIR`.
 *
 * @param tmp - Scratch directory for the intermediate AIFF.
 * @param fixture - The fixture's name and text.
 * @returns The written file's path.
 */
function renderSpoken(tmp, fixture) {
    const aiff = path.join(tmp, `${fixture.name}.aiff`);
    const wav = path.join(OUT_DIR, `${fixture.name}.wav`);
    execFileSync("say", ["-v", VOICE, "-o", aiff, fixture.text]);
    execFileSync("afconvert", [
        "-f",
        "WAVE",
        "-d",
        `LEI16@${SAMPLE_RATE}`,
        "-c",
        "1",
        aiff,
        wav,
    ]);
    return wav;
}

/**
 * Writes a canonical 16-bit mono PCM WAV of pure silence — generated rather
 * than spoken, so its length is exact.
 *
 * @param seconds - The duration.
 * @returns The written file's path.
 */
function writeSilence(seconds) {
    const frames = Math.round(seconds * SAMPLE_RATE);
    const dataBytes = frames * 2;
    const bytes = Buffer.alloc(44 + dataBytes);
    bytes.write("RIFF", 0, "ascii");
    bytes.writeUInt32LE(36 + dataBytes, 4);
    bytes.write("WAVE", 8, "ascii");
    bytes.write("fmt ", 12, "ascii");
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); // PCM
    bytes.writeUInt16LE(1, 22); // mono
    bytes.writeUInt32LE(SAMPLE_RATE, 24);
    bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36, "ascii");
    bytes.writeUInt32LE(dataBytes, 40);
    const wav = path.join(OUT_DIR, "silence.wav");
    writeFileSync(wav, bytes);
    return wav;
}

/**
 * Regenerates every fixture, verifying each is a non-empty file.
 *
 * @returns The written file paths.
 */
export function makeFixtures() {
    const tmp = mkdtempSync(path.join(tmpdir(), "jarvis-fixtures-"));
    const written = [];
    try {
        for (const fixture of SPOKEN) {
            written.push(renderSpoken(tmp, fixture));
        }
        written.push(writeSilence(1.5));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    for (const file of written) {
        if (readFileSync(file).length <= 44) {
            throw new Error(`make-fixtures: ${file} has no audio`);
        }
    }
    return written;
}

// Standalone invocation (not when imported by a test).
if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    for (const file of makeFixtures()) {
        console.log(`fixtures: ${path.relative(PACKAGE_ROOT, file)}`);
    }
}
