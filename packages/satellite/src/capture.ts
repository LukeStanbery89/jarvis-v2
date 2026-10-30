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
import { BargeInDetector, SpeechSegmenter } from "./vad";

/** Normalized RMS for a chunk of int16 samples. */
function samplesRms(samples: Int16Array): number {
    if (samples.length === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const sample = (samples[i] ?? 0) / 32768;
        sum += sample * sample;
    }
    return Math.sqrt(sum / samples.length);
}

/** What the wake loop does with a completed utterance. */
export interface StreamingCaptureCallbacks {
    /** Called once per utterance with mono float PCM at {@link SAMPLE_RATE}. */
    onUtterance: (pcm: Float32Array) => Promise<void> | void;
    /** Called when the segmenter confirms that someone started speaking. */
    onSpeechStart?: () => void;
    /** Called when sustained speech interrupts playback. */
    onBargeIn?: () => void;
    /** Called when the recorder cannot start or exits before `stop()`. */
    onError: (error: Error) => void;
}

/**
 * One long-lived SoX capture process plus a speech segmenter.
 *
 * The recorder stays open for the whole wake loop so the first phoneme of “Hey
 * JARVIS …” is captured even after a turn. Audio that arrives while a callback
 * is running is still segmented and queued, so a command spoken during
 * transcription is not lost. During playback, a separate barge-in detector
 * watches for sustained speech; when it fires, the short pre-roll seeds the
 * normal segmenter so the interruption is transcribed, and the caller stops the
 * player.
 */
export class StreamingCapture {
    private child: ChildProcess | null = null;
    private readonly segmenter: SpeechSegmenter;
    private readonly bargeDetector: BargeInDetector | null;
    private readonly bargePreRollSamples: number;
    private readonly bargeRing: Int16Array[] = [];
    private readonly sox: string | null;
    private readonly capture: string | null;
    private readonly driver: string;
    private readonly queue: Float32Array[] = [];
    private carry = Buffer.alloc(0);
    private bargeRingSamples = 0;
    private bargePeakRms = 0;
    private busy = false;
    private playbackActive = false;
    private inputMuted = false;
    private stopped = false;
    private readonly maxQueuedUtterances = 1;

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
        this.bargeDetector = config.bargeInEnabled
            ? new BargeInDetector({
                  threshold: config.bargeInThreshold,
                  onsetMs: config.bargeInMs,
                  sampleRate: SAMPLE_RATE,
              })
            : null;
        this.bargePreRollSamples = Math.round(
            (SAMPLE_RATE * config.bargeInPreRollMs) / 1000,
        );
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
        this.bargeRing.length = 0;
        this.bargeRingSamples = 0;
        this.bargeDetector?.reset();
        this.segmenter.reset();
    }

    /**
     * Arms the barge-in watch while the reply is playing.
     *
     * The recorder remains open. In this state the normal segmenter is not fed
     * (the reply would become an utterance); instead the barge detector watches
     * for louder, sustained speech. A trigger seeds the normal segmenter with
     * the recent pre-roll and calls {@link StreamingCaptureCallbacks.onBargeIn}.
     */
    setPlaybackActive(active: boolean): void {
        if (this.playbackActive === active) {
            return;
        }
        this.playbackActive = active;
        this.bargeDetector?.reset();
        this.bargeRing.length = 0;
        this.bargeRingSamples = 0;
        if (active) {
            this.bargePeakRms = 0;
        } else if (this.bargePeakRms > 0) {
            logger.debug(
                `Barge watch peak RMS ${this.bargePeakRms.toFixed(4)} (threshold ${this.config.bargeInThreshold})`,
            );
        }
        this.segmenter.reset();
    }

    /**
     * Drops microphone input for a local cue (the lifecycle chimes).
     *
     * This is separate from {@link setPlaybackActive}: a chime is not a reply,
     * so it must not arm barge-in or become an utterance. It is short enough
     * that discarding the few hundred milliseconds it plays is preferable to
     * hearing the cue in the next transcript.
     */
    setInputMuted(muted: boolean): void {
        if (this.inputMuted === muted) {
            return;
        }
        this.inputMuted = muted;
        this.carry = Buffer.alloc(0);
        this.segmenter.reset();
    }

    /** Drops any completed-but-not-yet-processed utterance. */
    discardQueued(): void {
        this.queue.length = 0;
    }

    /** Reports a recorder failure once, then closes the stream. */
    private fail(error: Error): void {
        if (this.stopped) {
            return;
        }
        this.stop();
        this.callbacks.onError(error);
    }

    /** Converts one raw chunk to int16 and feeds the active detector. */
    private onData(chunk: Buffer): void {
        if (this.stopped || this.inputMuted) {
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
        if (this.playbackActive) {
            this.onPlaybackData(samples);
            return;
        }
        const completed = this.segmenter.feed(samples);
        for (const utterance of completed) {
            if (this.busy) {
                // A callback is transcribing or playing the previous turn.
                // Keep only the newest utterance: a barge-in or a replacement
                // prompt should supersede stale queued speech.
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

    /** Watches for a barge-in and seeds the segmenter when one fires. */
    private onPlaybackData(samples: Int16Array): void {
        const detector = this.bargeDetector;
        if (detector === null) {
            return;
        }
        const level = samplesRms(samples);
        this.bargePeakRms = Math.max(this.bargePeakRms, level);
        this.bargeRing.push(samples.slice());
        this.bargeRingSamples += samples.length;
        while (
            this.bargeRingSamples > this.bargePreRollSamples &&
            this.bargeRing.length > 0
        ) {
            const dropped = this.bargeRing.shift();
            if (dropped === undefined) {
                break;
            }
            this.bargeRingSamples -= dropped.length;
        }
        if (!detector.feed(samples)) {
            return;
        }

        // The detector has confirmed sustained speech. Stop treating playback
        // as authoritative, replay the recent ring into the normal segmenter,
        // then ask the caller to kill the player. Keep only the onset window:
        // the older ring is mostly the reply leaking into the microphone.
        const seed = this.trimBargeSeed(this.concatBargeRing());
        logger.debug(
            `Barge-in trigger at RMS ${level.toFixed(4)} (threshold ${this.config.bargeInThreshold})`,
        );
        this.playbackActive = false;
        detector.reset();
        this.bargeRing.length = 0;
        this.bargeRingSamples = 0;
        this.segmenter.reset();
        if (seed.length > 0) {
            this.segmenter.feed(seed);
        }
        this.callbacks.onBargeIn?.();
    }

    /** Keeps the barge seed to the speech that caused the trigger. */
    private trimBargeSeed(seed: Int16Array): Int16Array {
        const maxSamples = Math.round(
            (SAMPLE_RATE * (this.config.bargeInMs + 100)) / 1000,
        );
        if (seed.length <= maxSamples) {
            return seed;
        }
        return seed.slice(seed.length - maxSamples);
    }

    /** Concatenates the barge-in pre-roll ring into one PCM buffer. */
    private concatBargeRing(): Int16Array {
        const total = this.bargeRing.reduce(
            (sum, chunk) => sum + chunk.length,
            0,
        );
        const out = new Int16Array(total);
        let offset = 0;
        for (const chunk of this.bargeRing) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
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
