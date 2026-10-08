import { afterEach, describe, expect, it } from "vitest";
import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage,
    type BaseMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
    createAgentGraph,
    prunedClockHistory,
    streamAgentTurn,
    type AgentGraph,
} from "../src/llm/agentGraph";
import { getCurrentTime } from "../src/llm/tools/time";

/** Returns scripted responses in order, recording every call's input history. */
class ScriptedChatModel extends BaseChatModel {
    responses: BaseMessage[];
    callInputs: BaseMessage[][] = [];
    private index = 0;

    constructor(responses: BaseMessage[]) {
        super({});
        this.responses = responses;
    }

    _llmType(): string {
        return "scripted";
    }

    bindTools(): Runnable<BaseLanguageModelInput, AIMessageChunk> {
        return this as unknown as Runnable<
            BaseLanguageModelInput,
            AIMessageChunk
        >;
    }

    async _generate(messages: BaseMessage[]): Promise<{
        generations: { message: BaseMessage; text: string }[];
    }> {
        this.callInputs.push(messages);
        const next =
            this.responses[Math.min(this.index, this.responses.length - 1)];
        this.index += 1;
        return {
            generations: [
                {
                    message: next,
                    text: typeof next.content === "string" ? next.content : "",
                },
            ],
        };
    }
}

const SYSTEM_PROMPT = "System prompt here.";
const TOOL_CALL = new AIMessage({
    content: "",
    tool_calls: [
        {
            name: "getCurrentTime",
            args: { question: "what time is it?" },
            id: "call-1",
        },
    ],
});

function buildGraph(model: ScriptedChatModel): AgentGraph {
    return createAgentGraph({
        model: model as unknown as Parameters<
            typeof createAgentGraph
        >[0]["model"],
        tools: [getCurrentTime] as StructuredToolInterface[],
        checkpointer: new MemorySaver(),
    });
}

function collect(events: AsyncGenerator<unknown>): Promise<unknown[]> {
    return (async () => {
        const out: unknown[] = [];
        for await (const event of events) {
            out.push(event);
        }
        return out;
    })();
}

afterEach(() => {
    delete process.env.JARVIS_CHECKPOINT_PATH;
});

describe("createAgentGraph", () => {
    it("runs tools during a turn and streams tool/token events", async () => {
        const model = new ScriptedChatModel([
            TOOL_CALL,
            new AIMessage({ content: "The time is 2026-09-20." }),
        ]);
        const graph = buildGraph(model);
        const events = await collect(
            streamAgentTurn(graph, "what time is it?", "t1", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );

        expect(events).toHaveLength(3);
        expect(events[0]).toEqual({
            type: "tool",
            name: "getCurrentTime",
            args: { question: "what time is it?" },
        });
        expect(events[1]).toMatchObject({
            type: "toolResult",
            name: "getCurrentTime",
        });
        const timeOutput = (events[1] as { output: string }).output;
        expect(timeOutput).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
        expect(events[2]).toEqual({
            type: "token",
            text: "The time is 2026-09-20.",
        });
        expect(model.callInputs).toHaveLength(2);
    });

    it("never streams messages from a model invoked inside a tool (#70)", async () => {
        // Reproduces the analyzeImage shape: a REAL ChatOpenAI invoked inside
        // the tool (the VL call). LangGraph's messages mode emits that nested
        // model's response too — tagged with the tools node — and forwarding
        // it streamed the tool's output text as a phantom assistant reply.
        // A scripted BaseChatModel does NOT reproduce the leak (its messages
        // never enter the messages-mode stream), which is why the nested model
        // here is the real ChatOpenAI class against a mock OpenAI endpoint.
        const { createServer: createHttpServer } = await import("node:http");
        // LangGraph's messages-mode callback handler declares streaming, so
        // a ChatOpenAI nested inside the graph is forced into SSE mode — the
        // exact mechanism that leaked the VL output in production. The mock
        // answers both shapes.
        const mock = createHttpServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const streaming = JSON.parse(body || "{}").stream === true;
                if (streaming) {
                    res.setHeader("Content-Type", "text/event-stream");
                    const chunk = (delta: object) =>
                        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
                    res.write(chunk({ role: "assistant" }));
                    res.write(chunk({ content: "nested secrets" }));
                    res.write("data: [DONE]\n\n");
                    res.end();
                } else {
                    res.setHeader("Content-Type", "application/json");
                    res.end(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        role: "assistant",
                                        content: "nested secrets",
                                    },
                                },
                            ],
                        }),
                    );
                }
            });
        });
        await new Promise<void>((resolve) =>
            mock.listen(0, "127.0.0.1", () => resolve()),
        );
        const addr = mock.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const { ChatOpenAI } = await import("@langchain/openai");
        const nested = new ChatOpenAI({
            apiKey: "test",
            model: "nested-model",
            configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
        });
        const echoViaModel = tool(
            async () => {
                await nested.invoke([new HumanMessage("nested ask")]);
                return "tool-done";
            },
            {
                name: "echoViaModel",
                description: "Invokes a nested model, returns fixed text.",
                schema: z.object({}),
            },
        );
        const model = new ScriptedChatModel([
            new AIMessage({
                content: "",
                tool_calls: [{ name: "echoViaModel", args: {}, id: "call-n" }],
            }),
            new AIMessage({ content: "The final answer." }),
        ]);
        const graph = createAgentGraph({
            model: model as unknown as Parameters<
                typeof createAgentGraph
            >[0]["model"],
            tools: [echoViaModel] as StructuredToolInterface[],
            checkpointer: new MemorySaver(),
        });
        const events = await collect(
            streamAgentTurn(graph, "run the tool", "nested-t1", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );

        // The nested model's text must never surface as a token — the tool's
        // output reaches the client exactly once, via the toolResult event.
        const leaked = events.filter(
            (e) =>
                (e as { type: string; text?: string }).type === "token" &&
                (e as { text?: string }).text?.includes("nested secrets"),
        );
        expect(leaked).toEqual([]);
        expect(events).toEqual([
            { type: "tool", name: "echoViaModel", args: {} },
            {
                type: "toolResult",
                name: "echoViaModel",
                output: "tool-done",
            },
            { type: "token", text: "The final answer." },
        ]);
        await new Promise<void>((resolve) => mock.close(() => resolve()));
    });

    it("persists context between turns on the same thread", async () => {
        const model = new ScriptedChatModel([
            new AIMessage({ content: "First answer." }),
            new AIMessage({ content: "Second answer." }),
        ]);
        const graph = buildGraph(model);

        await collect(
            streamAgentTurn(graph, "first prompt", "t2", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );
        await collect(
            streamAgentTurn(graph, "second prompt", "t2", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );

        const state = (
            await graph.getState({
                configurable: { thread_id: "t2" },
            })
        ).values.messages as BaseMessage[];
        expect(state.map((m) => m._getType())).toEqual([
            "system",
            "human",
            "ai",
            "human",
            "ai",
        ]);
        expect(state[1].content).toBe("first prompt");
        expect(state[3].content).toBe("second prompt");
    });

    it("does not re-prime an active thread with the system prompt", async () => {
        const model = new ScriptedChatModel([
            new AIMessage({ content: "One" }),
            new AIMessage({ content: "Two" }),
        ]);
        const graph = buildGraph(model);
        await collect(
            streamAgentTurn(graph, "one", "t3", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );
        await collect(
            streamAgentTurn(graph, "two", "t3", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );
        const secondInput = model.callInputs[1];
        expect(
            secondInput.filter((m) => m._getType() === "system"),
        ).toHaveLength(1);
        expect(secondInput.map((m) => m._getType())).toEqual([
            "system",
            "human",
            "ai",
            "human",
        ]);
    });

    it("prunes the earlier clock ask + exchange from a later turn's model input", async () => {
        // Turn 1 asks the time (model calls the clock); turn 2 asks the date.
        // The model input for turn 2 must NOT contain turn 1's stranded clock
        // ask, invocation, result, or answer — otherwise a small model re-answers
        // them and the reply compounds across turns.
        const model = new ScriptedChatModel([
            TOOL_CALL,
            new AIMessage({ content: "The time is 11:43 PM." }),
            new AIMessage({ content: "Today is September 28, 2026." }),
        ]);
        const graph = buildGraph(model);
        await collect(
            streamAgentTurn(graph, "What time is it?", "t-clock", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );
        await collect(
            streamAgentTurn(graph, "What is today's date?", "t-clock", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );

        // Turn 1's scripted model makes two calls (invocation + post-tool
        // answer), so turn 2's input is the fourth entry. It must NOT contain
        // turn 1's stranded clock ask, invocation, result, or answer —
        // otherwise a small model re-answers them and the reply compounds.
        const secondTurnInput = model.callInputs[2];
        expect(secondTurnInput.map((m) => m._getType())).toEqual([
            "system",
            "human",
        ]);
        expect(secondTurnInput.map((m) => m.content)).toEqual([
            SYSTEM_PROMPT,
            "What is today's date?",
        ]);
    });

    it("refreshes the system prompt on an existing thread when it changes", async () => {
        const model = new ScriptedChatModel([
            new AIMessage({ content: "One" }),
            new AIMessage({ content: "Two" }),
        ]);
        const graph = buildGraph(model);
        await collect(
            streamAgentTurn(graph, "one", "t5", {
                systemPrompt: "OLD PROMPT",
                recursionLimit: 10,
            }),
        );
        await collect(
            streamAgentTurn(graph, "two", "t5", {
                systemPrompt: "NEW PROMPT",
                recursionLimit: 10,
            }),
        );

        const secondInput = model.callInputs[1];
        expect(
            secondInput.filter((m) => m._getType() === "system"),
        ).toHaveLength(1);
        expect(secondInput[0].content).toBe("NEW PROMPT");

        const state = (
            await graph.getState({
                configurable: { thread_id: "t5" },
            })
        ).values.messages as BaseMessage[];
        expect(state.map((m) => m._getType())).toEqual([
            "system",
            "human",
            "ai",
            "human",
            "ai",
        ]);
        expect(state[0].content).toBe("NEW PROMPT");
        expect(state[4].content).toBe("Two");
    });

    it("isolates state between different thread ids", async () => {
        const model = new ScriptedChatModel([
            new AIMessage({ content: "Shared" }),
            new AIMessage({ content: "Shared" }),
        ]);
        const graph = buildGraph(model);
        await collect(
            streamAgentTurn(graph, "a", "ta", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );
        await collect(
            streamAgentTurn(graph, "b", "tb", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );

        const a = (
            await graph.getState({
                configurable: { thread_id: "ta" },
            })
        ).values.messages as BaseMessage[];
        const b = (
            await graph.getState({
                configurable: { thread_id: "tb" },
            })
        ).values.messages as BaseMessage[];
        expect(a[1].content).toBe("a");
        expect(b[1].content).toBe("b");
        expect(a).not.toEqual(b);
    });

    it("aborts a runaway tool loop at the recursion limit", async () => {
        const model = new ScriptedChatModel([TOOL_CALL]);
        const graph = buildGraph(model);
        await expect(
            collect(
                streamAgentTurn(graph, "loop", "t4", {
                    systemPrompt: SYSTEM_PROMPT,
                    recursionLimit: 3,
                }),
            ),
        ).rejects.toThrow(/recursion|limit/i);
    });
});

describe("prunedClockHistory", () => {
    it("removes a prior clock exchange: invocation, result, and answer", () => {
        const history: BaseMessage[] = [
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "call-1",
                        name: "getCurrentTime",
                        args: {
                            question: "What time is it?",
                        },
                    },
                ],
            }),
            new ToolMessage({
                content: "2026-09-27T10:00:00.000Z",
                tool_call_id: "call-1",
                name: "getCurrentTime",
            }),
            new AIMessage({ content: "The time is 10:00." }),
            new AIMessage({ content: "Unrelated reply." }),
        ];
        const pruned = prunedClockHistory(history);
        expect(pruned).toEqual([
            new AIMessage({ content: "Unrelated reply." }),
        ]);
    });

    it("drops the stranded ask with a pruned clock exchange so it isn't re-answered", () => {
        // The model sees the full stored history: the human ask, the clock
        // invocation, its result, and the prose answer. Pruning the exchange
        // but leaving the ask would strand an unanswered question that a small
        // model promptly re-answers (compounding verbosity across clock asks).
        const history: BaseMessage[] = [
            new HumanMessage({ content: "What time is it?" }),
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "call-1",
                        name: "getCurrentTime",
                        args: {
                            question: "What time is it?",
                        },
                    },
                ],
            }),
            new ToolMessage({
                content: "11:43 PM",
                tool_call_id: "call-1",
                name: "getCurrentTime",
            }),
            new AIMessage({ content: "The current time is 11:43 PM." }),
            new AIMessage({ content: "Unrelated reply." }),
        ];
        const pruned = prunedClockHistory(history);
        expect(pruned).toEqual([
            new AIMessage({ content: "Unrelated reply." }),
        ]);
    });

    it("drops a chained multi-call clock exchange root and branch", () => {
        // A single clock turn can accumulate more than one invocation; the
        // whole chain must go with the ask, not just the last exchange.
        const history: BaseMessage[] = [
            new HumanMessage({ content: "What is today's date?" }),
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "call-1",
                        name: "getCurrentTime",
                        args: {
                            question: "What time is it?",
                        },
                    },
                ],
            }),
            new ToolMessage({
                content: "11:43 PM",
                tool_call_id: "call-1",
                name: "getCurrentTime",
            }),
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "call-2",
                        name: "getCurrentTime",
                        args: {
                            question: "What is today's date?",
                        },
                    },
                ],
            }),
            new ToolMessage({
                content: "September 28, 2026",
                tool_call_id: "call-2",
                name: "getCurrentTime",
            }),
            new AIMessage({
                content:
                    "The current time is 11:43 PM. Today is September 28, 2026.",
            }),
        ];
        expect(prunedClockHistory(history)).toEqual([]);
    });

    it("prunes the result and invocation but keeps another tool call", () => {
        const history: BaseMessage[] = [
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "call-2",
                        name: "getCurrentTime",
                        args: {},
                    },
                ],
            }),
            new ToolMessage({
                content: "2026-09-27T10:00:00.000Z",
                tool_call_id: "call-2",
                name: "getCurrentTime",
            }),
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "call-3",
                        name: "calculate",
                        args: { expression: "1 + 1" },
                    },
                ],
            }),
        ];
        const pruned = prunedClockHistory(history);
        // The clock invocation and result both go; the unrelated call stays.
        expect(pruned).toHaveLength(1);
        expect(pruned[0]).toMatchObject({ content: "" });
        expect((pruned[0] as AIMessage).tool_calls?.[0]?.name).toBe(
            "calculate",
        );
    });

    it("leaves non-clock messages untouched", () => {
        const history: BaseMessage[] = [
            new AIMessage({ content: "hi" }),
            new ToolMessage({
                content: "4",
                tool_call_id: "call-x",
                name: "calculate",
            }),
        ];
        expect(prunedClockHistory(history)).toEqual(history);
    });
});

/** The record of what `graph.stream` was handed, captured by the spy. */
interface SeenStreamConfig {
    configurable?: Record<string, unknown>;
    signal?: AbortSignal;
}

/**
 * Wraps a compiled graph in a Proxy that records the config every
 * `stream` call receives, without disturbing the call itself (property
 * access stays on the target, so `this` binding is preserved).
 */
function spyStream(graph: AgentGraph): {
    graph: AgentGraph;
    seen: SeenStreamConfig[];
} {
    const seen: SeenStreamConfig[] = [];
    const proxy = new Proxy(graph, {
        get(target, prop, receiver) {
            if (prop === "stream") {
                return (input: unknown, config: unknown) => {
                    seen.push(config as SeenStreamConfig);
                    return (
                        target.stream as (
                            i: unknown,
                            c: unknown,
                        ) => Promise<unknown>
                    )(input, config);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
    return { graph: proxy as AgentGraph, seen };
}

describe("turn cancellation (#84 P6)", () => {
    it("threads the caller's AbortSignal into the graph stream config", async () => {
        const controller = new AbortController();
        const model = new ScriptedChatModel([
            new AIMessage({ content: "answer" }),
        ]);
        const { graph, seen } = spyStream(buildGraph(model));
        const events = await collect(
            streamAgentTurn(graph, "hi", "t-cancel", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
                signal: controller.signal,
            }),
        );
        // The turn itself completes (the signal was never aborted).
        expect(events.length).toBeGreaterThan(0);
        // The signal rode the config into `graph.stream` — the cancellation
        // reach a real model call needs.
        expect(seen).toHaveLength(1);
        expect(seen[0]!.signal).toBe(controller.signal);
    });

    it("sends no signal key when none was provided", async () => {
        const model = new ScriptedChatModel([
            new AIMessage({ content: "answer" }),
        ]);
        const { graph, seen } = spyStream(buildGraph(model));
        await collect(
            streamAgentTurn(graph, "hi", "t-nosignal", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
            }),
        );
        expect(seen[0]!.signal).toBeUndefined();
    });

    it("fails the turn when the signal aborts mid-stream", async () => {
        const controller = new AbortController();
        const model = new ScriptedChatModel([
            new AIMessage({ content: "answer" }),
        ]);
        const { graph } = spyStream(buildGraph(model));
        const started = collect(
            streamAgentTurn(graph, "hi", "t-abort", {
                systemPrompt: SYSTEM_PROMPT,
                recursionLimit: 10,
                signal: controller.signal,
            }),
        );
        controller.abort();
        // The signal rides into `graph.stream`, and the graph's model call
        // rejects on it — the turn ends instead of running to completion
        // (a hung model that ignores the signal still drains via the
        // caller's `return()`, best-effort; this is the signal-honoring
        // path).
        await expect(started).rejects.toThrow();
    });
});
