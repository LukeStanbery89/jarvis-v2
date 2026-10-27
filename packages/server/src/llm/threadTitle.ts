/**
 * One-shot model title generation for a conversation (#122).
 *
 * This is a small, non-tool-bound call beside the chat model. It is
 * best-effort: a failure leaves the excerpt in place and a later completed
 * turn retries. It receives only the first user/assistant exchange and never
 * logs the prompt or the generated title.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatModel } from "./chatModel";
import type { GenerateTitle } from "../sessionTitle";

/** How much of each side of the exchange the title model sees. */
const MAX_TITLE_INPUT_CHARS = 1_200;

/** Extracts plain text from a message's string-or-blocks content. */
function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") {
                    return part;
                }
                if (
                    typeof part === "object" &&
                    part !== null &&
                    "text" in part &&
                    typeof (part as { text?: unknown }).text === "string"
                ) {
                    return (part as { text: string }).text;
                }
                return "";
            })
            .join("");
    }
    return "";
}

/** Keeps the title call's input bounded. */
function bounded(text: string | null): string {
    const value = text?.trim() ?? "";
    return value.length > MAX_TITLE_INPUT_CHARS
        ? `${value.slice(0, MAX_TITLE_INPUT_CHARS)}…`
        : value;
}

/**
 * Builds the title generator over the shared chat model.
 *
 * @returns A function accepting the first exchange and returning a raw title.
 */
export function createThreadTitleGenerator(): GenerateTitle {
    return async ({ user, assistant }) => {
        const model = createChatModel({ maxTokens: 48, temperature: 0.3 });
        const response = await model.invoke(
            [
                new SystemMessage(
                    "Name a chat conversation. Reply with only a short title, " +
                        "2 to 6 words, no quotes, no trailing punctuation, and " +
                        "no prefix such as 'Title:'.",
                ),
                new HumanMessage(
                    `User: ${bounded(user)}\n\nAssistant: ${bounded(assistant)}`,
                ),
            ],
            { signal: AbortSignal.timeout(15_000) },
        );
        const title = textOf(response.content).trim();
        return title === "" ? null : title;
    };
}
