import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_AGENT_MAX_TURNS,
    DEFAULT_LLM_BASE_URL,
    DEFAULT_LLM_MODEL,
    DEFAULT_LLM_TEMPERATURE,
    DEFAULT_SYSTEM_PROMPT,
    defaultCheckpointPath,
    getLlmConfig,
} from "../src/config";

afterEach(() => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_TEMPERATURE;
    delete process.env.LLM_SYSTEM_PROMPT;
    delete process.env.JARVIS_AGENT_MAX_TURNS;
    delete process.env.JARVIS_CHECKPOINT_PATH;
});

describe("getLlmConfig", () => {
    it("returns the local LM Studio defaults", () => {
        expect(getLlmConfig()).toEqual({
            baseUrl: DEFAULT_LLM_BASE_URL,
            model: DEFAULT_LLM_MODEL,
            temperature: DEFAULT_LLM_TEMPERATURE,
            streamUsage: false,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            agentMaxTurns: DEFAULT_AGENT_MAX_TURNS,
            checkpointPath: defaultCheckpointPath(),
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

    it("honours JARVIS_AGENT_MAX_TURNS and JARVIS_CHECKPOINT_PATH overrides", () => {
        process.env.JARVIS_AGENT_MAX_TURNS = "4";
        process.env.JARVIS_CHECKPOINT_PATH = "/tmp/jarvis-test.db";
        expect(getLlmConfig()).toMatchObject({
            agentMaxTurns: 4,
            checkpointPath: "/tmp/jarvis-test.db",
        });
    });
});
