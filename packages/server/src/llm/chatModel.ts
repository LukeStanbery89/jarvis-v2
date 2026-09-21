/**
 * Constructs the chat model used across the service.
 *
 * This is the only module that knows about `@langchain/openai`; every other
 * layer deals with the `ChatOpenAI` instance it returns. Points at an
 * OpenAI-compatible endpoint (LM Studio by default). LM Studio ignores the
 * API key, but the provider still requires a non-empty one.
 */
import { ChatOpenAI } from "@langchain/openai";
import { getLlmConfig } from "../config";

export function createChatModel(): ChatOpenAI {
    const { baseUrl, model, temperature, streamUsage } = getLlmConfig();
    return new ChatOpenAI({
        model,
        temperature,
        apiKey: "lm-studio",
        streamUsage,
        configuration: { baseURL: baseUrl },
    });
}
