/**
 * Response segmenter tests (issue #83, phase 2).
 *
 * The matrix the phase names: short answers, long text, unpunctuated runs,
 * code fences and lists (inert text — newlines split), numbers (decimals
 * survive; list markers split), abbreviations/initials, quotes, streamed
 * token boundaries (terminators split across pushes), interruption
 * (drop-without-flush), and reuse after flush.
 */
import { describe, expect, it } from "vitest";
import {
    DEFAULT_MAX_SEGMENT_CHARS,
    ResponseSegmenter,
} from "../src/tts/segmenter";

/** Feeds text as irregular token fragments, returning all segments. */
function segmentTokens(text: string, maxChars?: number): string[] {
    const segmenter = new ResponseSegmenter(
        maxChars === undefined ? {} : { maxChars },
    );
    const out: string[] = [];
    // Cut the text into jagged fragments (deterministically) so tokens
    // split words and even boundary sequences mid-way.
    for (let i = 0; i < text.length; i += 3) {
        out.push(...segmenter.push(text.slice(i, i + 3)));
    }
    out.push(...segmenter.flush());
    return out;
}

/** Feeds text as one big token (no mid-boundary splits). */
function segmentWhole(text: string, maxChars?: number): string[] {
    const segmenter = new ResponseSegmenter(
        maxChars === undefined ? {} : { maxChars },
    );
    return [...segmenter.push(text), ...segmenter.flush()];
}

describe("basics", () => {
    it("emits a short answer as one segment", () => {
        expect(segmentWhole("Sure.")).toEqual(["Sure."]);
    });

    it("splits sentences and trims whitespace", () => {
        expect(segmentWhole("Hello there.  How can I help?\nAll set!")).toEqual(
            ["Hello there.", "How can I help?", "All set!"],
        );
    });

    it("is insensitive to token boundaries (fragments, even mid-terminator)", () => {
        expect(segmentTokens("The cat sat on the mat. It purred.")).toEqual([
            "The cat sat on the mat.",
            "It purred.",
        ]);
    });

    it("skips empty tokens and blank lines", () => {
        const segmenter = new ResponseSegmenter();
        expect(segmenter.push("")).toEqual([]);
        expect(segmenter.push("   ")).toEqual([]);
        expect(segmenter.push("One.\n\nTwo.\n")).toEqual(["One.", "Two."]);
        expect(segmenter.flush()).toEqual([]);
    });

    it("flushes an unterminated tail and stays reusable", () => {
        const segmenter = new ResponseSegmenter();
        expect(segmenter.push("First sentence. tail without a dot")).toEqual([
            "First sentence.",
        ]);
        expect(segmenter.flush()).toEqual(["tail without a dot"]);
        // A trailing terminator stays pending (the decision needs the next
        // character) — the next turn's flush collects it.
        expect(segmenter.push("Next turn works.")).toEqual([]);
        expect(segmenter.flush()).toEqual(["Next turn works."]);
    });

    it("declares the default force-flush size", () => {
        expect(DEFAULT_MAX_SEGMENT_CHARS).toBe(240);
    });
});

describe("numbers", () => {
    it("keeps decimals whole, even across token boundaries", () => {
        expect(segmentWhole("It costs 3.5 dollars. Next thing.")).toEqual([
            "It costs 3.5 dollars.",
            "Next thing.",
        ]);
        expect(segmentTokens("It costs 3.5 dollars.")).toEqual([
            "It costs 3.5 dollars.",
        ]);
    });

    it("splits list markers (they stand alone)", () => {
        expect(segmentWhole("1. Turn it on\n2. Wait a moment")).toEqual([
            "1.",
            "Turn it on",
            "2.",
            "Wait a moment",
        ]);
    });

    it("does not treat 3.14-prefixed section text as a boundary", () => {
        expect(segmentWhole("See section 3.14 for details. Done.")).toEqual([
            "See section 3.14 for details.",
            "Done.",
        ]);
    });
});

describe("abbreviations and initials", () => {
    it("does not split after a title", () => {
        expect(segmentWhole("Mr. Smith arrived. He waved.")).toEqual([
            "Mr. Smith arrived.",
            "He waved.",
        ]);
    });

    it("does not split inside dotted abbreviations", () => {
        expect(segmentWhole("Use e.g. this pattern. Done.")).toEqual([
            "Use e.g. this pattern.",
            "Done.",
        ]);
    });

    it("does not split after a single capital initial", () => {
        expect(segmentWhole("John Q. Public called. Twice.")).toEqual([
            "John Q. Public called.",
            "Twice.",
        ]);
    });
});

describe("quotes and closers", () => {
    it("keeps closing quotes inside the segment", () => {
        expect(segmentWhole('He said "Go." Then left.')).toEqual([
            'He said "Go."',
            "Then left.",
        ]);
    });
});

describe("long and pathological input", () => {
    it("force-flushes an unpunctuated run at maxChars", () => {
        const run = "word ".repeat(20).trim(); // 100 chars, no boundary
        const segments = segmentWhole(run + " tail", 50);
        // The run exceeds 50 chars with no boundary: force-flushed whole.
        expect(segments).toEqual([`${run} tail`]);
    });

    it("keeps draining normal sentences past the max (boundaries win)", () => {
        const text = "First. Second. Third.";
        expect(segmentWhole(text, 5)).toEqual(["First.", "Second.", "Third."]);
    });

    it("handles a code fence as inert text (newlines split)", () => {
        const code = "```python\ndef f():\n    return 1\n```";
        expect(segmentWhole(code)).toEqual([
            "```python",
            "def f():",
            "return 1",
            "```",
        ]);
    });
});

describe("interruption", () => {
    it("emitted segments survive a dropped, never-flushed turn", () => {
        const segmenter = new ResponseSegmenter();
        const emitted: string[] = [];
        for (const token of ["First one. ", "Second one", " never"]) {
            emitted.push(...segmenter.push(token));
        }
        expect(emitted).toEqual(["First one."]);
        // The turn is aborted: the segmenter is simply discarded — no
        // flush, nothing else to drive. The tail is garbage-collected.
        void segmenter;
    });
});
