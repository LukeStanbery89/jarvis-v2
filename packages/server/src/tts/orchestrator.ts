/**
 * The audio orchestrator (issue #83, phase 3, milestone slice): streams one
 * turn's answer through the {@link ResponseSegmenter} and speaks it through
 * a {@link TtsProvider} — one sequential worker, segments in order, first
 * audio as soon as the first segment is ready (sentence boundaries by
 * default; clause boundaries under #89's granularity option).
 *
 * Deliberately wire-agnostic: the caller (ws.ts) supplies the sink that
 * turns callbacks into frames/messages, so this module stays testable
 * without a socket. Guarantees:
 *
 * - synthesis never runs per token — segments only;
 * - one synthesis in flight at a time, results delivered in segment order;
 * - `audioStart` fires lazily, once, before the first PCM (a turn with no
 *   speakable text never emits any audio callbacks);
 * - a synthesis failure fails the turn's audio quietly (the text stream is
 *   untouched — audio is a presentation layer); the `audioError` frame is
 *   a later #83 phase, for now the sink simply never receives `audioEnd`
 *   and the client's turn still ends normally via `done`;
 * - `abort()` drops everything pending immediately (turn timeout, socket
 *   closed, model failure) — in-flight engine work cannot be interrupted,
 *   so the caller discards its result via the sink never being called.
 */
import { ResponseSegmenter } from "./segmenter";
import type { SegmentGranularity } from "./segmenter";
import type { TtsProvider } from "./types";

/**
 * The wire sink one turn's audio streams through, in order. Implementations
 * turn these calls into `audioStart` / binary / `audioEnd` messages — or
 * test assertions.
 */
export interface AudioTurnSink {
    /**
     * Sent once, before the first PCM chunk.
     *
     * @param sampleRate - Sample rate of every PCM chunk this turn.
     */
    audioStart(sampleRate: number): void;
    /** One synthesized segment's mono float PCM. */
    audio(pcm: Float32Array): void;
    /** Sent once, after the last PCM chunk (never after a failure). */
    audioEnd(): void;
}

/** One turn's speakable stream: feed tokens, finish or abort. */
export interface AudioTurn {
    /**
     * Feeds one streamed token; completed sentence segments are queued for
     * synthesis and spoken in order as the engine frees up.
     *
     * @param token - Raw streamed text (may be a word fragment).
     */
    push(token: string): void;
    /**
     * Ends the turn's text: flushes the segmenter's tail, speaks everything
     * remaining, emits `audioEnd`, and resolves when the queue is drained
     * (or failed).
     *
     * @returns Resolves once all audio for the turn has been sent.
     */
    finish(): Promise<void>;
    /**
     * Cancels the turn's audio: drops the queued segments; nothing more is
     * synthesized or delivered. In-flight synthesis still completes inside
     * the engine — its result is discarded.
     */
    abort(): void;
}

/** Tuning for {@link speakTurn}. */
export interface SpeakTurnOptions {
    /**
     * Segmenter granularity (#89); default `"sentence"`. `"clause"` adds
     * comma/semicolon boundaries so the first PCM lands earlier.
     */
    readonly granularity?: SegmentGranularity;
    /**
     * Called once, when the turn's first segment is queued — the moment
     * the text was complete enough to start synthesis. Callers (#83 phase
     * 6) timestamp it against the turn's first token for the TTFA line.
     */
    readonly onFirstSegment?: () => void;
}

/**
 * Streams one turn's answer into speech.
 *
 * @param provider - The TTS engine.
 * @param sink - Where the ordered audio goes.
 * @param onError - Called once when synthesis fails; the turn's audio ends
 *   without `audioEnd` (the text stream is never disturbed).
 * @param options - Granularity + first-segment callback (see
 *   {@link SpeakTurnOptions}).
 * @returns The turn handle to feed.
 */
export function speakTurn(
    provider: TtsProvider,
    sink: AudioTurnSink,
    onError?: (err: unknown) => void,
    options: SpeakTurnOptions = {},
): AudioTurn {
    const segmenter = new ResponseSegmenter({
        granularity: options.granularity,
    });
    /** Segments waiting for the (single) synthesis worker. */
    const queue: string[] = [];
    let finished = false;
    let failed = false;
    /** Set once `audioEnd` has gone out — audio for the turn is over. */
    let ended = false;
    let pumping = false;
    let started = false;
    let inFlight: Promise<void> = Promise.resolve();
    let firstSegmentSeen = false;

    /**
     * Queues completed segments; fires {@link SpeakTurnOptions.onFirstSegment}
     * exactly once, when the first one lands.
     *
     * @param segments - Newly completed segments from the segmenter.
     */
    function enqueue(segments: string[]): void {
        for (const segment of segments) {
            queue.push(segment);
            if (!firstSegmentSeen) {
                firstSegmentSeen = true;
                options.onFirstSegment?.();
            }
        }
    }

    /** Drains the queue sequentially; safe to call repeatedly. */
    function pump(): Promise<void> {
        if (pumping) {
            return inFlight;
        }
        pumping = true;
        inFlight = (async () => {
            try {
                while (queue.length > 0 && !failed) {
                    const segment = queue.shift()!;
                    try {
                        const speech = await provider.synthesize(segment);
                        if (!started) {
                            started = true;
                            sink.audioStart(speech.sampleRate);
                        }
                        sink.audio(speech.pcm);
                    } catch (err) {
                        failed = true;
                        onError?.(err);
                        break;
                    }
                }
                if (finished && !failed && !ended && queue.length === 0) {
                    if (started) {
                        sink.audioEnd();
                    }
                    ended = true;
                }
            } finally {
                pumping = false;
            }
        })();
        return inFlight;
    }

    return {
        push(token: string): void {
            if (finished || failed || ended) {
                return;
            }
            enqueue(segmenter.push(token));
            void pump();
        },
        finish(): Promise<void> {
            if (failed) {
                return Promise.resolve();
            }
            enqueue(segmenter.flush());
            finished = true;
            return pump();
        },
        abort(): void {
            failed = true;
            queue.length = 0;
        },
    };
}
