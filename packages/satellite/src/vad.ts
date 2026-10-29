/**
 * Energy-based speech segmentation for the wake loop.
 *
 * SoX's `silence` effect is fine for a one-shot push-to-talk capture, but a
 * production satellite cannot stop and restart the recorder between turns: the
 * mic would be closed when the user starts “Hey JARVIS …”. This class consumes
 * a continuous 16 kHz mono stream, keeps a pre-roll ring so the first phoneme is
 * never lost, and emits one utterance after a trailing-silence window.
 *
 * It is intentionally pure: no clocks, no I/O, and no SoX. Tests feed frames
 * directly. The capture process in `capture.ts` is the only caller.
 */

/** Options for {@link SpeechSegmenter}. */
export interface SpeechSegmenterOptions {
    /** Normalized RMS threshold, `0.01` ≈ SoX's 1% threshold. */
    readonly threshold: number;
    /** Speech needed before an utterance starts. */
    readonly onsetMs?: number;
    /** Silence needed before an utterance ends. */
    readonly silenceMs?: number;
    /** Audio retained before the onset, so the first word survives. */
    readonly preRollMs?: number;
    /** Hard cap on one utterance. */
    readonly maxUtteranceMs?: number;
    /** Analysis frame size. */
    readonly frameMs?: number;
    /** Capture sample rate; the microphone path is 16 kHz. */
    readonly sampleRate?: number;
    /** Called when enough speech has arrived to confirm an utterance onset. */
    readonly onSpeechStart?: () => void;
}

/** Converts an interleaved mono int16 frame sequence to float PCM. */
function toFloat(frames: readonly Int16Array[]): Float32Array {
    const total = frames.reduce((sum, frame) => sum + frame.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) {
        for (let i = 0; i < frame.length; i += 1) {
            out[offset] = frame[i]! / 32768;
            offset += 1;
        }
    }
    return out;
}

/** Normalized RMS for one frame of int16 samples. */
function frameRms(frame: Int16Array): number {
    if (frame.length === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) {
        const sample = frame[i]! / 32768;
        sum += sample * sample;
    }
    return Math.sqrt(sum / frame.length);
}

/**
 * Turns a continuous PCM stream into utterances.
 *
 * The pre-roll ring is the important part for the wake phrase: when onset is
 * confirmed, the utterance starts with the frames that preceded confirmation,
 * not with the frame after it.
 */
export class SpeechSegmenter {
    private readonly frameSamples: number;
    private readonly onsetFrames: number;
    private readonly silenceFrames: number;
    private readonly preRollFrames: number;
    private readonly maxFrames: number;
    private pending = new Int16Array(0);
    private readonly ring: Int16Array[] = [];
    private utterance: Int16Array[] = [];
    private speaking = false;
    private aboveFrames = 0;
    private belowFrames = 0;

    constructor(private readonly options: SpeechSegmenterOptions) {
        if (!(options.threshold > 0)) {
            throw new Error("SpeechSegmenter threshold must be positive");
        }
        const sampleRate = options.sampleRate ?? 16_000;
        const frameMs = options.frameMs ?? 20;
        this.frameSamples = Math.max(
            1,
            Math.round((sampleRate * frameMs) / 1000),
        );
        this.onsetFrames = Math.max(
            1,
            Math.ceil((options.onsetMs ?? 150) / frameMs),
        );
        this.silenceFrames = Math.max(
            1,
            Math.ceil((options.silenceMs ?? 800) / frameMs),
        );
        this.preRollFrames = Math.max(
            this.onsetFrames,
            Math.ceil((options.preRollMs ?? 1_000) / frameMs),
        );
        this.maxFrames = Math.max(
            this.preRollFrames + 1,
            Math.ceil((options.maxUtteranceMs ?? 15_000) / frameMs),
        );
    }

    /**
     * Feeds arbitrary-sized int16 chunks.
     *
     * @returns Completed utterances, in order. Usually zero or one; a large
     *   chunk can contain more than one.
     */
    feed(samples: Int16Array): Float32Array[] {
        if (samples.length === 0) {
            return [];
        }
        const combined = new Int16Array(this.pending.length + samples.length);
        combined.set(this.pending);
        combined.set(samples, this.pending.length);
        const completed: Float32Array[] = [];
        let offset = 0;
        while (combined.length - offset >= this.frameSamples) {
            const frame = combined.slice(offset, offset + this.frameSamples);
            const result = this.pushFrame(frame);
            if (result !== null) {
                completed.push(result);
            }
            offset += this.frameSamples;
        }
        this.pending = combined.slice(offset);
        return completed;
    }

    /** Drops any in-progress utterance and pre-roll; used on shutdown. */
    reset(): void {
        this.pending = new Int16Array(0);
        this.ring.length = 0;
        this.utterance = [];
        this.speaking = false;
        this.aboveFrames = 0;
        this.belowFrames = 0;
    }

    /** Processes one fixed-size frame. */
    private pushFrame(frame: Int16Array): Float32Array | null {
        const rms = frameRms(frame);
        if (!this.speaking) {
            this.ring.push(frame);
            if (this.ring.length > this.preRollFrames) {
                this.ring.shift();
            }
            if (rms >= this.options.threshold) {
                this.aboveFrames += 1;
                if (this.aboveFrames >= this.onsetFrames) {
                    this.speaking = true;
                    this.belowFrames = 0;
                    this.aboveFrames = 0;
                    // Let the capture layer timestamp the onset before it
                    // knows the utterance's completion time. Follow-up
                    // windows must be judged against when speech started, not
                    // when Whisper finished a second later.
                    this.options.onSpeechStart?.();
                    // `ring` already contains the onset frames and their
                    // pre-roll; copy it before clearing the ring, because the
                    // utterance must keep the frames the ring is about to drop.
                    this.utterance = this.ring.slice();
                    this.ring.length = 0;
                }
            } else {
                this.aboveFrames = 0;
            }
            return null;
        }

        this.utterance.push(frame);
        if (rms < this.options.threshold) {
            this.belowFrames += 1;
        } else {
            this.belowFrames = 0;
        }
        if (
            this.belowFrames >= this.silenceFrames ||
            this.utterance.length >= this.maxFrames
        ) {
            const completed = toFloat(this.utterance);
            this.utterance = [];
            this.speaking = false;
            this.belowFrames = 0;
            this.aboveFrames = 0;
            return completed;
        }
        return null;
    }
}

/** Options for {@link BargeInDetector}. */
export interface BargeInDetectorOptions {
    /** Normalized RMS threshold; louder than the normal wake VAD. */
    readonly threshold: number;
    /** Sustained speech needed before the detector fires. */
    readonly onsetMs?: number;
    /** Analysis frame size. */
    readonly frameMs?: number;
    /** Capture sample rate; the microphone path is 16 kHz. */
    readonly sampleRate?: number;
}

/**
 * Detects sustained speech during TTS playback.
 *
 * This is deliberately separate from {@link SpeechSegmenter}: it only answers
 * “is the user talking loudly enough, for long enough, to interrupt?” It does
 * not emit an utterance. The capture layer seeds its normal segmenter with a
 * short pre-roll when this fires, so the interruption is transcribed too.
 */
export class BargeInDetector {
    private readonly frameSamples: number;
    private readonly onsetFrames: number;
    private pending = new Int16Array(0);
    private aboveFrames = 0;
    private fired = false;

    constructor(private readonly options: BargeInDetectorOptions) {
        if (!(options.threshold > 0)) {
            throw new Error("BargeInDetector threshold must be positive");
        }
        const sampleRate = options.sampleRate ?? 16_000;
        const frameMs = options.frameMs ?? 20;
        this.frameSamples = Math.max(
            1,
            Math.round((sampleRate * frameMs) / 1000),
        );
        this.onsetFrames = Math.max(
            1,
            Math.ceil((options.onsetMs ?? 300) / frameMs),
        );
    }

    /**
     * Feeds a chunk and returns `true` exactly once, when sustained speech has
     * crossed the threshold. Call {@link reset} before the next playback.
     */
    feed(samples: Int16Array): boolean {
        if (this.fired || samples.length === 0) {
            return false;
        }
        const combined = new Int16Array(this.pending.length + samples.length);
        combined.set(this.pending);
        combined.set(samples, this.pending.length);
        let offset = 0;
        while (combined.length - offset >= this.frameSamples) {
            const frame = combined.slice(offset, offset + this.frameSamples);
            offset += this.frameSamples;
            if (frameRms(frame) >= this.options.threshold) {
                this.aboveFrames += 1;
                if (this.aboveFrames >= this.onsetFrames) {
                    this.fired = true;
                    this.pending = combined.slice(offset);
                    return true;
                }
            } else {
                this.aboveFrames = 0;
            }
        }
        this.pending = combined.slice(offset);
        return false;
    }

    /** Clears the candidate and arms the detector for another playback. */
    reset(): void {
        this.pending = new Int16Array(0);
        this.aboveFrames = 0;
        this.fired = false;
    }
}
