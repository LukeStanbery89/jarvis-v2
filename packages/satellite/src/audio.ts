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
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeWav } from "@lukestanbery/jarvis-voice";
import { logger } from "./logger";
import { SAMPLE_RATE, type SatelliteConfig } from "./config";

/** A resolved audio tool, or the reason it is missing. */
export interface AudioToolStatus {
    capture: string | null;
    player: string | null;
    problems: string[];
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
    const player = findPlayer();
    const problems: string[] = [];
    if (capture === null) {
        problems.push(
            "`rec` was not found; install SoX (`brew install sox` or `sudo apt install sox`)",
        );
    }
    if (player === null) {
        problems.push(
            "no audio player was found; install SoX (`play`) or use a system player",
        );
    }
    return { capture, player, problems };
}

/** Audio I/O for one satellite process. */
export class AudioIO {
    private recorder: ChildProcess | null = null;
    private player: ChildProcess | null = null;
    private voice: ChildProcess | null = null;
    private readonly capture: string | null;
    private readonly playerCommand: string | null;
    private readonly voiceCommand: string | null;
    private readonly tempDir: string;
    /** Whether the reply should be spoken locally when the server sends none. */
    readonly localTts: boolean;
    private disposed = false;

    constructor(private readonly config: SatelliteConfig) {
        const status = checkAudioTools();
        this.capture = status.capture;
        this.playerCommand = status.player;
        this.voiceCommand = findLocalVoice();
        this.localTts = config.localTts;
        this.tempDir = path.join(config.stateDir, "tmp");
        mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
    }

    /** The tools resolved at construction, for `--check`. */
    getTools(): AudioToolStatus {
        return {
            capture: this.capture,
            player: this.playerCommand,
            problems: checkAudioTools().problems,
        };
    }

    /**
     * Records one utterance, starting when SoX sees speech and stopping after
     * the configured trailing silence. Returns the temporary WAV path, or
     * `null` when the recorder was stopped before it produced a file.
     */
    async recordUtterance(): Promise<string | null> {
        if (this.capture === null) {
            throw new Error(
                "`rec` is unavailable; install SoX before using microphone mode",
            );
        }
        if (this.disposed) {
            return null;
        }
        const file = path.join(
            this.tempDir,
            `utterance-${process.pid}-${Date.now()}.wav`,
        );
        const args = [
            "-q",
            "-c",
            "1",
            "-r",
            String(SAMPLE_RATE),
            "-b",
            "16",
            "-e",
            "signed-integer",
            "-t",
            "wav",
            file,
            "silence",
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
        const child = spawn(this.capture, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        this.recorder = child;
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        const exitCode = await new Promise<number | null>((resolve) => {
            child.on("error", () => resolve(null));
            child.on("close", (code) => resolve(code));
        });
        this.recorder = null;
        if (this.disposed) {
            await unlink(file).catch(() => undefined);
            return null;
        }
        if (exitCode !== 0 && exitCode !== null) {
            await unlink(file).catch(() => undefined);
            throw new Error(
                `rec failed (${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
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

    /** Plays a WAV file through the first available system player. */
    async playWav(file: string): Promise<void> {
        if (this.playerCommand === null) {
            logger.warn("No audio player available; skipping playback");
            return;
        }
        if (this.disposed) {
            return;
        }
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
        await new Promise<void>((resolve) => {
            child.on("error", () => resolve());
            child.on("close", () => resolve());
        });
        this.player = null;
        if (stderr.trim().length > 0 && !this.disposed) {
            logger.debug(`Player said: ${stderr.trim()}`);
        }
    }

    /** Writes and plays one streamed TTS turn's mono s16le PCM. */
    async playPcm(pcm: Buffer, sampleRate: number): Promise<void> {
        if (pcm.length === 0) {
            return;
        }
        const file = path.join(
            this.tempDir,
            `reply-${process.pid}-${Date.now()}.wav`,
        );
        try {
            await writeFile(file, pcmS16leToWav(pcm, sampleRate), {
                mode: 0o600,
            });
            await this.playWav(file);
        } finally {
            await unlink(file).catch(() => undefined);
        }
    }

    /** Stops whichever child is active and makes future calls no-ops. */
    dispose(): void {
        this.disposed = true;
        for (const child of [this.recorder, this.player, this.voice]) {
            if (child !== null && child.exitCode === null) {
                child.kill("SIGINT");
            }
        }
        this.recorder = null;
        this.player = null;
        this.voice = null;
    }

    /**
     * Speaks text with the platform's local TTS. This is the offline fallback
     * used only when `JARVIS_SATELLITE_LOCAL_TTS=1` and the server sent no
     * audio; it is deliberately not the primary voice.
     */
    async speak(text: string): Promise<void> {
        if (!this.localTts) {
            return;
        }
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return;
        }
        if (this.voiceCommand === null) {
            logger.warn(
                "Local TTS requested, but no `say`/`espeak` command was found",
            );
            return;
        }
        if (this.disposed) {
            return;
        }
        const command = path.basename(this.voiceCommand);
        const args = command === "spd-say" ? ["-w", trimmed] : [trimmed];
        const child = spawn(this.voiceCommand, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });
        this.voice = child;
        await new Promise<void>((resolve) => {
            child.on("error", () => resolve());
            child.on("close", () => resolve());
        });
        this.voice = null;
    }
}
