import { afterEach, describe, expect, it } from "vitest";
import { getLlmConfig } from "../src/config";

const DEFAULT_SYSTEM_PROMPT =
    "You are Jarvis, a helpful, personal AI assistant. " +
    "Answer directly and concisely; avoid unnecessary verbosity, markup, " +
    "and preamble.";

afterEach(() => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_TEMPERATURE;
    delete process.env.LLM_SYSTEM_PROMPT;
});

describe("getLlmConfig", () => {
    it("returns the local LM Studio defaults", () => {
        expect(getLlmConfig()).toEqual({
            baseUrl: "http://localhost:1234/v1",
            model: "qwen/qwen3-4b-2507",
            temperature: 0,
            streamUsage: false,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
        });
    });

    it("honours LLM_BASE_URL and LLM_MODEL overrides", () => {
        process.env.LLM_BASE_URL = "http://example.com/v1";
        process.env.LLM_MODEL = "my-model";
        expect(getLlmConfig()).toMatchObject({
            baseUrl: "http://example.com/v1",
            model: "my-model",
        });
    });

    it("honours LLM_TEMPERATURE and LLM_SYSTEM_PROMPT overrides", () => {
        process.env.LLM_TEMPERATURE = "0.7";
        process.env.LLM_SYSTEM_PROMPT = "You are a pirate.";
        expect(getLlmConfig()).toMatchObject({
            temperature: 0.7,
            systemPrompt: "You are a pirate.",
        });
    });
});
