/**
 * `stripWakePhrase` tests.
 *
 * The function decides what a wake-session transcript keeps: it must strip
 * the phrase the wake detector provably heard, keep every other transcript
 * untouched, and — the empty-transcript edge — reduce a phrase-only
 * recognition to `""` so the controller's empty-guard drops it silently.
 */
import { describe, expect, it } from "vitest";
import { stripWakePhrase } from "../src/index";

describe("stripWakePhrase", () => {
    it("strips a leading phrase leaving the command", () => {
        expect(
            stripWakePhrase(
                "Hey JARVIS, turn on the living room light",
                "Hey JARVIS",
            ),
        ).toBe("turn on the living room light");
    });

    it("is case-insensitive on the phrase", () => {
        expect(
            stripWakePhrase("hey jarvis turn on the light", "Hey JARVIS"),
        ).toBe("turn on the light");
        expect(
            stripWakePhrase("HEY JARVIS turn the heat off", "hey jarvis"),
        ).toBe("turn the heat off");
    });

    it("collapses internal phrase whitespace", () => {
        expect(
            stripWakePhrase("Hey   JARVIS tell me a joke", "Hey JARVIS"),
        ).toBe("tell me a joke");
    });

    it("strips separator punctuation after the phrase", () => {
        expect(
            stripWakePhrase("Hey JARVIS! open the garage", "Hey JARVIS"),
        ).toBe("open the garage");
        expect(stripWakePhrase("Hey JARVIS— call sophie", "Hey JARVIS")).toBe(
            "call sophie",
        );
    });

    it("strips a single trailing interjection", () => {
        expect(
            stripWakePhrase("Hey JARVIS, um, turn on the lights", "Hey JARVIS"),
        ).toBe("turn on the lights");
        expect(
            stripWakePhrase("hey jarvis like what time is it", "Hey JARVIS"),
        ).toBe("what time is it");
    });

    it("leaves transcripts that never heard the phrase untouched", () => {
        expect(stripWakePhrase("turn on the light", "Hey JARVIS")).toBe(
            "turn on the light",
        );
        expect(
            stripWakePhrase("jarvis just a word mid-text", "Hey JARVIS"),
        ).toBe("jarvis just a word mid-text");
        // A phrase formed mid-string must not be stripped.
        expect(stripWakePhrase("say hey JARVIS to me", "Hey JARVIS")).toBe(
            "say hey JARVIS to me",
        );
    });

    it("strips common ASR manglings of the phrase (fuzzy fallback)", () => {
        // The local engine's real-world mishearings of "Hey JARVIS" —
        // without this the mangled phrase rides into the prompt
        // ("he jarvis how's the weather" went out verbatim).
        expect(
            stripWakePhrase("he jarvis how's the weather", "Hey JARVIS"),
        ).toBe("how's the weather");
        expect(
            stripWakePhrase("he jarvis, what time is it", "Hey JARVIS"),
        ).toBe("what time is it");
        expect(stripWakePhrase("he jarvis", "Hey JARVIS")).toBe("");
        // A token nothing like the phrase word refuses the strip — a
        // genuine command starting with a similar shape is untouched.
        expect(stripWakePhrase("he drove is what i hello", "Hey JARVIS")).toBe(
            "he drove is what i hello",
        );
        // Only the phrase's leading positions match: a fuzzy pair later in
        // the string is not a wake phrase.
        expect(stripWakePhrase("please he jarvis for me", "Hey JARVIS")).toBe(
            "please he jarvis for me",
        );
    });

    it("reduces a phrase-only transcript to an empty string", () => {
        expect(stripWakePhrase("Hey JARVIS", "Hey JARVIS")).toBe("");
        expect(stripWakePhrase("hey jarvis!", "Hey JARVIS")).toBe("");
    });

    it("passes through empty inputs and an empty phrase", () => {
        expect(stripWakePhrase("", "Hey JARVIS")).toBe("");
        expect(stripWakePhrase("   ", "Hey JARVIS")).toBe("   ");
        expect(stripWakePhrase("turn on the light", "")).toBe(
            "turn on the light",
        );
        expect(stripWakePhrase("turn on the light", "   ")).toBe(
            "turn on the light",
        );
    });
});
