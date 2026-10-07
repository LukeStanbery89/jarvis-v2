/**
 * The response segmenter (issue #83, phase 2): turns the streamed token
 * feed of one agent turn into speakable segments — sentence-boundary
 * chunking plus a max-length flush so pathological input can never buffer
 * forever. Pure, engine-free, and cancellable by construction: the caller
 * feeds tokens and either drains a completed turn with {@link flush} or
 * drops the instance mid-turn (an aborted turn's un-emitted tail is simply
 * garbage-collected).
 *
 * This is the no-token-level-synthesis guarantee from the issue: TTS is
 * called per segment, never per token, so a provider's per-call overhead is
 * paid per sentence rather than per fragment.
 *
 * Boundary rules, tuned for latency over linguistics (a wrong split costs a
 * prosody pause; a missing split costs first-audio latency):
 *
 * - sentences end at `.` / `!` / `?`, optionally followed by closing
 *   quotes/brackets, when whitespace follows;
 * - a newline is always a boundary (paragraphs, list items);
 * - a terminator directly followed by a digit is a decimal, not a boundary
 *   ("3.5" survives; list markers "1." still split — they are alone);
 * - a terminator preceded by a known abbreviation ("Mr.", "e.g.") or a
 *   single capital initial ("Q.") is not a boundary — latency bias noted:
 *   a sentence that genuinely ends on one of these merges into the next;
 * - the buffer force-flushes at {@link DEFAULT_MAX_SEGMENT_CHARS} so an
 *   unpunctuated run cannot delay speech indefinitely.
 *
 * The input is the response's plain text. Voice-mode turns are answered in
 * plain conversational text server-side, so there is no markdown to
 * sanitize; incidental markup (a stray code fence) is inert text — it
 * splits on newlines and reads as written. Speakability filtering is the
 * orchestrator's concern (phase 3), not this class's.
 */
/** Default force-flush size for a boundary-free run, in characters. */
export const DEFAULT_MAX_SEGMENT_CHARS = 240;

/** Options for {@link ResponseSegmenter}. */
export interface ResponseSegmenterOptions {
    /** Force-flush size; default {@link DEFAULT_MAX_SEGMENT_CHARS}. */
    readonly maxChars?: number;
}

/** Sentence-terminal characters (run through closing marks to a boundary). */
const TERMINATORS = new Set([".", "!", "?"]);

/** Closing marks that may trail a terminator inside a boundary run. */
const CLOSERS = new Set(['"', "'", ")", "]", "»", "”", "’"]);

/** Whitespace that ends a boundary run. */
const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

/** Lowercased words after which a period is not a sentence end. */
const ABBREVIATIONS = new Set([
    "mr",
    "mrs",
    "ms",
    "dr",
    "prof",
    "st",
    "jr",
    "sr",
    "vs",
    "etc",
    "e.g",
    "i.e",
    "approx",
    "est",
    "ave",
    "blvd",
    "fig",
    "no",
    "capt",
    "sgt",
    "lt",
    "col",
    "gen",
    "rep",
    "sen",
    "gov",
    "rev",
    "hon",
    "inc",
    "ltd",
    "co",
    "dept",
    "univ",
]);

/**
 * One turn's text stream, accumulated and drained into speakable segments.
 * Cheap to construct; use one per turn.
 */
export class ResponseSegmenter {
    private buffer = "";
    private readonly maxChars: number;

    /**
     * @param options - Tuning; only `maxChars` exists today.
     */
    constructor(options: ResponseSegmenterOptions = {}) {
        this.maxChars = options.maxChars ?? DEFAULT_MAX_SEGMENT_CHARS;
    }

    /**
     * Feeds one streamed token and returns the segments it completed
     * (possibly none — tokens rarely finish a sentence).
     *
     * @param token - Raw streamed text (may be a word fragment).
     * @returns Newly completed, trimmed segments.
     */
    push(token: string): string[] {
        this.buffer += token;
        return this.drain(false);
    }

    /**
     * Ends the turn: flushes the unterminated tail as the final segment.
     * The instance is reusable afterwards (fresh turn, fresh buffer).
     *
     * @returns The remaining trimmed segments (empty when nothing was left).
     */
    flush(): string[] {
        return this.drain(true);
    }

    /**
     * Scans the buffer for boundaries and emits completed segments.
     *
     * @param final - True when the turn's text is over (treat end-of-buffer
     * as a boundary and drop nothing).
     * @returns Newly completed segments.
     */
    private drain(final: boolean): string[] {
        const out: string[] = [];
        let start = 0;
        let i = 0;
        scan: while (i < this.buffer.length) {
            const ch = this.buffer[i];
            if (ch === "\n") {
                // Newline: a paragraph/list break is a prosody break.
                this.emit(out, this.buffer.slice(start, i));
                start = i + 1;
                i += 1;
                continue;
            }
            if (!TERMINATORS.has(ch)) {
                i += 1;
                continue;
            }
            // Terminator: run through closing marks, then decide.
            let j = i + 1;
            while (j < this.buffer.length && CLOSERS.has(this.buffer[j])) {
                j += 1;
            }
            if (j >= this.buffer.length) {
                // Pending: the decision needs the next token (or the final
                // flush) — resume here once more text arrives.
                if (final) {
                    this.emit(out, this.buffer.slice(start, j));
                    start = j;
                    i = j;
                    continue;
                }
                break scan;
            }
            const next = this.buffer[j];
            if (!WHITESPACE.has(next)) {
                // Digit ("3.5") or letter ("U.S.") directly after: not a
                // boundary; keep scanning from the offending character.
                i = j;
                continue;
            }
            const split = !this.isFalseBoundary(start, i);
            if (split) {
                this.emit(out, this.buffer.slice(start, j));
                start = j;
            }
            // Consume the whitespace run either way: after a split it
            // belongs to the boundary; after an abbreviation it is plain
            // text the next emit will trim.
            while (j < this.buffer.length && WHITESPACE.has(this.buffer[j])) {
                j += 1;
            }
            i = j;
            if (split) {
                start = i;
            }
        }
        // Everything from `start` on is still un-emitted.
        const rest = this.buffer.slice(start);
        if (final) {
            this.buffer = "";
            this.emit(out, rest);
            return out;
        }
        if (rest.length >= this.maxChars) {
            // Force flush: a boundary-free run must not buffer forever. The
            // latency guard outranks the rare decimal it might split.
            this.buffer = "";
            this.emit(out, rest);
            return out;
        }
        this.buffer = rest;
        return out;
    }

    /**
     * Records one completed segment, skipping the empty ones (a boundary
     * against nothing — e.g. a blank line — emits nothing).
     *
     * @param out - The caller's accumulator.
     * @param segment - Raw segment text; trimmed here.
     */
    private emit(out: string[], segment: string): void {
        const trimmed = segment.trim();
        if (trimmed !== "") {
            out.push(trimmed);
        }
    }

    /**
     * Decides whether the terminator at `i` is a non-boundary: preceded by a
     * known abbreviation or a single capital initial (both measured against
     * the current segment, `start`).
     *
     * @param start - Segment start offset in the buffer.
     * @param i - Terminator offset.
     * @returns True when the period belongs to an abbreviation/initial.
     */
    private isFalseBoundary(start: number, i: number): boolean {
        let w = i;
        while (w > start) {
            const prev = this.buffer[w - 1];
            if (/[A-Za-z.]/.test(prev)) {
                w -= 1;
            } else {
                break;
            }
        }
        const word = this.buffer.slice(w, i);
        if (word.length === 1 && /[A-Z]/.test(word)) {
            return true;
        }
        return ABBREVIATIONS.has(word.toLowerCase());
    }
}
