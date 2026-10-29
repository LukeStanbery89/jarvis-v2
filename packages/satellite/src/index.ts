#!/usr/bin/env node
/**
 * Headless satellite CLI.
 *
 * Launch modes:
 * - default: one continuous SoX capture feeds a local energy segmenter, Whisper
 *   transcribes each utterance, and a transcript containing “Hey JARVIS”
 *   becomes a voice turn.
 * - `--ptt`: press Enter for one utterance, then send it without requiring the
 *   wake phrase. Useful while bringing up a microphone.
 * - `--wav <file>`: transcribe one 16 kHz WAV and send it (or `--dry-run` to
 *   only print the transcript). The no-microphone test path.
 * - `--text <prompt>`: send a voice-mode text prompt to test auth/TTS/playback.
 * - `--check`: validate SoX tools, the token, and the server handshake without
 *   opening the microphone or loading the STT model.
 *
 * The wake word is transcript-based in this first slice; the dedicated
 * openWakeWord detector is phase 1b of #240. Everything is local until the
 * final transcript is sent over `/ws`.
 */
import { readFile } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { decodeWav } from "@lukestanbery/jarvis-voice";
import { checkAudioTools, listAudioDevices, AudioIO } from "./audio";
import { StreamingCapture } from "./capture";
import { SatelliteClient } from "./client";
import { loadConfig, SAMPLE_RATE, type SatelliteConfig } from "./config";
import { loadCredential } from "./credentials";
import { logger } from "./logger";
import { resolveSessionId } from "./session";
import { WhisperStt } from "./stt";
import { extractWakeCommand, resolveWakeUtterance } from "./wake";

interface CliOptions {
    check: boolean;
    ptt: boolean;
    once: boolean;
    dryRun: boolean;
    text: string | undefined;
    wav: string | undefined;
    help: boolean;
}

/** Parses the small CLI surface; unknown flags fail before any I/O. */
function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        check: false,
        ptt: false,
        once: false,
        dryRun: false,
        text: undefined,
        wav: undefined,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--check":
                options.check = true;
                break;
            case "--ptt":
                options.ptt = true;
                break;
            case "--once":
                options.once = true;
                break;
            case "--dry-run":
                options.dryRun = true;
                break;
            case "--text":
                options.text = argv[i + 1];
                i += 1;
                if (options.text === undefined || options.text.length === 0) {
                    throw new Error("--text needs a prompt");
                }
                break;
            case "--wav":
                options.wav = argv[i + 1];
                i += 1;
                if (options.wav === undefined || options.wav.length === 0) {
                    throw new Error("--wav needs a WAV path");
                }
                break;
            case "--help":
            case "-h":
                options.help = true;
                break;
            default:
                throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (options.text !== undefined && options.wav !== undefined) {
        throw new Error("--text and --wav cannot be combined");
    }
    return options;
}

function printHelp(): void {
    process.stdout.write(`JARVIS satellite — headless mic-first client

Usage:
  jarvis-satellite [options]

Options:
  --check            Validate SoX tools, token, and the server handshake.
  --ptt              Push-to-talk: press Enter, speak, pause. No wake phrase.
  --once             Exit after one completed turn.
  --dry-run          Transcribe but do not send (with --wav or microphone).
  --wav <file>       Transcribe one WAV and send it; requires no microphone.
  --text <prompt>    Send a voice-mode text prompt; tests auth/TTS/playback.
  -h, --help         Show this help.

Environment:
  JARVIS_SERVER_URL                  Default: wss://localhost:54321/ws
  JARVIS_SATELLITE_TOKEN             Device token; otherwise the CLI credentials file
  JARVIS_SATELLITE_INSECURE_TLS      Set to 1 for a self-signed local server
  JARVIS_SATELLITE_CA                Path to a private CA bundle
  JARVIS_SATELLITE_MODEL_DIR         Local STT cache (default: ~/.jarvis/satellite/models)
  JARVIS_SATELLITE_INPUT_DEVICE      SoX input device name (default: system default)
  JARVIS_SATELLITE_STT_MODEL         Default: onnx-community/whisper-tiny.en
  JARVIS_SATELLITE_STT_DTYPE         Default: q8
  JARVIS_SATELLITE_SESSION_ID        Fixed conversation id
  JARVIS_SATELLITE_SILENCE_SECONDS   Trailing silence before an utterance ends (0.9)
  JARVIS_SATELLITE_ONSET_SECONDS     Speech needed before recording starts (0.3)
  JARVIS_SATELLITE_SILENCE_THRESHOLD SoX silence threshold (1%)
  JARVIS_SATELLITE_RECORD_TIMEOUT_MS Push-to-talk wait-for-speech cap (20000)
  JARVIS_SATELLITE_PTT_LEAD_MS      Delay after opening the PTT mic before the "Speak now" cue (600)
  JARVIS_SATELLITE_VAD_THRESHOLD    Wake-capture RMS threshold (0.01)
  JARVIS_SATELLITE_VAD_ONSET_MS     Speech needed before an utterance starts (150)
  JARVIS_SATELLITE_VAD_SILENCE_MS   Silence that ends an utterance (800)
  JARVIS_SATELLITE_VAD_PREROLL_MS   Audio kept before onset so the first word survives (1000)
  JARVIS_SATELLITE_VAD_MAX_UTTERANCE_MS  Hard cap on one wake utterance (15000)
  JARVIS_SATELLITE_WAKE_FOLLOWUP_MS Window after a wake-only utterance for the command (5000)
  JARVIS_SATELLITE_CONVERSATION_FOLLOWUP_MS  Window after a reply for a follow-up without the wake phrase (3000; 0 disables)
  JARVIS_SATELLITE_LOCAL_TTS         Set to 1 to speak text locally when the server sends no audio
  JARVIS_LOG_LEVEL                   debug | info | warn | error | silent

The first utterance loads the local Whisper model. If the microphone prompt
does not appear, enable Microphone access for your terminal in System Settings
→ Privacy & Security → Microphone, then relaunch.
`);
}

/** Linear resampling is enough for speech before Whisper's feature extractor. */
function resample(pcm: Float32Array, from: number, to: number): Float32Array {
    if (from === to || pcm.length === 0) {
        return pcm;
    }
    const ratio = to / from;
    const length = Math.max(1, Math.floor(pcm.length * ratio));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
        const source = i / ratio;
        const left = Math.floor(source);
        const right = Math.min(pcm.length - 1, left + 1);
        const fraction = source - left;
        out[i] = pcm[left]! * (1 - fraction) + pcm[right]! * fraction;
    }
    return out;
}

/** Decodes a WAV, resamples if needed, and transcribes it locally. */
async function transcribeFile(file: string, stt: WhisperStt): Promise<string> {
    const { pcm, sampleRate } = decodeWav(await readFile(file));
    return stt.transcribe(resample(pcm, sampleRate, SAMPLE_RATE));
}

/** Prints one prompt and plays the collected TTS audio when present. */
async function runTurn(
    client: SatelliteClient,
    audio: AudioIO,
    sessionId: string,
    prompt: string,
    playbackHooks?: {
        onPlaybackStart?: () => void;
        onPlaybackEnd?: () => void;
    },
): Promise<void> {
    // Authenticate before printing the answer prefix so the handshake
    // diagnostic cannot land between "JARVIS:" and the first token.
    await client.connect();
    process.stdout.write("JARVIS: ");
    const result = await client.prompt(prompt, sessionId, {
        onChunk: (chunk) => process.stdout.write(chunk),
        onTool: (name) => logger.info(`Agent calling tool ${name}`),
        onToolResult: (name) =>
            logger.debug(`Agent tool ${name} returned a result`),
    });
    process.stdout.write("\n");
    if (result.audio !== null && result.audio.pcm.length > 0) {
        playbackHooks?.onPlaybackStart?.();
        try {
            await audio.playPcm(result.audio.pcm, result.audio.sampleRate);
        } finally {
            playbackHooks?.onPlaybackEnd?.();
        }
    } else if (audio.localTts) {
        playbackHooks?.onPlaybackStart?.();
        try {
            await audio.speak(result.text);
        } finally {
            playbackHooks?.onPlaybackEnd?.();
        }
    } else {
        logger.debug("Turn had no TTS audio");
    }
}

/** `--check`: tools, config, token, and a real auth/hello handshake. */
async function runCheck(
    config: SatelliteConfig,
    client: SatelliteClient,
    credentialLabel: string | undefined,
    sessionId: string,
): Promise<void> {
    const tools = checkAudioTools();
    process.stdout.write(`server:  ${config.serverUrl}\n`);
    process.stdout.write(
        `token:   ${credentialLabel !== undefined ? `found (${credentialLabel})` : "none — guest"}\n`,
    );
    process.stdout.write(`thread:  ${sessionId}\n`);
    process.stdout.write(
        `capture: ${tools.capture ?? "MISSING (install SoX)"}\n`,
    );
    process.stdout.write(`sox:     ${tools.sox ?? "MISSING"}\n`);
    process.stdout.write(
        `input:   ${config.inputDevice ?? "system default"}\n`,
    );
    const devices = listAudioDevices();
    if (devices.length > 0) {
        process.stdout.write(`devices: ${devices.join(" | ")}\n`);
    }
    process.stdout.write(
        `player:  ${tools.player ?? "MISSING (install SoX)"}\n`,
    );
    process.stdout.write(
        `stt:     ${config.sttModel} (${config.sttDtype}) → ${config.modelCacheDir}\n`,
    );
    for (const problem of tools.problems) {
        process.stdout.write(`problem: ${problem}\n`);
    }
    await client.connect();
    const identity = client.getIdentity();
    process.stdout.write(
        `handshake: ok${identity !== null ? ` as ${identity.user} (${identity.device})` : " as guest"}\n`,
    );
}

/** `--wav`: transcribe a file, then send it unless this is a dry run. */
async function runWav(
    options: CliOptions,
    stt: WhisperStt,
    client: SatelliteClient,
    audio: AudioIO,
    sessionId: string,
): Promise<void> {
    const file = options.wav!;
    const heard = await transcribeFile(file, stt);
    process.stdout.write(`You: ${heard || "(no speech recognized)"}\n`);
    if (options.dryRun) {
        return;
    }
    const command = extractWakeCommand(heard) ?? heard;
    if (command.length === 0) {
        logger.warn("Nothing to send; the WAV contained no command");
        return;
    }
    await runTurn(client, audio, sessionId, command);
}

/** Microphone loops: transcript-based wake (default) or Enter-to-talk. */
async function runMicrophone(
    config: SatelliteConfig,
    options: CliOptions,
    stt: WhisperStt,
    client: SatelliteClient,
    audio: AudioIO,
    sessionId: string,
): Promise<void> {
    await stt.warmup();

    if (options.ptt) {
        const rl = createInterface({ input: stdin, output: stdout });
        let recording = false;
        let quitRequested = false;
        // `rl.question` only consumes the Enter that starts a capture. Keep a
        // line listener for the recording window so `q` can actually interrupt
        // a microphone capture that is waiting for speech.
        const onLine = (line: string): void => {
            if (!recording) {
                return;
            }
            if (line.trim().toLowerCase() === "q") {
                logger.info("Cancelling recording…");
                quitRequested = true;
                audio.stopRecording();
            }
        };
        rl.on("line", onLine);
        try {
            for (;;) {
                const answer = await rl.question(
                    "Press Enter to talk, or q to quit: ",
                );
                if (answer.trim().toLowerCase() === "q") {
                    return;
                }
                process.stdout.write("Recording… opening the microphone.\n");
                recording = true;
                const file = await audio.recordUtterance({
                    timeoutMs: audio.recordTimeoutMs,
                    leadMs: audio.pttLeadMs,
                    onStarted: () => {
                        process.stdout.write(
                            "Speak now (q cancels and quits).\n",
                        );
                    },
                });
                recording = false;
                if (quitRequested) {
                    return;
                }
                if (file === null) {
                    logger.info("No utterance captured; still ready.");
                    continue;
                }
                try {
                    const heard = await transcribeFile(file, stt);
                    process.stdout.write(`You: ${heard || "(no speech)"}\n`);
                    const command = extractWakeCommand(heard) ?? heard;
                    if (command.length === 0) {
                        continue;
                    }
                    if (!options.dryRun) {
                        try {
                            await runTurn(client, audio, sessionId, command);
                        } catch (err) {
                            logger.error(
                                `Turn failed: ${err instanceof Error ? err.message : String(err)}`,
                            );
                        }
                    }
                } finally {
                    await unlink(file).catch(() => undefined);
                }
                if (options.once) {
                    return;
                }
            }
        } finally {
            rl.off("line", onLine);
            rl.close();
        }
    }

    const rl = createInterface({ input: stdin, output: stdout });
    let capture: StreamingCapture | null = null;
    let stopRequested = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const stop = (): void => {
        if (stopRequested) {
            return;
        }
        stopRequested = true;
        capture?.stop();
        finish();
    };
    const onLine = (line: string): void => {
        if (line.trim().toLowerCase() === "q") {
            logger.info("Stopping…");
            stop();
        }
    };
    rl.on("line", onLine);
    let followUpUntil = 0;
    try {
        capture = new StreamingCapture(config, {
            onUtterance: async (pcm) => {
                const heard = await stt.transcribe(pcm);
                process.stdout.write(
                    `You: ${heard || "(no speech recognized)"}\n`,
                );
                const decision = resolveWakeUtterance(
                    heard,
                    Date.now() < followUpUntil,
                );
                if (decision.kind === "ignore") {
                    logger.debug(
                        "Ignoring an utterance without the wake phrase",
                    );
                    return;
                }
                if (decision.kind === "wait") {
                    // The wake phrase arrived on its own. Keep the follow-up
                    // window open for the command, and re-arm it if the user
                    // says only “Hey JARVIS” again.
                    followUpUntil = Date.now() + config.wakeFollowUpMs;
                    logger.info(
                        "Wake phrase heard; listening for the command…",
                    );
                    return;
                }

                followUpUntil = 0;
                const command = decision.command;
                logger.sensitive("Heard command", command);
                let turnSucceeded = false;
                if (!options.dryRun) {
                    try {
                        await runTurn(client, audio, sessionId, command, {
                            onPlaybackStart: () => capture?.setMuted(true),
                            onPlaybackEnd: () => capture?.setMuted(false),
                        });
                        turnSucceeded = true;
                    } catch (err) {
                        logger.error(
                            `Turn failed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }
                if (options.once) {
                    stop();
                } else if (turnSucceeded && config.conversationFollowUpMs > 0) {
                    followUpUntil = Date.now() + config.conversationFollowUpMs;
                    logger.debug(
                        `Follow-up window open for ${config.conversationFollowUpMs} ms`,
                    );
                }
            },
            onError: (error) => {
                logger.error(error.message);
                stop();
            },
        });
        capture.start();
        logger.info('Listening for "Hey JARVIS"… press q to quit.');
        await finished;
    } finally {
        rl.off("line", onLine);
        rl.close();
        capture?.stop();
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const config = loadConfig();
    const credential = loadCredential(config.serverUrl, config.credentialsFile);
    const sessionId = resolveSessionId(config);
    const audio = new AudioIO(config);
    const stt = new WhisperStt(config);
    const client = new SatelliteClient({
        url: config.serverUrl,
        ...(credential !== null ? { token: credential.token } : {}),
        insecureTls: config.insecureTls,
        ...(config.caPath !== undefined ? { caPath: config.caPath } : {}),
        connectTimeoutMs: config.connectTimeoutMs,
        authTimeoutMs: config.authTimeoutMs,
        onNotification: (notification) => {
            process.stdout.write(
                `\n[notification:${notification.class}] ${notification.title}${notification.body !== undefined ? ` — ${notification.body}` : ""}\n`,
            );
        },
    });
    let stopped = false;
    const shutdown = (announce = false): void => {
        if (stopped) {
            return;
        }
        stopped = true;
        if (announce) {
            logger.info("Stopping satellite…");
        }
        audio.dispose();
        client.close();
    };
    process.on("SIGINT", () => {
        shutdown(true);
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        shutdown(true);
        process.exit(0);
    });

    process.stdout.write("JARVIS satellite\n");
    process.stdout.write(`  server: ${config.serverUrl}\n`);
    const credentialLabel =
        credential === null
            ? undefined
            : credential.source === "env"
              ? "environment"
              : (credential.user ?? "stored device");
    process.stdout.write(`  token:  ${credentialLabel ?? "none (guest)"}\n`);
    process.stdout.write(`  thread: ${sessionId}\n`);
    const mode = options.check
        ? "check"
        : options.text !== undefined
          ? "text"
          : options.wav !== undefined
            ? "wav"
            : options.ptt
              ? "push-to-talk"
              : "wake word";
    process.stdout.write(`  mode:   ${mode}\n`);

    try {
        if (options.check) {
            await runCheck(config, client, credentialLabel, sessionId);
            return;
        }
        if (options.text !== undefined) {
            await runTurn(client, audio, sessionId, options.text);
            return;
        }
        if (options.wav !== undefined) {
            await runWav(options, stt, client, audio, sessionId);
            return;
        }
        await runMicrophone(config, options, stt, client, audio, sessionId);
    } finally {
        shutdown();
    }
}

main().catch((err: unknown) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
