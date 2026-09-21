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
    ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import {
    MessagesAnnotation,
    StateGraph,
    END,
    START,
    type CompiledStateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { StructuredToolInterface } from "@langchain/core/tools";

/** One event produced while running an agent turn. */
export type AgentEvent =
    | { type: "token"; text: string }
    | { type: "tool"; name: string; args: unknown }
    | { type: "toolResult"; name: string; output: unknown };

/** Concrete compiled-graph type used across the agent layer. */
export type AgentGraph = CompiledStateGraph<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
>;

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
}: AgentGraphOptions): AgentGraph {
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
    const needsPriming = !messages || messages.length === 0;
    const input = needsPriming
        ? [new SystemMessage(systemPrompt), new HumanMessage(prompt)]
        : [new HumanMessage(prompt)];

    const tracked = new Map<string, PendingToolCall>();
    const announced = new Set<string>();
    const stream = await graph.stream(
        { messages: input },
        {
            ...config,
            streamMode: "messages",
        },
    );

    for await (const [message] of stream) {
        if (message._getType?.() === "tool") {
            for (const event of handleToolResult(
                message as unknown as ToolMessage,
                tracked,
                announced,
            )) {
                yield event;
            }
        } else if (message._getType?.() === "ai") {
            for (const event of handleModelMessage(
                message as unknown as AIMessage,
                tracked,
                announced,
            )) {
                yield event;
            }
        }
    }
}

/** Tracks a tool call seen in the stream until its result arrives. */
interface PendingToolCall {
    name: string;
    args: Record<string, unknown> | string;
}

/**
 * Extracts events from a model-produced message.
 *
 * Text content becomes `token` events. Tool calls are announced as `tool`
 * events as soon as their name and args are known — either from a complete
 * `tool_calls` payload or from accumulated streaming `tool_call_chunks` whose
 * args successfully JSON-parse.
 */
function* handleModelMessage(
    message: AIMessage,
    tracked: Map<string, PendingToolCall>,
    announced: Set<string>,
): Generator<AgentEvent> {
    for (const call of message.tool_calls ?? []) {
        if (!call.id) {
            continue;
        }
        if (!announced.has(call.id)) {
            announced.add(call.id);
            tracked.set(call.id, {
                name: call.name,
                args: (call.args ?? {}) as Record<string, unknown>,
            });
            yield { type: "tool", name: call.name, args: call.args ?? {} };
        }
    }

    const chunks = (message as AIMessageChunk).tool_call_chunks;
    for (const call of chunks ?? []) {
        const id = call.id ?? call.index?.toString();
        if (!id) {
            continue;
        }
        const pending = tracked.get(id);
        const name = call.name || pending?.name;
        if (call.name) {
            tracked.set(id, {
                name: call.name,
                args: pending?.args ?? {},
            });
        }
        if (typeof call.args === "string") {
            const base = typeof pending?.args === "string" ? pending.args : "";
            const merged = `${base}${call.args}`;
            let parsed: Record<string, unknown> | undefined;
            try {
                parsed = JSON.parse(merged);
            } catch {
                parsed = undefined;
            }
            if (parsed !== undefined) {
                tracked.set(id, {
                    name: name ?? "tool",
                    args: parsed,
                });
                // Announce only once the call's name is known. Streaming chunks
                // may key the same call by id and index at different times (the
                // name often arrives under one key and complete args under the
                // other), so a chunk with unknown name is left for the final
                // tool_calls message to announce — otherwise a fallback "tool"
                // name would leak into the event stream.
                if (name && !announced.has(id)) {
                    announced.add(id);
                    yield { type: "tool", name, args: parsed };
                }
            } else {
                tracked.set(id, {
                    name: name ?? "tool",
                    args: merged,
                });
            }
        }
    }

    if (
        typeof message.content === "string" &&
        message.content.length > 0 &&
        !(chunks && chunks.length > 0)
    ) {
        yield { type: "token", text: message.content };
    }
}

/**
 * Extracts a `toolResult` event from a ToolMessage, announcing the matching
 * `tool` event first if it was never announced (e.g. args never parsed during
 * streaming).
 */
function* handleToolResult(
    message: ToolMessage,
    tracked: Map<string, PendingToolCall>,
    announced: Set<string>,
): Generator<AgentEvent> {
    const id = message.tool_call_id;
    const pending = id ? tracked.get(id) : undefined;
    const name = pending?.name ?? message.name ?? "tool";
    const args = typeof pending?.args === "object" ? pending.args : {};
    const output =
        typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
    if (id && !announced.has(id)) {
        announced.add(id);
        yield { type: "tool", name, args };
    }
    yield { type: "toolResult", name, output };
}

/** True when `message` asks for tool execution. */
function hasToolCalls(message: BaseMessage): boolean {
    const ai = message as AIMessage;
    return (
        (ai.tool_calls?.length ?? 0) > 0 ||
        (ai.invalid_tool_calls?.length ?? 0) > 0
    );
}
