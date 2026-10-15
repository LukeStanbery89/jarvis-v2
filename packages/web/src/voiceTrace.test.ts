/**
 * Tests for the raw-vs-submitted transcript trace (#121).
 *
 * The properties that matter: tracing is off unless explicitly switched on
 * (it prints real user speech), and the line makes an empty or
 * whitespace-only side visible instead of collapsing it.
 */
import { describe, expect, it } from "vitest";
import {
    VOICE_TRACE_KEY,
    VOICE_TRACE_PARAM,
    formatVoiceTrace,
    voiceTraceEnabled,
} from "./voiceTrace";

/** A minimal Storage double. */
function storageOf(value: string | null): Pick<Storage, "getItem"> {
    return { getItem: (key) => (key === VOICE_TRACE_KEY ? value : null) };
}

describe("voiceTraceEnabled", () => {
    it("is off by default", () => {
        expect(voiceTraceEnabled(storageOf(null), "")).toBe(false);
    });

    it("turns on from the storage flag", () => {
        expect(voiceTraceEnabled(storageOf("1"), "")).toBe(true);
    });

    it("turns on from the URL parameter", () => {
        expect(
            voiceTraceEnabled(storageOf(null), `?${VOICE_TRACE_PARAM}=1`),
        ).toBe(true);
    });

    it("is not fooled by another value", () => {
        expect(voiceTraceEnabled(storageOf("0"), "?debug=1")).toBe(false);
    });

    it("does not throw when storage is unavailable", () => {
        const throwing = {
            getItem: () => {
                throw new Error("denied");
            },
        };
        expect(voiceTraceEnabled(throwing, "")).toBe(false);
    });
});

describe("formatVoiceTrace", () => {
    it("keeps both sides visible, including an empty one", () => {
        expect(formatVoiceTrace("hey jarvis", "hey jarvis")).toBe(
            'raw="hey jarvis" submitted="hey jarvis"',
        );
        expect(formatVoiceTrace("hey jarvis", "")).toBe(
            'raw="hey jarvis" submitted=""',
        );
    });
});
