/**
 * End-to-end wiring for the two-role graph (#214).
 *
 * The graph suite exercises the topology directly. This test goes through the
 * real `initAgentGraph`/`runAgent` seam with scripted model instances, so a
 * missing prompt handoff or a roles-off regression fails here rather than only
 * under a live 35B model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    type BaseMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { AgentEvent } from "../src/llm/event";

const roleModels = vi.hoisted(() => ({
    writer: undefined as unknown,
    router: undefined as unknown,
}));

vi.mock("../src/llm/chatModel", () => ({
    createChatModel: (options: { role?: string } = {}) =>
        options.role === "router" ? roleModels.router : roleModels.writer,
}));

import { initAgentGraph, runAgent } from "../src/agent";

/** A model that returns scripted replies and records every input. */
class ScriptedChatModel extends BaseChatModel {
    public readonly callInputs: BaseMessage[][] = [];
    private index = 0;

    constructor(private readonly responses: BaseMessage[]) {
        super({});
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
            this.responses[Math.min(this.index, this.responses.length - 1)]!;
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

describe("model role wiring (#214)", () => {
    const checkpointDir = mkdtempSync(join(tmpdir(), "jarvis-model-roles-"));
    const writer = new ScriptedChatModel([
        new AIMessage({ content: "It is 3:26 PM." }),
    ]);
    const router = new ScriptedChatModel([
        new AIMessage({
            content: "I will check the clock.",
            tool_calls: [
                {
                    id: "live-call-1",
                    name: "getCurrentTime",
                    args: { question: "what time is it?" },
                },
            ],
        }),
        new AIMessage({ content: "Routing complete." }),
    ]);

    beforeAll(() => {
        roleModels.writer = writer;
        roleModels.router = router;
        process.env.JARVIS_CHECKPOINT_PATH = join(
            checkpointDir,
            "checkpoints.sqlite",
        );
        process.env.LLM_MODEL = "writer-test";
        process.env.LLM_ROUTER_MODEL = "router-test";
        initAgentGraph(undefined, {
            checkpointSerde: new MemorySaver().serde,
        });
    });

    afterAll(() => {
        delete process.env.JARVIS_CHECKPOINT_PATH;
        delete process.env.LLM_MODEL;
        delete process.env.LLM_ROUTER_MODEL;
        rmSync(checkpointDir, { recursive: true, force: true });
    });

    it("runs a split turn through runAgent with the role prompts", async () => {
        const events: AgentEvent[] = [];
        for await (const event of runAgent(
            "what time is it?",
            "model-roles-smoke",
        )) {
            events.push(event);
        }

        const tokens = events
            .filter(
                (event): event is { type: "token"; text: string } =>
                    event.type === "token",
            )
            .map((event) => event.text)
            .join("");
        expect(tokens).toBe("It is 3:26 PM.");
        expect(events.filter((event) => event.type === "tool")).toHaveLength(1);
        expect(
            events.filter((event) => event.type === "toolResult"),
        ).toHaveLength(1);

        const routerSystem = router.callInputs[0]![0]!;
        const writerSystem = writer.callInputs[0]![0]!;
        expect(String(routerSystem.content)).toMatch(
            /You are the tool router for this turn/,
        );
        expect(String(routerSystem.content)).toMatch(
            /exactly one tool call at a time/,
        );
        expect(String(writerSystem.content)).toMatch(
            /Tool work for this turn has already been handled/,
        );
        expect(String(writerSystem.content)).not.toMatch(
            /exactly one tool call at a time/,
        );
        expect(
            writer.callInputs[0]!.some(
                (message: BaseMessage) => message instanceof HumanMessage,
            ),
        ).toBe(true);
    });
});
