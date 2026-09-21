import { afterEach, describe, expect, it } from "vitest";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildMessages } from "../src/llm/messages";

afterEach(() => {
    delete process.env.LLM_SYSTEM_PROMPT;
});

describe("buildMessages", () => {
    it("builds a [SystemMessage, HumanMessage] thread for a prompt", () => {
        const messages = buildMessages("hello");
        expect(messages).toHaveLength(2);
        expect(messages[0]).toBeInstanceOf(SystemMessage);
        expect(messages[1]).toEqual(new HumanMessage("hello"));
    });

    it("uses the configured system prompt as the opening message", () => {
        process.env.LLM_SYSTEM_PROMPT = "You are a pirate.";
        const messages = buildMessages("ahoy");
        expect(messages[0]).toEqual(new SystemMessage("You are a pirate."));
    });
});
