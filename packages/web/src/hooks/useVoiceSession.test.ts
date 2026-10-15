/**
 * Unit tests for the voice status-line text derivation and the barge-in
 * watch's arming window (#114).
 */
import { describe, expect, it } from "vitest";
import type { VoiceSnapshot, VoiceState } from "@lukestanbery/jarvis-voice";
import { voiceStatusText, watchBargeIn } from "./useVoiceSession";

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

describe("watchBargeIn", () => {
    it("arms from the response's first frame, before any audio (#114)", () => {
        // `responding` arrives at the first response frame — the tool *request*
        // of a tool turn — while `audioStart` (what used to arm the watch) can
        // be seconds later. The whole gap used to have no mic listener.
        expect(watchBargeIn("responding")).toBe(true);
        expect(watchBargeIn("speaking")).toBe(true);
    });

    it("stays off outside a response", () => {
        const off: VoiceState[] = [
            "idle",
            "listening",
            "transcribing",
            "submitting",
            "waiting",
        ];
        for (const state of off) {
            expect(watchBargeIn(state)).toBe(false);
        }
    });

    it("does not change across the responding → speaking step", () => {
        // The client keys its arming effect on this value, so equal values mean
        // one microphone open per turn rather than a re-arm mid-turn.
        expect(watchBargeIn("responding")).toBe(watchBargeIn("speaking"));
    });
});
