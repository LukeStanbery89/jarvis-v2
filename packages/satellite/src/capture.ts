/**
 * Continuous microphone capture for the wake loop.
 *
 * The first satellite slice opened a new SoX recorder for every utterance.
 * That is fine for push-to-talk, but wrong for “Hey JARVIS …”: the mic is
 * closed while the previous turn runs, and reopening it can miss the first
 * word. This class keeps one raw PCM stream open for the life of the wake loop,
 * feeds it to {@link SpeechSegmenter}, and hands complete utterances to the
 * caller.
 *
 * The process is the same SoX dependency as `audio.ts`; no native addon is
 * introduced. Playback still lives in `AudioIO`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { checkAudioTools } from "./audio";
import { SAMPLE_RATE, type SatelliteConfig } from "./config";
import { logger } from "./logger";
import { SpeechSegmenter } from "./vad";

/** What the wake loop does with a completed utterance. */
export interface StreamingCaptureCallbacks {
    /** Called once per utterance with mono float PCM at {@link SAMPLE_RATE}. */
    onUtterance: (pcm: Float32Array) => Promise<void> | void;
    /** Called when the recorder cannot start or exits before `stop()`. */
    onError: (error: Error) => void;
}

/**
 * One long-lived SoX capture process plus a speech segmenter.
 *
 * While a callback is running the incoming stream is deliberately discarded:
 * the reply is being generated or spoken, and transcribing the speaker's own
 * voice would create a loop. The recorder itself stays open, so the next “Hey
 * JARVIS” is captured immediately when the callback returns.
 */
export class StreamingCapture {
    private child: ChildProcess | null = null;
    private readonly segmenter: SpeechSegmenter;
    private readonly sox: string | null;
    private readonly capture: string | null;
    private readonly driver: string;
    private carry = Buffer.alloc(0);
    private busy = false;
    private stopped = false;

    constructor(
        private readonly config: SatelliteConfig,
        private readonly callbacks: StreamingCaptureCallbacks,
    ) {
        const tools = checkAudioTools();
        this.sox = tools.sox;
        this.capture = tools.capture;
        this.driver = process.platform === "darwin" ? "coreaudio" : "alsa";
        this.segmenter = new SpeechSegmenter({
            threshold: config.vadThreshold,
            onsetMs: config.vadOnsetMs,
            silenceMs: config.vadSilenceMs,
            preRollMs: config.vadPreRollMs,
            maxUtteranceMs: config.vadMaxUtteranceMs,
            sampleRate: SAMPLE_RATE,
        });
    }

    /**
     * Opens the microphone and starts segmenting. Throws when SoX is missing or
     * the selected device cannot be launched; the wake loop reports that and
     * exits rather than silently listening to nothing.
     */
    start(): void {
        if (this.child !== null || this.stopped) {
            return;
        }
        const command =
            this.config.inputDevice !== undefined ? this.sox : this.capture;
        if (command === null) {
            throw new Error(
                this.config.inputDevice !== undefined
                    ? "`sox` is unavailable; install SoX or unset JARVIS_SATELLITE_INPUT_DEVICE"
                    : "`rec` is unavailable; install SoX before using wake mode",
            );
        }
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
        const args =
            this.config.inputDevice !== undefined
                ? [
                      "-q",
                      "-t",
                      this.driver,
                      this.config.inputDevice,
                      ...formatArgs,
                      "-t",
                      "raw",
                      "-",
                  ]
                : ["-q", ...formatArgs, "-t", "raw", "-"];
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.stdout?.on("data", (chunk: Buffer) => {
            this.onData(chunk);
        });
        child.on("error", (error) => {
            this.fail(error);
        });
        child.on("exit", (code) => {
            if (this.stopped) {
                return;
            }
            const detail = stderr.trim();
            this.fail(
                new Error(
                    `audio capture stopped (${code ?? "no code"})${detail.length > 0 ? `: ${detail}` : ""}`,
                ),
            );
        });
    }

    /** Closes the microphone and makes future callbacks no-ops. */
    stop(): void {
        this.stopped = true;
        const child = this.child;
        this.child = null;
        if (child !== null && child.exitCode === null) {
            child.kill("SIGINT");
            const killTimer = setTimeout(() => {
                if (child.exitCode === null) {
                    child.kill("SIGKILL");
                }
            }, 500);
            killTimer.unref();
        }
        this.segmenter.reset();
    }

    /** Reports a recorder failure once, then closes the stream. */
    private fail(error: Error): void {
        if (this.stopped) {
            return;
        }
        this.stop();
        this.callbacks.onError(error);
    }

    /** Converts one raw chunk to int16 and feeds the segmenter. */
    private onData(chunk: Buffer): void {
        if (this.stopped || this.busy) {
            return;
        }
        const buffer =
            this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
        const sampleCount = Math.floor(buffer.length / 2);
        if (sampleCount === 0) {
            this.carry = Buffer.from(buffer);
            return;
        }
        const samples = new Int16Array(sampleCount);
        for (let i = 0; i < sampleCount; i += 1) {
            samples[i] = buffer.readInt16LE(i * 2);
        }
        this.carry = Buffer.from(buffer.subarray(sampleCount * 2));
        const completed = this.segmenter.feed(samples);
        if (completed.length === 0) {
            return;
        }
        // The segmenter emits in order, but a turn owns the microphone until it
        // returns. Process one at a time; newer audio waits in the pipe, and
        // anything spoken while busy is intentionally ignored.
        const [utterance] = completed;
        if (utterance === undefined) {
            return;
        }
        this.busy = true;
        void this.emit(utterance);
    }

    /** Runs the callback, then resumes capture with a clean segmenter. */
    private async emit(pcm: Float32Array): Promise<void> {
        try {
            await this.callbacks.onUtterance(pcm);
        } catch (error) {
            logger.error(
                `Utterance handler failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            this.segmenter.reset();
            this.busy = false;
        }
    }
}
