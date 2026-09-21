/**
 * Runs a single chat turn: streams the model's response tokens for a prompt.
 *
 * This is the sole seam between the WebSocket transport and the model stack;
 * `ws.ts` imports nothing else from the provider layer. Today it is a plain
 * model stream; when LangGraph lands, this body becomes the graph's model
 * node and the async-generator contract stays stable for `ws.ts`.
 */
import { createChatModel } from "./llm/chatModel";
import { buildMessages } from "./llm/messages";

const chatModel = createChatModel();

export async function* runAgent(prompt: string): AsyncGenerator<string> {
    console.info(`[INFO] Streaming LLM response for prompt: ${prompt}`);
    const stream = await chatModel.stream(buildMessages(prompt));
    for await (const chunk of stream) {
        const token = typeof chunk.content === "string" ? chunk.content : "";
        if (token) {
            yield token;
        }
    }
}
