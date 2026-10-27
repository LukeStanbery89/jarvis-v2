/**
 * Checkpoint maintenance (#122): context-window trimming and version pruning.
 */
import Database from "better-sqlite3";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { describe, expect, it } from "vitest";
import {
    pruneThreadVersions,
    trimGraphContext,
    trimMessagesForContext,
} from "../src/agent";
import { createAgentGraph } from "../src/llm/agentGraph";

/** A model stub: the maintenance test seeds state, it never generates. */
class StubModel extends BaseChatModel {
    constructor() {
        super({});
    }
    _llmType(): string {
        return "stub";
    }
    bindTools(): Runnable<BaseLanguageModelInput, AIMessageChunk> {
        return this as unknown as Runnable<
            BaseLanguageModelInput,
            AIMessageChunk
        >;
    }
    async _generate(): Promise<{
        generations: { message: AIMessage; text: string }[];
    }> {
        return { generations: [{ message: new AIMessage(""), text: "" }] };
    }
}

describe("trimMessagesForContext", () => {
    it("keeps the system prompt and the newest complete turns", () => {
        const messages = [
            new SystemMessage("system"),
            new HumanMessage("h1"),
            new AIMessage("a1"),
            new HumanMessage("h2"),
            new AIMessage("a2"),
            new HumanMessage("h3"),
            new AIMessage("a3"),
        ];
        const kept = trimMessagesForContext(messages, 4);
        expect(kept.map((message) => message.content)).toEqual([
            "system",
            "h2",
            "a2",
            "h3",
            "a3",
        ]);
    });

    it("backs up to a human boundary when the cut lands in a tool turn", () => {
        const messages = [
            new SystemMessage("system"),
            new HumanMessage("h1"),
            new AIMessage({
                content: "",
                tool_calls: [{ id: "c1", name: "tool", args: {} }],
            }),
            new ToolMessage({
                content: "result",
                tool_call_id: "c1",
                name: "tool",
            }),
            new AIMessage("a1"),
            new HumanMessage("h2"),
            new AIMessage("a2"),
        ];
        const kept = trimMessagesForContext(messages, 3);
        expect(kept[0].content).toBe("system");
        expect(kept[1].content).toBe("h1");
        expect(kept.some((message) => message._getType() === "tool")).toBe(
            true,
        );
    });

    it("is a no-op under the target", () => {
        const messages = [new HumanMessage("h1"), new AIMessage("a1")];
        expect(trimMessagesForContext(messages, 10)).toBe(messages);
    });
});

describe("trimGraphContext", () => {
    it("rewrites the checkpoint state with the trimmed messages", async () => {
        const graph = createAgentGraph({
            model: new StubModel() as unknown as Parameters<
                typeof createAgentGraph
            >[0]["model"],
            tools: [],
            checkpointer: new MemorySaver(),
        });
        const initial = [
            new SystemMessage("system"),
            new HumanMessage("h1"),
            new AIMessage("a1"),
            new HumanMessage("h2"),
            new AIMessage("a2"),
            new HumanMessage("h3"),
            new AIMessage("a3"),
        ];
        await graph.updateState(
            { configurable: { thread_id: "trim-thread" } },
            { messages: initial },
        );

        expect(await trimGraphContext(graph, "trim-thread", 4)).toBe(true);
        const state = await graph.getState({
            configurable: { thread_id: "trim-thread" },
        });
        expect(
            (state.values.messages as { content: unknown }[]).map(
                (message) => message.content,
            ),
        ).toEqual(["system", "h2", "a2", "h3", "a3"]);
    });
});

describe("pruneThreadVersions", () => {
    it("keeps the newest checkpoint versions and their writes", async () => {
        const db = new Database(":memory:");
        const saver = new SqliteSaver(db);
        // Trigger schema creation on the saver.
        await saver.getTuple({ configurable: { thread_id: "t1" } });
        const insertCheckpoint = db.prepare(
            "INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, '', ?, NULL, 'json', NULL, NULL)",
        );
        const insertWrite = db.prepare(
            "INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, '', ?, 'task', 0, 'messages', 'json', NULL)",
        );
        for (let i = 0; i < 5; i += 1) {
            insertCheckpoint.run("t1", `c${i}`);
            insertWrite.run("t1", `c${i}`);
        }
        expect(pruneThreadVersions(saver, "t1", 2)).toBe(3);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get(),
        ).toEqual({ n: 2 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM writes").get()).toEqual({
            n: 2,
        });
        db.close();
    });
});
