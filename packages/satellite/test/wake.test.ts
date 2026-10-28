import { describe, expect, it } from "vitest";
import { extractWakeCommand } from "../src/wake";

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
