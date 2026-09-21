/**
 * Builds the message thread for a chat request.
 *
 * Every request is currently a fresh single-turn thread: a system prompt
 * primes the model's persona, then the user's prompt follows. Multi-turn
 * history (the conversation state that implies) is deferred to the LangGraph
 * phase; this is the single place the thread shape is defined.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getLlmConfig } from "../config";

export function buildMessages(prompt: string): BaseMessage[] {
    return [
        new SystemMessage(getLlmConfig().systemPrompt),
        new HumanMessage(prompt),
    ];
}
