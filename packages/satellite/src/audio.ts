/**
 * SoX-backed audio I/O for a headless satellite.
 *
 * Capture and playback are child processes rather than native Node bindings.
 * That keeps a Raspberry Pi install to `apt install sox` (or `brew install
 * sox`) instead of a compiler/PortAudio toolchain, and makes the microphone
 * and speaker selectable through the operating system's default device. The
 * class owns at most one recorder and one player at a time so Ctrl+C and a
 * failed turn cannot leave a microphone open.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeWav } from "@lukestanbery/jarvis-voice";
import { logger } from "./logger";
import { SAMPLE_RATE, type SatelliteConfig } from "./config";

/** A resolved audio tool, or the reason it is missing. */
export interface AudioToolStatus {
    capture: string | null;
    sox: string | null;
    player: string | null;
    problems: string[];
}

/** A streaming mono s16le player fed by the server's TTS chunks. */
export interface PcmStream {
    /** Queues one chunk; writes are ordered and backpressured. */
    write(chunk: Buffer): void;
    /** Ends the stream and resolves `true` only if playback completed. */
    end(): Promise<boolean>;
}

/** Returns an executable's resolved path, or `null` when it is not on PATH. */
function which(command: string): string | null {
    try {
        return execFileSync("which", [command], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

/** Selects the macOS/Linux playback command, preferring the built-in one. */
function findPlayer(): string | null {
    if (process.platform === "darwin") {
        return which("afplay");
    }
    return which("aplay") ?? which("play");
}

/**
 * Selects a player that can read raw PCM from a named pipe.
 *
 * macOS uses SoX's CoreAudio output; Linux prefers `aplay`, with SoX/ALSA as a
 * fallback. `null` makes the satellite fall back to collecting the turn and
 * using `afplay`/`aplay` as before.
 */
function findStreamPlayer(): string | null {
    if (process.platform === "darwin") {
        return which("sox");
    }
    return which("aplay") ?? which("sox");
}

/** Selects a local text-to-speech command for the offline fallback. */
function findLocalVoice(): string | null {
    if (process.platform === "darwin") {
        return which("say");
    }
    return which("espeak-ng") ?? which("espeak") ?? which("spd-say");
}

/** Converts raw little-endian signed 16-bit PCM into a WAV byte string. */
export function pcmS16leToWav(pcm: Buffer, sampleRate: number): Buffer {
    const samples = new Float32Array(Math.floor(pcm.length / 2));
    for (let i = 0; i < samples.length; i += 1) {
        samples[i] = pcm.readInt16LE(i * 2) / 32768;
    }
    return Buffer.from(encodeWav(samples, sampleRate));
}

/** Reports whether the SoX recorder and a player are available. */
export function checkAudioTools(): AudioToolStatus {
    const capture = which("rec");
    const sox = which("sox");
    const player = findPlayer();
    const problems: string[] = [];
    if (capture === null) {
        problems.push(
            "`rec` was not found; install SoX (`brew install sox` or `sudo apt install sox`)",
        );
    }
    if (sox === null) {
        problems.push(
            "`sox` was not found; install SoX (`brew install sox` or `sudo apt install sox`)",
        );
    }
    if (player === null) {
        problems.push(
            "no audio player was found; install SoX (`play`) or use a system player",
        );
    }
    return { capture, sox, player, problems };
}

/**
 * Lists the audio devices SoX can see for the current platform.
 *
 * On macOS this is the same `sox -V6 -n -t coreaudio` enumeration the SoX
 * manual documents; the values are what `JARVIS_SATELLITE_INPUT_DEVICE`
 * accepts. Linux uses the ALSA driver.
 */
export function listAudioDevices(): string[] {
    const sox = which("sox");
    if (sox === null) {
        return [];
    }
    const driver = process.platform === "darwin" ? "coreaudio" : "alsa";
    const result = spawnSync(sox, ["-V6", "-n", "-t", driver, "list-devices"], {
        encoding: "utf8",
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return [...text.matchAll(/Found Audio Device "([^"]+)"/g)].map(
        (match) => match[1]!,
    );
}

/** Audio I/O for one satellite process. */
export class AudioIO {
    private recorder: ChildProcess | null = null;
    private player: ChildProcess | null = null;
    private voice: ChildProcess | null = null;
    private readonly capture: string | null;
    private readonly sox: string | null;
    private readonly inputDevice: string | undefined;
    private readonly audioDriver: string;
    private readonly playerCommand: string | null;
    private readonly streamPlayerCommand: string | null;
    private readonly voiceCommand: string | null;
    private streamSink: WriteStream | null = null;
    private streamFifo: string | null = null;
    private readonly tempDir: string;
    /** Whether the reply should be spoken locally when the server sends none. */
    readonly localTts: boolean;
    /** Cap on a push-to-talk capture waiting for speech. */
    readonly recordTimeoutMs: number;
    /** Delay after opening the PTT mic before cueing the user to speak. */
    readonly pttLeadMs: number;
    private disposed = false;
    private recordingCancelled = false;
    private playbackStopped = false;
    private recordTimer: NodeJS.Timeout | null = null;

    constructor(private readonly config: SatelliteConfig) {
        const status = checkAudioTools();
        this.capture = status.capture;
        this.sox = status.sox;
        this.inputDevice = config.inputDevice;
        this.audioDriver = process.platform === "darwin" ? "coreaudio" : "alsa";
        this.playerCommand = status.player;
        this.streamPlayerCommand = findStreamPlayer();
        this.voiceCommand = findLocalVoice();
        this.localTts = config.localTts;
        this.recordTimeoutMs = config.recordTimeoutMs;
        this.pttLeadMs = config.pttLeadMs;
        this.tempDir = path.join(config.stateDir, "tmp");
        mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
    }

    /** The tools resolved at construction, for `--check`. */
    getTools(): AudioToolStatus {
        return {
            capture: this.capture,
            sox: this.sox,
            player: this.playerCommand,
            problems: checkAudioTools().problems,
        };
    }

    /** Stops the active recorder; the pending `recordUtterance` returns null. */
    stopRecording(): void {
        if (this.recorder !== null && this.recorder.exitCode === null) {
            this.recordingCancelled = true;
            this.killRecorder();
        }
    }

    /** Sends INT (SoX's clean stop), then KILL if the child refuses to leave. */
    private killRecorder(): void {
        const child = this.recorder;
        if (child === null || child.exitCode !== null) {
            return;
        }
        child.kill("SIGINT");
        const killTimer = setTimeout(() => {
            if (child.exitCode === null) {
                child.kill("SIGKILL");
            }
        }, 500);
        killTimer.unref();
    }

    /**
     * Stops the active player or local voice. The pending `playWav`/`speak`
     * promise resolves `false`, so a barge-in does not open a follow-up window.
     */
    stopPlayback(): void {
        this.playbackStopped = true;
        this.streamSink?.destroy();
        this.streamSink = null;
        if (this.streamFifo !== null) {
            const fifo = this.streamFifo;
            this.streamFifo = null;
            void unlink(fifo).catch(() => undefined);
        }
        for (const child of [this.player, this.voice]) {
            if (child !== null && child.exitCode === null) {
                child.kill("SIGINT");
                const killTimer = setTimeout(() => {
                    if (child.exitCode === null) {
                        child.kill("SIGKILL");
                    }
                }, 500);
                killTimer.unref();
            }
        }
    }

    /**
     * Records one utterance, starting when SoX sees speech and stopping after
     * the configured trailing silence. Returns the temporary WAV path, or
     * `null` when the recorder was stopped before it produced a file.
     *
     * @param options.timeoutMs - Optional cap on how long to wait for speech.
     *   A push-to-talk capture uses this so a missing microphone permission
     *   does not leave the prompt stuck forever.
     * @param options.leadMs - Wait this long after opening the microphone
     *   before calling {@link options.onStarted}. Bluetooth headsets switch
     *   profiles when the mic opens; the capture is already running during the
     *   lead, and `silence -l` keeps that audio.
     * @param options.onStarted - Called once the mic has had its lead time.
     */
    async recordUtterance(
        options: {
            timeoutMs?: number;
            leadMs?: number;
            onStarted?: () => void;
        } = {},
    ): Promise<string | null> {
        if (this.inputDevice !== undefined && this.sox === null) {
            throw new Error(
                "`sox` is unavailable; install SoX or unset JARVIS_SATELLITE_INPUT_DEVICE",
            );
        }
        if (this.inputDevice === undefined && this.capture === null) {
            throw new Error(
                "`rec` is unavailable; install SoX before using microphone mode",
            );
        }
        if (this.disposed) {
            return null;
        }
        this.recordingCancelled = false;
        const file = path.join(
            this.tempDir,
            `utterance-${process.pid}-${Date.now()}.wav`,
        );
        const formatArgs = [
            "-c",
            "1",
            "-r",
            String(SAMPLE_RATE),
            "-b",
            "16",
            "-e",
            "signed-integer",
        ];
        const effectArgs = [
            "silence",
            "-l",
            "1",
            String(this.config.onsetSeconds),
            this.config.silenceThreshold,
            "1",
            String(this.config.silenceSeconds),
            this.config.silenceThreshold,
            "trim",
            "0",
            String(this.config.maxUtteranceSeconds),
        ];
        // A named device needs the `sox` executable (`rec` is the default-device
        // wrapper). The argument order is input format/device, output file,
        // then effects; this is the shape documented for coreaudio/ALSA.
        const command =
            this.inputDevice !== undefined ? this.sox : this.capture;
        const args =
            this.inputDevice !== undefined
                ? [
                      "-q",
                      "-t",
                      this.audioDriver,
                      this.inputDevice,
                      ...formatArgs,
                      file,
                      ...effectArgs,
                  ]
                : ["-q", ...formatArgs, "-t", "wav", file, ...effectArgs];
        const child = spawn(command!, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        this.recorder = child;
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        if (options.timeoutMs !== undefined) {
            this.recordTimer = setTimeout(() => {
                if (this.recorder !== null) {
                    logger.warn(
                        "No speech captured before the push-to-talk timeout; releasing the microphone",
                    );
                    this.recordingCancelled = true;
                    this.killRecorder();
                }
            }, options.timeoutMs);
        }
        const exitPromise = new Promise<number | null>((resolve) => {
            child.on("error", () => resolve(null));
            // `exit`, not `close`: a recorder wrapper may leave a grandchild
            // holding the stderr pipe after the wrapper itself is signalled.
            // Destroying the pipe lets the Node process leave even then.
            child.on("exit", (code) => {
                child.stderr?.destroy();
                resolve(code);
            });
        });
        if (options.leadMs !== undefined && options.leadMs > 0) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, options.leadMs);
            });
        }
        if (
            !this.recordingCancelled &&
            !this.disposed &&
            child.exitCode === null
        ) {
            options.onStarted?.();
        }
        const exitCode = await exitPromise;
        if (this.recordTimer !== null) {
            clearTimeout(this.recordTimer);
            this.recordTimer = null;
        }
        this.recorder = null;
        if (this.disposed || this.recordingCancelled) {
            await unlink(file).catch(() => undefined);
            return null;
        }
        if (exitCode !== 0 && exitCode !== null) {
            await unlink(file).catch(() => undefined);
            throw new Error(
                `audio capture failed (${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            );
        }
        try {
            const stat = await readFile(file);
            if (stat.byteLength === 0) {
                await unlink(file).catch(() => undefined);
                return null;
            }
            return file;
        } catch {
            return null;
        }
    }

    /**
     * Starts a raw PCM player fed chunk by chunk, so a long reply begins
     * speaking as soon as the server sends `audioStart` instead of after the
     * whole WAV is collected. Returns `null` when no streaming-capable player
     * exists; the caller then falls back to {@link playPcm}.
     */
    startPcmStream(sampleRate: number): PcmStream | null {
        if (this.streamPlayerCommand === null || this.disposed) {
            return null;
        }
        this.playbackStopped = false;
        const fifo = path.join(
            this.tempDir,
            `pcm-${process.pid}-${Date.now()}.fifo`,
        );
        const made = spawnSync("mkfifo", [fifo], {
            stdio: "ignore",
        });
        if (made.status !== 0) {
            logger.debug("Could not create the streaming PCM pipe");
            return null;
        }
        this.streamFifo = fifo;
        const command = this.streamPlayerCommand;
        const name = path.basename(command);
        const args =
            name === "aplay"
                ? [
                      "-q",
                      "-t",
                      "raw",
                      "-f",
                      "S16_LE",
                      "-r",
                      String(sampleRate),
                      "-c",
                      "1",
                      fifo,
                  ]
                : [
                      "-q",
                      "-t",
                      "raw",
                      "-r",
                      String(sampleRate),
                      "-c",
                      "1",
                      "-b",
                      "16",
                      "-e",
                      "signed-integer",
                      fifo,
                      "-t",
                      process.platform === "darwin" ? "coreaudio" : "alsa",
                      "default",
                  ];
        const child = spawn(command, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        this.player = child;
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        const sink = createWriteStream(fifo, { flags: "w" });
        this.streamSink = sink;
        sink.on("error", (err: Error) => {
            logger.debug(`Stream pipe closed: ${err.message}`);
        });
        const closed = new Promise<boolean>((resolve) => {
            child.on("error", () => {
                sink.destroy();
                resolve(false);
            });
            child.on("close", () => {
                sink.destroy();
                resolve(!this.playbackStopped);
            });
        });
        let writes: Promise<void> = Promise.resolve();
        let ended = false;

        const finish = async (): Promise<boolean> => {
            if (ended) {
                return closed;
            }
            ended = true;
            if (!this.playbackStopped) {
                await writes;
            }
            if (!sink.destroyed) {
                await new Promise<void>((resolve) => {
                    sink.once("close", () => resolve());
                    sink.once("error", () => resolve());
                    sink.end();
                });
            }
            const completed = await closed;
            if (this.player === child) {
                this.player = null;
            }
            if (this.streamSink === sink) {
                this.streamSink = null;
            }
            if (this.streamFifo === fifo) {
                this.streamFifo = null;
            }
            await unlink(fifo).catch(() => undefined);
            if (stderr.trim().length > 0 && !this.disposed) {
                logger.debug(`Stream player said: ${stderr.trim()}`);
            }
            return completed;
        };

        return {
            write: (chunk: Buffer): void => {
                if (ended || this.playbackStopped || sink.destroyed) {
                    return;
                }
                writes = writes
                    .then(
                        () =>
                            new Promise<void>((resolve) => {
                                if (sink.destroyed) {
                                    resolve();
                                    return;
                                }
                                try {
                                    if (sink.write(chunk)) {
                                        resolve();
                                        return;
                                    }
                                    const done = (): void => {
                                        sink.off("drain", done);
                                        sink.off("error", done);
                                        sink.off("close", done);
                                        resolve();
                                    };
                                    sink.once("drain", done);
                                    sink.once("error", done);
                                    sink.once("close", done);
                                } catch {
                                    resolve();
                                }
                            }),
                    )
                    .catch(() => {
                        // A killed player can break the pipe; `finish` still
                        // resolves as interrupted through `closed`.
                    });
            },
            end: finish,
        };
    }

    /** Plays a WAV file through the first available system player.
     *
     * @returns `true` when playback completed, `false` when it was stopped by
     *   a barge-in or disposal.
     */
    async playWav(file: string): Promise<boolean> {
        if (this.playerCommand === null) {
            logger.warn("No audio player available; skipping playback");
            return true;
        }
        if (this.disposed) {
            return false;
        }
        this.playbackStopped = false;
        const args =
            path.basename(this.playerCommand) === "afplay"
                ? [file]
                : ["-q", file];
        const child = spawn(this.playerCommand, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        this.player = child;
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        const completed = await new Promise<boolean>((resolve) => {
            child.on("error", () => resolve(false));
            child.on("close", () => resolve(!this.playbackStopped));
        });
        this.player = null;
        if (stderr.trim().length > 0 && !this.disposed) {
            logger.debug(`Player said: ${stderr.trim()}`);
        }
        return completed;
    }

    /** Writes and plays one streamed TTS turn's mono s16le PCM.
     *
     * @returns `true` when playback completed, `false` when interrupted.
     */
    async playPcm(pcm: Buffer, sampleRate: number): Promise<boolean> {
        if (pcm.length === 0) {
            return true;
        }
        const file = path.join(
            this.tempDir,
            `reply-${process.pid}-${Date.now()}.wav`,
        );
        try {
            await writeFile(file, pcmS16leToWav(pcm, sampleRate), {
                mode: 0o600,
            });
            return await this.playWav(file);
        } finally {
            await unlink(file).catch(() => undefined);
        }
    }

    /** Stops whichever child is active and makes future calls no-ops. */
    dispose(): void {
        this.disposed = true;
        if (this.recordTimer !== null) {
            clearTimeout(this.recordTimer);
            this.recordTimer = null;
        }
        this.stopRecording();
        this.stopPlayback();
        this.recorder = null;
        this.player = null;
        this.voice = null;
    }

    /**
     * Speaks text with the platform's local TTS. This is the offline fallback
     * used only when `JARVIS_SATELLITE_LOCAL_TTS=1` and the server sent no
     * audio; it is deliberately not the primary voice.
     *
     * @returns `true` when speech completed, `false` when interrupted.
     */
    async speak(text: string): Promise<boolean> {
        if (!this.localTts) {
            return true;
        }
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return true;
        }
        if (this.voiceCommand === null) {
            logger.warn(
                "Local TTS requested, but no `say`/`espeak` command was found",
            );
            return true;
        }
        if (this.disposed) {
            return false;
        }
        this.playbackStopped = false;
        const command = path.basename(this.voiceCommand);
        const args = command === "spd-say" ? ["-w", trimmed] : [trimmed];
        const child = spawn(this.voiceCommand, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        this.voice = child;
        const completed = await new Promise<boolean>((resolve) => {
            child.on("error", () => resolve(false));
            child.on("close", () => resolve(!this.playbackStopped));
        });
        this.voice = null;
        return completed;
    }
}
