import OpenAI from "openai";
import { getLlmConfig } from "./config";

/**
 * Streams the model's response tokens for a prompt by calling the configured
 * OpenAI-compatible endpoint (LM Studio by default) with streaming enabled.
 *
 * This is the LLM → server side of the pipeline: it pulls content deltas from
 * the model as they arrive and yields each non-empty token. Throws if the
 * request fails or the stream errors mid-way.
 */
export async function* streamLlmResponse(
    prompt: string,
): AsyncGenerator<string> {
    console.info(`[INFO] Streaming LLM response for prompt: ${prompt}`);
    const { baseUrl, model } = getLlmConfig();
    // LM Studio ignores the key; the SDK still requires a non-empty one.
    const llm = new OpenAI({ baseURL: baseUrl, apiKey: "lm-studio" });

    const stream = await llm.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
    });

    for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content;
        if (token) {
            yield token;
        }
    }
}
