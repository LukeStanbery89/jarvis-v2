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
import type { ClientCapability } from "@lukestanbery/jarvis-protocol";

describe("systemPromptForCapabilities", () => {
    it("keeps the base persona and appends tool rules for a plain-text client", () => {
        const prompt = systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, []);
        expect(prompt).toContain(DEFAULT_SYSTEM_PROMPT);
        expect(prompt).toMatch(/exactly one tool call at a time/);
        expect(prompt).toMatch(/make exactly\s+one getCurrentTime call/);
        expect(prompt).not.toMatch(/renders the following/);
    });

    it("appends the tool rules to every conditioned prompt", () => {
        const variants: ClientCapability[][] = [
            [],
            ["markdown"],
            ["html", "link"],
        ];
        for (const capabilities of variants) {
            const prompt = systemPromptForCapabilities(
                DEFAULT_SYSTEM_PROMPT,
                capabilities,
            );
            expect(prompt).toMatch(/exactly one tool call at a time/);
            expect(prompt).toMatch(/make exactly\s+one getCurrentTime call/);
        }
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

    it("appends the spoken-word directive for voice-mode turns (#83)", () => {
        const prompt = systemPromptForCapabilities(
            DEFAULT_SYSTEM_PROMPT,
            [],
            "voice",
        );
        expect(prompt).toContain(DEFAULT_SYSTEM_PROMPT);
        expect(prompt).toMatch(/read aloud by a text-to-speech engine/);
        expect(prompt).toMatch(/Use no parentheses or brackets/);
        expect(prompt).toMatch(/Spell out every abbreviation/);
        // The fixed hygiene rules still apply to voice turns.
        expect(prompt).toMatch(/exactly one tool call at a time/);
    });

    it("keeps text-mode prompts free of the spoken-word directive", () => {
        const text = systemPromptForCapabilities(
            DEFAULT_SYSTEM_PROMPT,
            ["markdown"],
            "text",
        );
        const plain = systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, []);
        for (const prompt of [text, plain]) {
            expect(prompt).not.toMatch(/text-to-speech engine/);
            expect(prompt).not.toMatch(/Use no parentheses or brackets/);
        }
        // Voice scoping is per-turn: a text-mode turn on a voice thread
        // renders richly again.
        expect(text).toMatch(/Markdown is rendered/);
    });
});
