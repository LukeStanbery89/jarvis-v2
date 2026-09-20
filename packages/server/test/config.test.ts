import { afterEach, describe, expect, it } from "vitest";
import { getLlmConfig } from "../src/config";

afterEach(() => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
});

describe("getLlmConfig", () => {
    it("returns the local LM Studio defaults", () => {
        expect(getLlmConfig()).toEqual({
            baseUrl: "http://localhost:1234/v1",
            model: "qwen/qwen3-4b-2507",
        });
    });

    it("honours LLM_BASE_URL and LLM_MODEL overrides", () => {
        process.env.LLM_BASE_URL = "http://example.com/v1";
        process.env.LLM_MODEL = "my-model";
        expect(getLlmConfig()).toEqual({
            baseUrl: "http://example.com/v1",
            model: "my-model",
        });
    });
});
