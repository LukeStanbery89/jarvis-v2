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
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolCallTracker } from "./toolCallTracker";
import type { AgentEvent } from "./event";

export type { AgentEvent } from "./event";

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
        .addNode("model", async (state, config) => {
            const boundary = Number(
                config.configurable?.historyBoundary ?? state.messages.length,
            );
            // Prune stale clock exchanges from the persisted prefix only; the
            // in-flight turn's messages (from the boundary onward) — including
            // the fresh tool result — are never touched, so the model can
            // answer from the value it just computed.
            const persisted = state.messages.slice(0, boundary);
            const inFlight = state.messages.slice(boundary);
            const response = await model
                .bindTools(tools)
                .invoke([...prunedClockHistory(persisted), ...inFlight]);
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
 * Options for one {@link streamAgentTurn} run.
 */
export interface TurnOptions {
    /** Persona primed into a fresh thread (see `streamAgentTurn`). */
    systemPrompt: string;
    /** Caps the number of model/tool turns in one run, aborting a runaway agent. */
    recursionLimit: number;
    /**
     * Extra per-turn values merged into the graph's `configurable`, exposed
     * to tool runtime callbacks (`ToolRuntime.configurable`). Used for
     * caller-scoped context the tools need — e.g. `attachmentOwner` (#10) —
     * rather than module-level state; values live for this invocation only.
     */
    configurable?: Record<string, unknown>;
}

/**
 * Runs a single agent turn for `sessionId`'s thread.
 *
 * Primes a fresh thread with the system prompt, streams the graph in
 * `"messages"` mode, and maps each streamed message onto the public event
 * shape: text tokens yield `token`, model tool calls yield `tool`, and
 * executed tools yield `toolResult`. Emits no events if the model answer
 * carries no text. `options.recursionLimit` caps the number of model/tool
 * turns in one run, aborting an agent that keeps requesting tools.
 *
 * If a thread already exists but its prime differs from
 * `options.systemPrompt` (the persona changed), the stored system message is
 * replaced in place — the reducer swaps it by id — so updated system prompts
 * (e.g. new persona rules) reach existing conversations on their next turn
 * without duplicating or losing history.
 */
export async function* streamAgentTurn(
    graph: AgentGraph,
    prompt: string,
    sessionId: string,
    options: TurnOptions,
): AsyncGenerator<AgentEvent> {
    const { systemPrompt, recursionLimit, configurable } = options;
    const prior = await graph.getState({
        configurable: { thread_id: sessionId },
    });
    const messages = prior.values.messages as BaseMessage[] | undefined;
    const history = messages ?? [];
    const input =
        history.length === 0
            ? [new SystemMessage(systemPrompt), new HumanMessage(prompt)]
            : refreshedPrime(history, systemPrompt, prompt);
    const config = {
        configurable: {
            thread_id: sessionId,
            // Messages at or beyond this index were written by the current
            // run; everything before it is persisted history. The model node
            // prunes stale clock exchanges from the prefix only, so the fresh
            // tool result of the in-flight turn stays visible.
            historyBoundary: history.length,
            ...configurable,
        },
        recursionLimit,
    };

    const tracked = new ToolCallTracker();
    const stream = await graph.stream(
        { messages: input },
        {
            ...config,
            streamMode: "messages",
        },
    );

    for await (const [message, metadata] of stream) {
        // Messages-mode emits messages from ANY LangChain runnable inside the
        // graph — including a model invoked *inside a tool* (the VL call in
        // `analyzeImage`). Those nested messages are an implementation detail
        // of the tool: forwarding them would stream the tool's output text as
        // if the assistant had said it (#70). A tool's output reaches clients
        // exactly once, via its `toolResult` event — so from the tools node,
        // only the executed-tool `ToolMessage` passes; nested AI messages are
        // dropped. Everything from the model node (chat tokens, tool-call
        // announcements) and every ToolMessage forwards as before. A missing
        // metadata record forwards too (fail-open), since dropping a real
        // model message would be worse than relaying a stray one.
        const node = (metadata as { langgraph_node?: string } | undefined)
            ?.langgraph_node;
        if (node === "tools" && message._getType?.() !== "tool") {
            continue;
        }
        for (const event of tracked.onMessage(message)) {
            yield event;
        }
    }
}

/**
 * True when `message` asks for tool execution.
 */
function hasToolCalls(message: BaseMessage): boolean {
    const ai = message as AIMessage;
    return (
        (ai.tool_calls?.length ?? 0) > 0 ||
        (ai.invalid_tool_calls?.length ?? 0) > 0
    );
}

/**
 * Returns the history with every earlier `getCurrentTime` exchange removed.
 *
 * A stale clock exchange in the conversation is radioactive: a small local
 * model asked the time again will typically quote the earlier timestamp —
 * either from the stored tool result or from its own prior "the time is …"
 * prose — instead of re-invoking the live tool, no matter how the question is
 * worded (the `TIME_CALL_RULE` system-prompt nudge helps but is not
 * reliable). This prunes the full prior exchange — the ask, the tool call, its
 * result, and the text answer that followed — so the model never sees an old
 * value to copy or a stranded question to answer again. The current turn's
 * (fresh) result is the only clock data in context, so the answer must come
 * from a live call.
 *
 * Walk preserves ordering and only removes messages tightly coupled to a
 * clock exchange: the result, the tool-call `AIMessage` that invoked it
 * (immediately preceding), the `HumanMessage` ask that prompted the call, and
 * a text-only `AIMessage` that directly followed the result (the prose
 * embedding the timestamp). A final answer that was produced after chained
 * further tool calls is left standing — rare for a time-only ask, and not
 * worth mis-pruning unrelated turns for.
 */
export function prunedClockHistory(history: BaseMessage[]): BaseMessage[] {
    const pruned: BaseMessage[] = [];
    for (let i = 0; i < history.length; i += 1) {
        const message = history[i];
        if (message._getType() === "tool") {
            const tool = message as ToolMessage;
            if (tool.name === "getCurrentTime") {
                // Drop the tool call that invoked it (if it's the immediately
                // preceding message) and any text answer that directly followed
                // the result (the prose that embedded the stale value).
                const prev = pruned[pruned.length - 1];
                if (prev !== undefined && isClockInvocation(prev, tool)) {
                    pruned.pop();
                    // Also drop the human ask that prompted the exchange (it
                    // directly precedes the invocation). Leaving it strands an
                    // unanswered question in the thread, so a small model
                    // answers it again on every later turn — that compounds the
                    // very repetition this prune exists to stop.
                    const ask = history[i - 2];
                    if (
                        ask !== undefined &&
                        ask._getType() === "human" &&
                        pruned[pruned.length - 1] === ask
                    ) {
                        pruned.pop();
                    }
                }
                const next = history[i + 1];
                if (next !== undefined && isPlainAnswer(next)) {
                    i += 1;
                }
                continue;
            }
        }
        pruned.push(message);
    }
    return pruned;
}

/** True when `candidate` is the AIMessage whose tool_calls invoked `result`. */
function isClockInvocation(
    candidate: BaseMessage,
    result: ToolMessage,
): boolean {
    if (candidate._getType() !== "ai") {
        return false;
    }
    const ai = candidate as AIMessage;
    return (ai.tool_calls ?? []).some(
        (call) => call.id === result.tool_call_id,
    );
}

/** True when `candidate` is a plain-text assistant message (no tool calls). */
function isPlainAnswer(candidate: BaseMessage): boolean {
    if (candidate._getType() !== "ai") {
        return false;
    }
    const ai = candidate as AIMessage;
    return (
        (ai.tool_calls?.length ?? 0) === 0 &&
        typeof ai.content === "string" &&
        ai.content.length > 0
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
