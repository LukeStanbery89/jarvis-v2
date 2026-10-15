/**
 * Offline wake→command replay harness (issue #121, Tier B).
 *
 * The corpus's Tier A test asserts *audio routing* in Node; only a real
 * recognizer can answer "does it transcribe clean?", which is why the
 * redesign is gated on replayed recordings (lesson 3). This dev-only surface
 * runs a WAV through the real local Vosk engine — no microphone — and prints
 * the raw transcript next to the current wake-phrase strip, for both the
 * whole clip and the post-match slice.
 *
 * That pair is the A/B the issue asks for: `full` is today's behavior (the
 * engine hears the phrase and the pause), `post-match` is the redesign's
 * (the engine hears only the command audio). If the redesign works,
 * `full` on `pause-then-command.wav` produces the mangled class and
 * `post-match` does not.
 *
 * Two details make the measurement trustworthy:
 *
 * - **Real-time feeding.** The clip is handed to the engine in ~100 ms pieces
 *   at one piece per 100 ms, exactly as the live pipeline delivers frames.
 *   Feeding faster leaves the worker a backlog of *undecoded* audio when
 *   `stop()` asks for the forced final, so the tail of the utterance — the
 *   command, after a pause — is silently lost and reads as "nothing heard".
 *   {@link FLUSH_WAIT_MS} widens the flush bound on top of that.
 * - **Heard vs final.** The interim (partial) text is shown too, so an empty
 *   final can be told apart from "the engine recognized nothing at all".
 *
 * Reachable at `/web/?voice-harness=1`; the module is code-split, so it never
 * ships to a normal page load. Load any WAV or browser-decodable audio (an
 * iPhone voice memo's `.m4a` works as-is) — the committed fixtures under
 * `packages/voice/test/fixtures/`, or your own recordings.
 */
import { useRef, useState } from "react";
import {
    createVoskStt,
    decodeWav,
    stripWakePhrase,
    type SttProvider,
    type WavAudio,
} from "@lukestanbery/jarvis-voice";
import voskWorkerUrl from "@lichess-org/vosk-browser/dist/vosk.worker.js?url";
import voskWasmUrl from "@lichess-org/vosk-browser/dist/vosk.wasm?url";

/** The wake phrase the strip preview uses (must match the detector's). */
const WAKE_PHRASE = "Hey JARVIS";

/** How much audio is handed to the engine per `feed` (~100 ms). */
const FEED_CHUNK_MS = 100;

/**
 * How long `stop()` waits for the forced final. With real-time feeding the
 * worker's queue is drained by flush time and the result arrives at once; the
 * widened bound only covers a cold engine's first chunk.
 */
const FLUSH_WAIT_MS = 10000;

/** One transcript side: the final text and what the engine said meanwhile. */
interface Take {
    /** The final transcript (joined `onResult` deliveries), trimmed. */
    readonly text: string;
    /** The last interim text the engine emitted (`onPartial`), trimmed. */
    readonly heard: string;
}

/** One clip and the transcripts produced for it. */
interface ResultRow {
    readonly name: string;
    readonly durationMs: number;
    readonly full: Take;
    /** `null` when the clip is shorter than the skip (nothing to replay). */
    readonly postMatch: Take | null;
}

/**
 * Decodes one picked file to mono PCM. WAV goes through the package's
 * dependency-free codec; anything else the browser can decode — an iPhone
 * voice memo is 48 kHz AAC in an `.m4a` — goes through Web Audio, so a fresh
 * recording can be replayed without a conversion step. (The *committed*
 * corpus is still 16 kHz mono WAV, because the CI-side corpus test can only
 * decode WAV.)
 *
 * @param file - The picked file.
 * @returns Mono PCM at the file's own sample rate.
 */
async function decodeClip(file: File): Promise<WavAudio> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
        return decodeWav(bytes);
    } catch (waveError) {
        if (typeof AudioContext === "undefined") {
            throw waveError instanceof Error
                ? waveError
                : new Error(String(waveError));
        }
        const context = new AudioContext({ sampleRate: 16000 });
        try {
            const copy = new Uint8Array(bytes);
            const decoded = await context.decodeAudioData(copy.buffer);
            const pcm = new Float32Array(decoded.length);
            for (
                let channel = 0;
                channel < decoded.numberOfChannels;
                channel += 1
            ) {
                const data = decoded.getChannelData(channel);
                for (let i = 0; i < data.length; i += 1) {
                    pcm[i] += data[i]! / decoded.numberOfChannels;
                }
            }
            return { pcm, sampleRate: decoded.sampleRate };
        } finally {
            void context.close();
        }
    }
}

/**
 * The replay harness. Holds one lazily-built Vosk provider for the page's
 * lifetime (the ~40 MB model loads once) and runs every selected clip through
 * it twice, whole and post-match.
 */
export default function VoiceHarness() {
    const providerRef = useRef<SttProvider | null>(null);
    const [clips, setClips] = useState<
        Array<{ name: string; audio: WavAudio }>
    >([]);
    const [skipMs, setSkipMs] = useState(900);
    const [rows, setRows] = useState<ResultRow[]>([]);
    const [status, setStatus] = useState("idle");
    const [error, setError] = useState<string | null>(null);

    /** Decodes the picked files (16 kHz mono WAV) into state. */
    async function onFiles(files: FileList | null): Promise<void> {
        if (files === null || files.length === 0) {
            return;
        }
        setError(null);
        try {
            const decoded: Array<{ name: string; audio: WavAudio }> = [];
            for (const file of Array.from(files)) {
                decoded.push({
                    name: file.name,
                    audio: await decodeClip(file),
                });
            }
            setClips(decoded);
            setRows([]);
            setStatus(`loaded ${decoded.length} clip(s)`);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * The page's Vosk provider, built on first use and reused after (the
     * model loads once). Uses the harness's widened flush deadline.
     *
     * @returns The provider.
     */
    function ensureProvider(): SttProvider {
        let stt = providerRef.current;
        if (stt === null) {
            stt = createVoskStt({
                workerUrl: voskWorkerUrl,
                wasmUrl: voskWasmUrl,
                flushWaitMs: FLUSH_WAIT_MS,
                log: (message, failure) =>
                    console.log("[harness:vosk]", message, failure ?? ""),
            });
            if (stt === null) {
                throw new Error(
                    "the local Vosk engine is unavailable in this browser",
                );
            }
            providerRef.current = stt;
        }
        return stt;
    }

    /**
     * Runs one audio buffer through the engine and returns its transcript.
     *
     * @param stt - The provider to drive.
     * @param pcm - Mono float PCM.
     * @param sampleRate - The PCM's sample rate.
     * @returns The final transcript and the last interim text.
     */
    async function transcribe(
        stt: SttProvider,
        pcm: Float32Array,
        sampleRate: number,
    ): Promise<Take> {
        const results: string[] = [];
        const partials: string[] = [];
        const failures: string[] = [];
        await stt.start(
            {
                onResult: (text) => results.push(text),
                onPartial: (text) => partials.push(text),
                onError: (voiceError) => failures.push(voiceError.message),
            },
            // `continuous` is the *harness's* choice, not production's config:
            // a bounded clip has to yield finals without an utterance end,
            // whereas a live wake session relies on the engine's own
            // endpointing (`{ source: "external" }` alone — #121). It changes
            // when finals are emitted, not how the audio is recognized, so the
            // transcript columns stay comparable to the live path.
            { continuous: true, source: "external", sampleRate },
        );
        const chunk = Math.max(
            1,
            Math.round((FEED_CHUNK_MS / 1000) * sampleRate),
        );
        for (let offset = 0; offset < pcm.length; offset += chunk) {
            stt.feed?.(pcm.subarray(offset, offset + chunk), sampleRate);
            // Real-time pacing: one chunk per chunk's duration, the cadence
            // the live pipeline delivers frames at. Feeding faster than the
            // worker can decode leaves a backlog of *unprocessed* audio when
            // `stop()` asks for the final, so the tail of the utterance is
            // silently lost — a harness artifact that reads as "the engine
            // did not hear the command".
            await new Promise((resolve) => setTimeout(resolve, FEED_CHUNK_MS));
        }
        await stt.stop();
        if (failures.length > 0) {
            throw new Error(failures[0]);
        }
        return {
            text: results.join(" ").trim(),
            heard: partials.join(" ").trim(),
        };
    }

    /** Runs every loaded clip whole and post-match, filling the table. */
    async function run(): Promise<void> {
        if (clips.length === 0) {
            setError("load at least one WAV first");
            return;
        }
        setError(null);
        const out: ResultRow[] = [];
        try {
            setStatus("loading the speech model (first run only)…");
            const stt = ensureProvider();
            await stt.prepare?.();
            for (const clip of clips) {
                const { pcm, sampleRate } = clip.audio;
                const from = Math.min(
                    pcm.length,
                    Math.max(0, Math.round((skipMs / 1000) * sampleRate)),
                );
                const durationMs = Math.round((pcm.length / sampleRate) * 1000);
                setStatus(`transcribing ${clip.name}…`);
                const full = await transcribe(stt, pcm, sampleRate);
                const postMatch =
                    from < pcm.length
                        ? await transcribe(stt, pcm.slice(from), sampleRate)
                        : null;
                out.push({ name: clip.name, durationMs, full, postMatch });
                setRows([...out]);
            }
            setStatus(`done (${out.length} clip(s))`);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus("failed");
        }
    }

    /** Copies the results as a plain-text report for the issue/PR record. */
    async function copyReport(): Promise<void> {
        const lines = [
            `# Voice harness (#121) skip=${skipMs}ms wakePhrase="${WAKE_PHRASE}"`,
        ];
        for (const row of rows) {
            lines.push(`${row.name} (${row.durationMs}ms)`);
            lines.push(
                `  full      : "${row.full.text}"${
                    row.full.heard === "" ? "" : ` (heard: "${row.full.heard}")`
                }`,
            );
            lines.push(
                row.postMatch === null
                    ? "  post-match: (clip shorter than the skip)"
                    : `  post-match: "${row.postMatch.text}"${
                          row.postMatch.heard === ""
                              ? ""
                              : ` (heard: "${row.postMatch.heard}")`
                      }`,
            );
            lines.push(
                `  full→submitted      : "${stripWakePhrase(row.full.text, WAKE_PHRASE)}"`,
            );
            lines.push(
                `  post-match→submitted: "${
                    row.postMatch === null
                        ? ""
                        : stripWakePhrase(row.postMatch.text, WAKE_PHRASE)
                }"`,
            );
        }
        try {
            await navigator.clipboard.writeText(lines.join("\n"));
            setStatus("report copied to the clipboard");
        } catch {
            setStatus("clipboard blocked; select the table text instead");
        }
    }

    return (
        <main style={{ fontFamily: "monospace", padding: 16, maxWidth: 1100 }}>
            <h1 style={{ fontSize: 20 }}>
                Voice harness — wake→command replay (#121)
            </h1>
            <p style={{ maxWidth: 820 }}>
                Runs an audio file — WAV, or any format the browser decodes (an
                iPhone voice memo is fine) — through the real local Vosk engine,
                with no microphone, in ~{FEED_CHUNK_MS} ms chunks (the live
                cadence). <strong>full</strong> is today&apos;s behavior (the
                phrase and pause reach the engine); <strong>post-match</strong>{" "}
                feeds only the audio after the phrase. It then previews the
                current wake-phrase strip on each, and shows the interim
                (&quot;heard&quot;) text when a final is empty.
            </p>
            <p>
                <input
                    type="file"
                    accept="audio/*"
                    multiple
                    onChange={(event) => void onFiles(event.target.files)}
                />
            </p>
            <p>
                <label>
                    skip (ms):{" "}
                    <input
                        type="number"
                        value={skipMs}
                        min={0}
                        step={100}
                        onChange={(event) =>
                            setSkipMs(Number(event.target.value) || 0)
                        }
                    />
                </label>{" "}
                <button
                    onClick={() => void run()}
                    disabled={clips.length === 0}
                >
                    Transcribe all
                </button>{" "}
                <button
                    onClick={() => void copyReport()}
                    disabled={rows.length === 0}
                >
                    Copy report
                </button>
            </p>
            <p>
                status: {status}
                {clips.length > 0
                    ? ` — ${clips.map((clip) => clip.name).join(", ")}`
                    : ""}
            </p>
            {error !== null && (
                <p style={{ color: "crimson" }}>error: {error}</p>
            )}
            {rows.length > 0 && (
                <table
                    border={1}
                    cellPadding={6}
                    style={{ borderCollapse: "collapse" }}
                >
                    <thead>
                        <tr>
                            <th>clip</th>
                            <th>full (today)</th>
                            <th>post-match ({skipMs} ms+)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.name}>
                                <td>{row.name}</td>
                                <td>
                                    <Side take={row.full} />
                                </td>
                                <td>
                                    {row.postMatch === null ? (
                                        <em>shorter than the skip</em>
                                    ) : (
                                        <Side take={row.postMatch} />
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <p style={{ marginTop: 24, color: "#666" }}>
                Local captures go in{" "}
                <code>packages/voice/test/fixtures/local/</code> (gitignored).
            </p>
        </main>
    );
}

/**
 * One result cell: the raw final, the interim text when it differs, and the
 * wake-phrase strip preview.
 *
 * @param props.take - The transcript side to render.
 */
function Side({ take }: { take: Take }) {
    return (
        <>
            <div>raw: “{take.text}”</div>
            {take.heard !== "" && take.heard !== take.text && (
                <div style={{ color: "#999" }}>heard: “{take.heard}”</div>
            )}
            <div>sent: “{stripWakePhrase(take.text, WAKE_PHRASE)}”</div>
        </>
    );
}
