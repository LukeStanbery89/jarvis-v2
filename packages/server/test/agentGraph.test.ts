import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { AIMessageChunk } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
    createAgentGraph,
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
    tool_calls: [{ name: "getCurrentTime", args: {}, id: "call-1" }],
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
            args: {},
        });
        expect(events[1]).toMatchObject({
            type: "toolResult",
            name: "getCurrentTime",
        });
        expect(
            new Date((events[1] as { output: string }).output).toISOString(),
        ).toBe((events[1] as { output: string }).output);
        expect(events[2]).toEqual({
            type: "token",
            text: "The time is 2026-09-20.",
        });
        expect(model.callInputs).toHaveLength(2);
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
