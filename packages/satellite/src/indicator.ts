/**
 * Visual feedback for the voice prompt lifecycle.
 *
 * The terminal implementation is a small spinner on stderr; stdout stays
 * reserved for the transcript and the reply. Real satellite hardware should
 * implement the same {@link VisualIndicator} interface with an LED, ring, or
 * display, and can be composed with the terminal spinner through
 * {@link CompositeVisualIndicator}.
 */
import type { Writable } from "node:stream";

/** A sink that can show whether the satellite is actively listening. */
export interface VisualIndicator {
    /** Turns the listening indication on or off. */
    setListening(listening: boolean): void;
    /** Releases timers and clears the indication. */
    dispose(): void;
}

/** A no-op indicator for non-TTY runs and tests. */
export class NullVisualIndicator implements VisualIndicator {
    setListening(): void {
        // Nothing to render.
    }

    dispose(): void {
        // Nothing to release.
    }
}

/** One terminal spinner frame, oldest first. */
const FRAMES = ["|", "/", "-", "\\"] as const;

/**
 * A single-line spinner rendered to stderr.
 *
 * The spinner is disabled by {@link createVisualIndicator} when stderr is not a
 * TTY, so piped logs and systemd captures stay clean.
 */
export class TerminalSpinner implements VisualIndicator {
    private timer: NodeJS.Timeout | null = null;
    private frame = 0;

    constructor(
        private readonly stream: Writable,
        private readonly label = "Listening…",
    ) {}

    setListening(listening: boolean): void {
        if (listening) {
            if (this.timer !== null) {
                return;
            }
            this.frame = 0;
            this.render();
            this.timer = setInterval(() => {
                this.render();
            }, 100);
            this.timer.unref?.();
            return;
        }
        if (this.timer === null) {
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
        this.stream.write("\r\x1b[2K");
    }

    dispose(): void {
        this.setListening(false);
    }

    private render(): void {
        const frame = FRAMES[this.frame % FRAMES.length]!;
        this.frame += 1;
        this.stream.write(`\r${frame} ${this.label}`);
    }
}

/** Fans one indication out to several outputs (terminal + LED, for example). */
export class CompositeVisualIndicator implements VisualIndicator {
    constructor(private readonly indicators: readonly VisualIndicator[]) {}

    setListening(listening: boolean): void {
        for (const indicator of this.indicators) {
            indicator.setListening(listening);
        }
    }

    dispose(): void {
        for (const indicator of this.indicators) {
            indicator.dispose();
        }
    }
}

/**
 * Creates the target-appropriate indicator.
 *
 * A headless service or a piped local run gets nothing; an interactive terminal
 * gets the spinner. Hardware installers can replace this factory with a
 * composite that adds their LED implementation.
 */
export function createVisualIndicator(
    stream: Writable & { isTTY?: boolean } = process.stderr,
): VisualIndicator {
    if (stream.isTTY !== true) {
        return new NullVisualIndicator();
    }
    return new TerminalSpinner(stream);
}
