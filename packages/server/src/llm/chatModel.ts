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

/** The two chat-model roles in the agent (#214). */
export type ChatModelRole = "writer" | "router";

/** Per-instance overrides for the one-off model calls (titles, etc.). */
export interface ChatModelOptions {
    /** Which model role to construct; defaults to the writer. */
    role?: ChatModelRole;
    /** Output-token cap override; defaults to the role's config. */
    maxTokens?: number;
    /** Sampling-temperature override; defaults to the role's config. */
    temperature?: number;
}

/**
 * Constructs a chat model for one role.
 *
 * The writer is the existing `LLM_MODEL` and keeps the old defaults, so an
 * unset router leaves every call path byte-for-byte unchanged. The router is
 * the optional `LLM_ROUTER_MODEL`; it is only constructed when configured,
 * so a missing router model is a configuration error at the one call site
 * that enables the split rather than a silent fallback at runtime.
 *
 * @param options - Role and per-instance overrides.
 * @returns The configured OpenAI-compatible chat model.
 * @throws When `role: "router"` is requested without `LLM_ROUTER_MODEL`.
 */
export function createChatModel(options: ChatModelOptions = {}): ChatOpenAI {
    const config = getLlmConfig();
    const role = options.role ?? "writer";
    const model = role === "router" ? config.routerModel : config.model;
    if (model === undefined) {
        throw new Error(
            "LLM_ROUTER_MODEL is not configured; cannot create the router model",
        );
    }
    const temperature =
        options.temperature ??
        (role === "router" ? config.routerTemperature : config.temperature);
    const maxTokens =
        options.maxTokens ??
        (role === "router"
            ? config.routerMaxTokens
            : config.chatMaxOutputTokens);
    return new ChatOpenAI({
        model,
        temperature,
        maxTokens,
        apiKey: "lm-studio",
        streamUsage: config.streamUsage,
        configuration: { baseURL: config.baseUrl },
    });
}

/** Convenience constructor for the optional tool-routing model (#214). */
export function createRouterChatModel(
    options: Omit<ChatModelOptions, "role"> = {},
): ChatOpenAI {
    return createChatModel({ ...options, role: "router" });
}
