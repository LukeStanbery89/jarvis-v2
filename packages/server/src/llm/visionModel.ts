/**
 * The vision-language model boundary for image analysis (#10).
 *
 * The ONE module that constructs a second `ChatOpenAI` for the VL model —
 * just as `chatModel.ts` is the only module that knows `@langchain/openai`
 * for the chat path, this is the only one that knows it for image analysis.
 * The two models differ in every knob that matters: the chat model streams
 * tokens for the client, this one runs a single blocking call whose text
 * result goes back to the agent as a tool result.
 *
 * Reasoning models (the default VL model is one) return their chain-of-thought
 * in a separate `reasoning_content` field; that is deliberately **discarded**
 * — it never reaches the conversation, the client, or the logs.
 *
 * Every call is bounded by an `AbortSignal` combining the caller's signal
 * (the agent turn's) with a wall-clock timeout, so a hung inference server
 * cannot hold a tool call — and therefore a turn's per-thread lock — past the
 * configured budget (review finding R4).
 */
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import type { LlmConfig } from "../config";
import { logger } from "../logger";

/**
 * The analysis seam the `analyzeImage` tool consumes.
 *
 * Kept as an interface so tests substitute a fake without touching an HTTP
 * endpoint (and the tool module stays decoupled from `@langchain/openai`).
 */
export interface VisionModel {
    /**
     * Analyzes one image for `query`, returning the model's text answer.
     *
     * `dataUrl` is a `data:` URL (`data:image/png;base64,…`) carrying the
     * image; `signal` aborts the call when the surrounding turn gives up.
     * Throws on transport or runtime failure — the caller maps that onto
     * user-safe text.
     */
    analyze(
        dataUrl: string,
        query: string,
        signal?: AbortSignal,
    ): Promise<string>;
}

/**
 * Builds the VL model seam from `config`.
 *
 * The returned model is intentionally un-streamed (`invoke`, never `stream`):
 * the analysis is one tool result, not a client-facing token stream.
 */
export function createVisionModel(config: LlmConfig): VisionModel {
    const model = new ChatOpenAI({
        // Local LM Studio ignores the key; a fixed placeholder satisfies the
        // OpenAI SDK's credential check (same posture as chatModel.ts).
        apiKey: "lm-studio",
        modelName: config.vlModel,
        temperature: 0,
        maxTokens: config.vlMaxTokens,
        configuration: { baseURL: config.baseUrl },
        // Same posture as the chat model: local endpoints do not reliably
        // emit token-usage metadata.
        streamUsage: false,
    });

    return {
        async analyze(dataUrl, query, signal) {
            const timeout = AbortSignal.timeout(config.vlTimeoutMs);
            const combined = signal
                ? AbortSignal.any([signal, timeout])
                : timeout;
            logger.debug(`VL analysis call (${config.vlModel})`);
            const response = await model.invoke(
                [
                    new HumanMessage({
                        content: [
                            { type: "text", text: query },
                            { type: "image_url", image_url: { url: dataUrl } },
                        ],
                    }),
                ],
                { signal: combined },
            );
            // Reasoning models put chain-of-thought in `additional_kwargs
            // .reasoning_content`; `.content` is the final answer. Extracting
            // text parts only means reasoning can never leak into the result.
            const content = response.content;
            if (typeof content === "string") {
                return content.trim();
            }
            const text = content
                .filter(
                    (part): part is { type: "text"; text: string } =>
                        typeof part === "object" &&
                        part !== null &&
                        (part as { type?: string }).type === "text",
                )
                .map((part) => part.text)
                .join("");
            return text.trim();
        },
    };
}
