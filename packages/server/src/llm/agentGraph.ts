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
    Annotation,
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
import { logger } from "../logger";

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

/**
 * Graph state shared by the legacy and two-role graphs.
 *
 * `messages` is the checkpointed conversation. The three role channels are
 * turn-scoped control data: they are written into the state because LangGraph
 * conditionals read state, but only `messages` is meaningful history. The
 * input resets them on every turn.
 */
const AgentState = Annotation.Root({
    ...MessagesAnnotation.spec,
    /** Whether this turn uses the router/writer split. */
    roleSplit: Annotation<boolean>({
        reducer: (_left, right) => right,
        default: () => false,
    }),
    /** Router/tool rounds attempted in this turn. */
    routerRounds: Annotation<number>({
        reducer: (_left, right) => right,
        default: () => 0,
    }),
    /** Set when the router failed before any tool executed. */
    routerFailed: Annotation<boolean>({
        reducer: (_left, right) => right,
        default: () => false,
    }),
});

/** Inputs to {@link createAgentGraph}. */
export interface AgentGraphOptions {
    /** Chat model the agent invokes; the writer in the split graph. */
    model: ToolBoundChatModel;
    /** Tools the model can call; also executed by the ToolNode. */
    tools: StructuredToolInterface[];
    /** Persists graph state keyed by thread id (the sessionId). */
    checkpointer: BaseCheckpointSaver;
    /**
     * Optional small tool-routing model (#214). When present and the turn is
     * marked `roleSplit`, the graph routes through `router -> tools* -> writer`
     * instead of the legacy `model <-> tools` loop.
     */
    router?: ToolBoundChatModel;
    /** Maximum router/tool rounds before the writer takes over. */
    routerMaxRounds?: number;
}

/**
 * Builds and compiles the agent graph.
 *
 * Legacy layout (when `router` is absent or the turn is not split):
 * `START -> model <-> tools`, where the model decides the next hop: route to
 * `tools` when its latest message carries tool calls, otherwise to `END`.
 *
 * Split layout (`router` configured and `roleSplit` set): `START -> router`,
 * with `router <-> tools` looping until the router emits no tool call, then
 * `writer -> END`. The writer is never bound to tools. A router failure before
 * any tool runs falls back to the legacy `model <-> tools` loop on the same
 * state; a failure after a tool runs goes straight to the writer so a side
 * effect is never replayed.
 *
 * The run's turn budget is enforced per invocation via `recursionLimit` in
 * {@link streamAgentTurn}; the router has an additional round cap.
 */
export function createAgentGraph({
    model,
    tools,
    checkpointer,
    router,
    routerMaxRounds = 4,
}: AgentGraphOptions) {
    const maxRouterRounds = Math.max(1, Math.floor(routerMaxRounds));
    return new StateGraph(AgentState)
        .addNode("model", async (state, config) => {
            const boundary = boundaryOf(state, config);
            // The legacy path has no role override; the fallback path inside
            // a split turn uses the full legacy prompt so it can call tools.
            const fallbackPrompt = state.roleSplit
                ? promptFromConfig(config, "fallbackSystemPrompt")
                : undefined;
            const response = await model
                .bindTools(tools)
                .invoke(modelInput(state, boundary, fallbackPrompt));
            return { messages: [response] };
        })
        .addNode("router", async (state, config) => {
            if (!router) {
                throw new Error(
                    "router node reached without a configured router model",
                );
            }
            if (state.routerRounds >= maxRouterRounds) {
                // The cap is checked before the model call, not after it:
                // streaming a final tool call we then refuse to execute would
                // still announce a phantom card to the client.
                logger.warn(
                    `Router reached its ${maxRouterRounds}-round cap; writer will answer from the results so far`,
                );
                return {};
            }
            const boundary = boundaryOf(state, config);
            const round = state.routerRounds + 1;
            const toolRan = state.messages
                .slice(boundary)
                .some((message) => message._getType() === "tool");
            const prompt = promptFromConfig(config, "routerSystemPrompt");
            let response: AIMessageChunk;
            try {
                response = await router
                    .bindTools(tools)
                    .invoke(modelInput(state, boundary, prompt));
            } catch (err) {
                // A cancelled turn is not a router failure; let the abort
                // propagate to the existing cancellation path.
                if (config.signal?.aborted) {
                    throw err;
                }
                const detail = err instanceof Error ? err.message : String(err);
                logger.error(`Router model failed: ${detail}`);
                if (toolRan) {
                    // A side effect already happened. Do not replay the turn
                    // through the tool-capable fallback; let the writer use
                    // the results we have.
                    logger.warn(
                        "Router failed after a tool ran; writer will answer from partial results",
                    );
                    return { routerRounds: round };
                }
                logger.warn(
                    "Router failed before any tool ran; falling back to the single-model loop",
                );
                return { routerRounds: round, routerFailed: true };
            }
            if (hasToolCalls(response)) {
                // The router's prose is a scratchpad, not the answer. Keep the
                // tool calls in history so the writer and later turns can see
                // what ran, but strip the prose.
                return {
                    messages: [routerDecisionMessage(response)],
                    routerRounds: round,
                };
            }
            // No tool call: a routing decision only. Do not persist the
            // router's text; the writer produces the user-facing answer.
            return { routerRounds: round };
        })
        .addNode("writer", async (state, config) => {
            const boundary = boundaryOf(state, config);
            const prompt = promptFromConfig(config, "writerSystemPrompt");
            const response = await model.invoke(
                modelInput(state, boundary, prompt),
            );
            return { messages: [response] };
        })
        .addNode("tools", new ToolNode(tools))
        .addConditionalEdges(START, (state) =>
            state.roleSplit ? "router" : "model",
        )
        .addConditionalEdges("model", (state) =>
            lastMessageHasToolCalls(state) ? "tools" : END,
        )
        .addConditionalEdges("router", (state) => {
            if (state.routerFailed) {
                return "model";
            }
            return lastMessageHasToolCalls(state) ? "tools" : "writer";
        })
        .addConditionalEdges("tools", (state) => {
            if (!state.roleSplit) {
                return "model";
            }
            return state.routerFailed ? "model" : "router";
        })
        .addEdge("writer", END)
        .compile({ checkpointer });
}

/** Reads the per-turn history boundary from the runnable config. */
function boundaryOf(
    state: { messages: BaseMessage[] },
    config: { configurable?: Record<string, unknown> },
): number {
    return Number(
        config.configurable?.historyBoundary ?? state.messages.length,
    );
}

/** Reads one string from the runnable config's per-turn values. */
function promptFromConfig(
    config: { configurable?: Record<string, unknown> },
    key: string,
): string | undefined {
    const value = config.configurable?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Builds one model call's input: pruned persisted history plus the in-flight
 * turn, with an optional ephemeral system-prompt override.
 *
 * The override is never written to the checkpoint. That is what lets the
 * router and writer share one stored base system message while each receives
 * its own role instructions.
 */
function modelInput(
    state: { messages: BaseMessage[] },
    boundary: number,
    rolePrompt: string | undefined,
): BaseMessage[] {
    const persisted = state.messages.slice(0, boundary);
    const inFlight = state.messages.slice(boundary);
    return withRolePrompt(
        [...prunedClockHistory(persisted), ...inFlight],
        rolePrompt,
    );
}

/** Replaces the stored prime with a role prompt for one model call. */
function withRolePrompt(
    messages: BaseMessage[],
    rolePrompt: string | undefined,
): BaseMessage[] {
    if (rolePrompt === undefined) {
        return messages;
    }
    const first = messages[0];
    if (first?._getType() === "system") {
        return [
            new SystemMessage({
                ...(first.id === undefined ? {} : { id: first.id }),
                content: rolePrompt,
            }),
            ...messages.slice(1),
        ];
    }
    return [new SystemMessage(rolePrompt), ...messages];
}

/**
 * Strips router prose from a tool-call message before it enters history.
 *
 * Tool calls must remain in the checkpoint so the writer and later turns see
 * what ran, but the router's text is scratchpad. Empty content keeps the
 * stored shape a clean tool-call assistant message.
 */
function routerDecisionMessage(response: AIMessage): AIMessage {
    const prose =
        typeof response.content === "string"
            ? response.content.trim().length > 0
            : response.content.length > 0;
    if (!prose) {
        return response;
    }
    return new AIMessage({
        content: "",
        tool_calls: response.tool_calls ?? [],
        ...(response.invalid_tool_calls?.length
            ? { invalid_tool_calls: response.invalid_tool_calls }
            : {}),
    });
}

/** True when the newest state message asks for a tool. */
function lastMessageHasToolCalls(state: { messages: BaseMessage[] }): boolean {
    const last = state.messages[state.messages.length - 1];
    return last !== undefined && hasToolCalls(last);
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
     * caller-scoped context the tools need — e.g. `userId` (#10, #9) —
     * rather than module-level state; values live for this invocation only.
     */
    configurable?: Record<string, unknown>;
    /**
     * Cooperative cancellation (#84 P6): rides the runnable config into the
     * graph, so a mid-turn abort reaches the model calls themselves — an
     * in-flight (or TCP-stalled) fetch rejects instead of waiting for the
     * next token. Optional: the turn timeout drains best-effort without it.
     */
    signal?: AbortSignal;
    /**
     * Whether this turn uses the router/writer split (#214). `false` keeps the
     * legacy `model <-> tools` path even when a router is compiled.
     */
    roleSplit?: boolean;
    /** Ephemeral router system prompt; required for a split turn. */
    routerSystemPrompt?: string;
    /** Ephemeral writer system prompt; required for a split turn. */
    writerSystemPrompt?: string;
    /**
     * Full legacy prompt used only if the router fails before any tool runs.
     * The fallback model needs the tool-hygiene paragraphs to route safely.
     */
    fallbackSystemPrompt?: string;
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
    const { systemPrompt, recursionLimit, configurable, signal } = options;
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
            ...(options.routerSystemPrompt === undefined
                ? {}
                : { routerSystemPrompt: options.routerSystemPrompt }),
            ...(options.writerSystemPrompt === undefined
                ? {}
                : { writerSystemPrompt: options.writerSystemPrompt }),
            ...(options.fallbackSystemPrompt === undefined
                ? {}
                : { fallbackSystemPrompt: options.fallbackSystemPrompt }),
        },
        recursionLimit,
        ...(signal !== undefined ? { signal } : {}),
    };

    // Router/legacy/tool messages share one tracker so tool calls pair with
    // their results. The writer gets its own tracker: its text is a fresh
    // answer segment, not a continuation of the router's discarded prose.
    const agentTracker = new ToolCallTracker();
    const writerTracker = new ToolCallTracker();
    const stream = await graph.stream(
        {
            messages: input,
            roleSplit: options.roleSplit ?? false,
            routerRounds: 0,
            routerFailed: false,
        },
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
        //
        // In the split graph the router's prose is scratchpad, not an answer:
        // its `tool` announcements still reach the client, but its text does
        // not. The writer's node is the only source of assistant tokens.
        const node = (metadata as { langgraph_node?: string } | undefined)
            ?.langgraph_node;
        if (node === "tools" && message._getType?.() !== "tool") {
            continue;
        }
        const tracker = node === "writer" ? writerTracker : agentTracker;
        for (const event of tracker.onMessage(message)) {
            if (node === "router" && event.type !== "tool") {
                continue;
            }
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
 *
 * Empty assistant messages are dropped as noise. A tool-only turn ends with
 * one (the model wrote no prose), and pruning its clock exchange would
 * otherwise leave an assistant message as the first non-system turn. Qwen's
 * chat templates reject that shape with "No user query found in messages",
 * even though the next human message is present (#193 follow-up).
 */
export function prunedClockHistory(history: BaseMessage[]): BaseMessage[] {
    const pruned: BaseMessage[] = [];
    for (let i = 0; i < history.length; i += 1) {
        const message = history[i];
        if (isEmptyAssistant(message)) {
            continue;
        }
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

/**
 * True when `candidate` is an assistant message with neither prose nor tool
 * calls — the ending a model leaves after a tool-only turn. It carries no
 * context and can break strict chat templates when pruning strands it at the
 * front of a history, so {@link prunedClockHistory} drops it.
 */
function isEmptyAssistant(candidate: BaseMessage): boolean {
    if (candidate._getType() !== "ai") {
        return false;
    }
    const ai = candidate as AIMessage;
    return (
        (ai.tool_calls?.length ?? 0) === 0 &&
        typeof ai.content === "string" &&
        ai.content.trim().length === 0
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
