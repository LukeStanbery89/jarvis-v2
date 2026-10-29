import { describe, expect, it } from "vitest";
import { extractWakeCommand, resolveWakeUtterance } from "../src/wake";

describe("extractWakeCommand", () => {
    it("strips the exact wake phrase and keeps the command", () => {
        expect(
            extractWakeCommand("Hey JARVIS, what's the weather today?"),
        ).toBe("what's the weather today?");
    });

    it("strips a mangled wake phrase", () => {
        expect(extractWakeCommand("he jarvis, tell me a joke")).toBe(
            "tell me a joke",
        );
    });

    it("accepts the name without the interjection", () => {
        expect(extractWakeCommand("Jarvis, stop the timer")).toBe(
            "stop the timer",
        );
    });

    it("finds a wake phrase after a leading filler", () => {
        expect(extractWakeCommand("um, hey jarvis, set a timer")).toBe(
            "set a timer",
        );
    });

    it("returns an empty command when only the wake phrase was heard", () => {
        expect(extractWakeCommand("Hey JARVIS")).toBe("");
    });

    it("ignores speech that does not address JARVIS", () => {
        expect(extractWakeCommand("what is the weather?")).toBeNull();
        expect(extractWakeCommand("")).toBeNull();
    });
});

describe("resolveWakeUtterance", () => {
    it("requires the wake phrase outside a follow-up window", () => {
        expect(
            resolveWakeUtterance("Hey JARVIS, what time is it?", false),
        ).toEqual({ kind: "command", command: "what time is it?" });
        expect(resolveWakeUtterance("Hey JARVIS", false)).toEqual({
            kind: "wait",
        });
        expect(resolveWakeUtterance("what time is it?", false)).toEqual({
            kind: "ignore",
        });
    });

    it("accepts a command without the wake phrase during follow-up", () => {
        expect(resolveWakeUtterance("what time is it?", true)).toEqual({
            kind: "command",
            command: "what time is it?",
        });
    });

    it("strips a wake phrase during follow-up", () => {
        expect(
            resolveWakeUtterance("Hey JARVIS, what time is it?", true),
        ).toEqual({ kind: "command", command: "what time is it?" });
    });

    it("re-arms the wake wait for a wake-only follow-up", () => {
        expect(resolveWakeUtterance("Hey JARVIS", true)).toEqual({
            kind: "wait",
        });
    });

    it("ignores empty transcripts even during follow-up", () => {
        expect(resolveWakeUtterance("", true)).toEqual({ kind: "ignore" });
    });
});
