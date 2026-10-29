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
    /** Called when the segmenter confirms that someone started speaking. */
    onSpeechStart?: () => void;
    /** Called when the recorder cannot start or exits before `stop()`. */
    onError: (error: Error) => void;
}

/**
 * One long-lived SoX capture process plus a speech segmenter.
 *
 * The recorder stays open for the whole wake loop so the first phoneme of “Hey
 * JARVIS …” is captured even after a turn. Audio that arrives while a callback
 * is running is still segmented and queued, so a command spoken during
 * transcription is not lost. Playback mutes the segmenter through
 * {@link setMuted} to keep the reply out of the microphone.
 */
export class StreamingCapture {
    private child: ChildProcess | null = null;
    private readonly segmenter: SpeechSegmenter;
    private readonly sox: string | null;
    private readonly capture: string | null;
    private readonly driver: string;
    private readonly queue: Float32Array[] = [];
    private carry = Buffer.alloc(0);
    private busy = false;
    private muted = false;
    private stopped = false;
    private readonly maxQueuedUtterances = 4;

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
            onSpeechStart: () => {
                this.callbacks.onSpeechStart?.();
            },
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
        this.queue.length = 0;
        this.segmenter.reset();
    }

    /**
     * Drops microphone input while the reply is playing.
     *
     * The recorder remains open; this only resets the segmenter so a partially
     * captured sentence or the reply itself cannot become the next utterance.
     */
    setMuted(muted: boolean): void {
        if (this.muted === muted) {
            return;
        }
        this.muted = muted;
        this.carry = Buffer.alloc(0);
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
        if (this.stopped || this.muted) {
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
        for (const utterance of completed) {
            if (this.busy) {
                // A callback is transcribing the previous utterance. Keep this
                // one, bounded, so a command spoken during transcription is not
                // lost. Playback mutes the segmenter, so the reply never lands
                // here.
                if (this.queue.length >= this.maxQueuedUtterances) {
                    this.queue.shift();
                }
                this.queue.push(utterance);
                continue;
            }
            this.busy = true;
            void this.emit(utterance);
        }
    }

    /** Runs the callback, then takes the next queued utterance. */
    private async emit(pcm: Float32Array): Promise<void> {
        try {
            await this.callbacks.onUtterance(pcm);
        } catch (error) {
            logger.error(
                `Utterance handler failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            const next = this.queue.shift();
            if (next !== undefined) {
                void this.emit(next);
            } else {
                this.busy = false;
            }
        }
    }
}
