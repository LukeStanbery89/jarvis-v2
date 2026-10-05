/**
 * Constructs the chat model used across the service.
 *
 * Exactly two modules know about `@langchain/openai`: this one for the chat
 * path, and `visionModel.ts` for the image-analysis path (every other layer
 * deals with the model instances they return). Points at an
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
