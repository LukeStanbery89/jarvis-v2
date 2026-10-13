/**
 * Unit tests for the voice status-line text derivation.
 */
import { describe, expect, it } from "vitest";
import type { VoiceSnapshot } from "@lukestanbery/jarvis-voice";
import { voiceStatusText } from "./useVoiceSession";

/** A voice snapshot with idle defaults; override the state under test. */
function snap(over: Partial<VoiceSnapshot>): VoiceSnapshot {
    return {
        state: "idle",
        sessionId: 0,
        transcript: null,
        partial: null,
        error: null,
        wakeArmed: false,
        ...over,
    };
}

describe("voiceStatusText", () => {
    it("shows the live partial while listening", () => {
        expect(
            voiceStatusText(snap({ state: "listening", partial: "hello" })),
        ).toBe("hello");
    });

    it("falls back to Listening… with no partial", () => {
        expect(voiceStatusText(snap({ state: "listening" }))).toBe(
            "Listening…",
        );
    });

    it("maps the transitional stages", () => {
        expect(voiceStatusText(snap({ state: "transcribing" }))).toBe(
            "Transcribing…",
        );
        expect(voiceStatusText(snap({ state: "submitting" }))).toBe("Sending…");
        expect(voiceStatusText(snap({ state: "waiting" }))).toBe("Thinking…");
    });

    it("hides the line once the response is visible or nothing is happening", () => {
        expect(voiceStatusText(snap({ state: "responding" }))).toBeNull();
        expect(voiceStatusText(snap({ state: "speaking" }))).toBeNull();
        expect(voiceStatusText(snap({ state: "idle" }))).toBeNull();
    });
});
