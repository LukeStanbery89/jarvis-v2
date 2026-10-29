import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Writable } from "node:stream";
import {
    CompositeVisualIndicator,
    NullVisualIndicator,
    TerminalSpinner,
    createVisualIndicator,
} from "../src/indicator";

/** Captures writes without needing a real terminal. */
class FakeStream {
    isTTY = true;
    readonly writes: string[] = [];

    write(chunk: string): boolean {
        this.writes.push(chunk);
        return true;
    }
}

/** The spinner only needs the writable surface. */
function asWritable(stream: FakeStream): Writable {
    return stream as unknown as Writable;
}

describe("TerminalSpinner", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("writes a frame while listening and clears on stop", () => {
        const stream = new FakeStream();
        const spinner = new TerminalSpinner(asWritable(stream));

        spinner.setListening(true);
        expect(stream.writes.join("")).toContain("Listening…");
        const before = stream.writes.length;
        vi.advanceTimersByTime(250);
        expect(stream.writes.length).toBeGreaterThan(before);

        spinner.setListening(false);
        expect(stream.writes[stream.writes.length - 1]).toContain("\r");
        expect(stream.writes[stream.writes.length - 1]).toContain("\x1b[2K");
        spinner.dispose();
    });

    it("does not write when stopped without starting", () => {
        const stream = new FakeStream();
        const spinner = new TerminalSpinner(asWritable(stream));
        spinner.setListening(false);
        expect(stream.writes).toHaveLength(0);
    });
});

describe("visual indicator factory", () => {
    it("uses a no-op indicator when stderr is not a TTY", () => {
        const stream = new FakeStream();
        stream.isTTY = false;
        const indicator = createVisualIndicator(
            stream as unknown as Writable & { isTTY?: boolean },
        );
        expect(indicator).toBeInstanceOf(NullVisualIndicator);
    });

    it("uses the terminal spinner on a TTY", () => {
        const stream = new FakeStream();
        const indicator = createVisualIndicator(
            stream as unknown as Writable & { isTTY?: boolean },
        );
        expect(indicator).toBeInstanceOf(TerminalSpinner);
        indicator.dispose();
    });
});

describe("CompositeVisualIndicator", () => {
    it("fans listening state out to every output", () => {
        const first = new FakeStream();
        const second = new FakeStream();
        const composite = new CompositeVisualIndicator([
            new TerminalSpinner(asWritable(first)),
            new TerminalSpinner(asWritable(second)),
        ]);

        composite.setListening(true);
        expect(first.writes.join("")).toContain("Listening…");
        expect(second.writes.join("")).toContain("Listening…");
        composite.dispose();
        expect(first.writes[first.writes.length - 1]).toContain("\x1b[2K");
        expect(second.writes[second.writes.length - 1]).toContain("\x1b[2K");
    });
});
