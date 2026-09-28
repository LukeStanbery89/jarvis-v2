/**
 * Unit tests for the agent seam's pure helpers.
 *
 * `runAgent` itself talks to the model stack and is exercised end-to-end by
 * the WebSocket suite (through its mock); here we pin the capability
 * conditioning rules that turn a plain-text system prompt into a
 * capability-aware one, since those are pure string transforms that would
 * otherwise only be observable under a live model.
 */
import { describe, expect, it } from "vitest";
import { systemPromptForCapabilities } from "../src/agent";
import { DEFAULT_SYSTEM_PROMPT } from "../src/config";

describe("systemPromptForCapabilities", () => {
    it("returns the base prompt verbatim for a plain-text client", () => {
        expect(systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, [])).toBe(
            DEFAULT_SYSTEM_PROMPT,
        );
    });

    it("appends formatting guidance for a markdown-capable client", () => {
        const prompt = systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, [
            "markdown",
        ]);
        expect(prompt).toContain(DEFAULT_SYSTEM_PROMPT);
        expect(prompt).toMatch(/Markdown is rendered/);
        expect(prompt).not.toMatch(/Images render/);
    });

    it("notes images and hyperlinks only when declared", () => {
        const prompt = systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, [
            "image",
            "link",
        ]);
        expect(prompt).toMatch(/Images render/);
        expect(prompt).toMatch(/Hyperlinks render/);
        expect(prompt).not.toMatch(/Markdown is rendered/);
    });

    it("advertises raw HTML rendering when the client declares it", () => {
        const prompt = systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, [
            "html",
        ]);
        expect(prompt).toMatch(/HTML is rendered/);
    });

    it("preserves the base persona alongside full capability guidance", () => {
        const prompt = systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, [
            "markdown",
            "html",
            "image",
            "link",
        ]);
        expect(prompt).toContain("Never use emojis to convey emotion");
        expect(prompt).toContain(
            "The conversation client renders the following",
        );
    });
});
