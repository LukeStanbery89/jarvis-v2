/**
 * LangGraph agent: tools, tool-call loops, and persisted conversation context.
 *
 * `createAgentGraph` builds a StateGraph with a model node (the configured
 * chat model bound to the tool registry) and a ToolNode, looping through the
 * tools whenever the model emits tool calls, and finishing when it answers
 * with plain text. `streamAgentTurn` runs one turn on a thread identified by
 * `sessionId` and emits a structured event stream (text tokens, tool calls,
 * tool results) so transports never need to know how the agent works.
 *
 * Context persistence comes from the checkpointer: every turn is saved keyed
 * by `sessionId` as the LangGraph thread id, so later turns see the full
 * message history ("persisted context between messages").
 */
import type { BaseMessage } from "@langchain/core/messages";
import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import {
    MessagesAnnotation,
    StateGraph,
    END,
    START,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolCallTracker } from "./toolCallTracker";
import type { AgentEvent } from "./toolCallTracker";

export type { AgentEvent } from "./toolCallTracker";

/**
 * Concrete compiled-graph type used across the agent layer.
 *
 * Derived from `createAgentGraph` so the LangGraph generic parameter list
 * (currently a dozen-argument `CompiledStateGraph`) stays in one place and
 * moves in lockstep with how the graph is actually constructed.
 */
export type AgentGraph = ReturnType<typeof createAgentGraph>;

/** A chat model that is guaranteed to support tool binding. */
export interface ToolBoundChatModel extends BaseChatModel {
    bindTools(
        tools: StructuredToolInterface[],
    ): Runnable<BaseLanguageModelInput, AIMessageChunk>;
}

/** Inputs to {@link createAgentGraph}. */
export interface AgentGraphOptions {
    /** Chat model the agent invokes; called with `bindTools(tools)`. */
    model: ToolBoundChatModel;
    /** Tools the model can call; also executed by the ToolNode. */
    tools: StructuredToolInterface[];
    /** Persists graph state keyed by thread id (the sessionId). */
    checkpointer: BaseCheckpointSaver;
}

/**
 * Builds and compiles the agent graph.
 *
 * Layout: `START -> model <-> tools`, where the model node decides the next
 * hop: route to `tools` when its latest message carries tool calls, otherwise
 * to `END`. The run's turn budget is enforced per invocation via
 * `recursionLimit` in {@link streamAgentTurn}.
 */
export function createAgentGraph({
    model,
    tools,
    checkpointer,
}: AgentGraphOptions) {
    return new StateGraph(MessagesAnnotation)
        .addNode("model", async (state) => {
            const response = await model
                .bindTools(tools)
                .invoke(state.messages);
            return { messages: [response] };
        })
        .addNode("tools", new ToolNode(tools))
        .addEdge(START, "model")
        .addConditionalEdges("model", (state) => {
            const last = state.messages[state.messages.length - 1];
            return last && hasToolCalls(last) ? "tools" : END;
        })
        .addEdge("tools", "model")
        .compile({ checkpointer });
}

/**
 * Runs a single agent turn for `sessionId`'s thread.
 *
 * Primes a fresh thread with the system prompt, streams the graph in
 * `"messages"` mode, and maps each streamed message onto the public event
 * shape: text tokens yield `token`, model tool calls yield `tool`, and
 * executed tools yield `toolResult`. Emits no events if the model answer
 * carries no text. `recursionLimit` caps the number of model/tool turns in one
 * run, aborting an agent that keeps requesting tools.
 *
 * If a thread already exists but its prime differs from `systemPrompt` (the
 * persona changed), the stored system message is replaced in place — the
 * reducer swaps it by id — so updated system prompts (e.g. new persona rules)
 * reach existing conversations on their next turn without duplicating or
 * losing history.
 */
export async function* streamAgentTurn(
    graph: AgentGraph,
    prompt: string,
    sessionId: string,
    systemPrompt: string,
    recursionLimit: number,
): AsyncGenerator<AgentEvent> {
    const config = {
        configurable: { thread_id: sessionId },
        recursionLimit,
    };
    const prior = await graph.getState(config);
    const messages = prior.values.messages as BaseMessage[] | undefined;
    const history = messages ?? [];
    const input =
        history.length === 0
            ? [new SystemMessage(systemPrompt), new HumanMessage(prompt)]
            : refreshedPrime(history, systemPrompt, prompt);

    const tracked = new ToolCallTracker();
    const stream = await graph.stream(
        { messages: input },
        {
            ...config,
            streamMode: "messages",
        },
    );

    for await (const [message] of stream) {
        for (const event of tracked.onMessage(message)) {
            yield event;
        }
    }
}

/** True when `message` asks for tool execution. */
function hasToolCalls(message: BaseMessage): boolean {
    const ai = message as AIMessage;
    return (
        (ai.tool_calls?.length ?? 0) > 0 ||
        (ai.invalid_tool_calls?.length ?? 0) > 0
    );
}

/**
 * Builds the turn input for an existing thread.
 *
 * Appends `prompt` as the new human turn and, when the thread's prime is a
 * stale system message (its content differs from the current `systemPrompt`),
 * re-emits that same message with the new content. The messages reducer
 * replaces by id, so the stored system message is refreshed in place and the
 * rest of the history is untouched.
 */
function refreshedPrime(
    history: BaseMessage[],
    systemPrompt: string,
    prompt: string,
): BaseMessage[] {
    const primer = history[0];
    const staleSystem =
        primer?._getType() === "system" &&
        typeof primer.id === "string" &&
        (typeof primer.content !== "string" || primer.content !== systemPrompt);
    return staleSystem && primer.id
        ? [
              new SystemMessage({ id: primer.id, content: systemPrompt }),
              new HumanMessage(prompt),
          ]
        : [new HumanMessage(prompt)];
}
