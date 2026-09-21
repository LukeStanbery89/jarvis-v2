import { describe, expect, it } from "vitest";
import {
    AIMessage,
    AIMessageChunk,
    ToolMessage,
} from "@langchain/core/messages";
import { ToolCallTracker, type AgentEvent } from "../src/llm/toolCallTracker";

/** Convenience: run `messages` through one tracker and flatten the events. */
function track(...messages: unknown[]): AgentEvent[] {
    const tracker = new ToolCallTracker();
    const events: AgentEvent[] = [];
    for (const message of messages) {
        events.push(
            ...tracker.onMessage(
                message as Parameters<ToolCallTracker["onMessage"]>[0],
            ),
        );
    }
    return events;
}

const COMPLETE_CALL = new AIMessage({
    content: "",
    tool_calls: [{ id: "call-1", name: "getCurrentTime", args: {} }],
});

describe("ToolCallTracker", () => {
    it("announces a complete tool_calls payload exactly once", () => {
        expect(track(COMPLETE_CALL)).toEqual([
            { type: "tool", name: "getCurrentTime", args: {} },
        ]);
        expect(track(COMPLETE_CALL, COMPLETE_CALL)).toHaveLength(1);
    });

    it("announces one tool event per distinct call", () => {
        const multi = new AIMessage({
            content: "",
            tool_calls: [
                { id: "a", name: "getCurrentTime", args: {} },
                { id: "b", name: "calculate", args: { expression: "2+2" } },
            ],
        });
        expect(track(multi)).toEqual([
            { type: "tool", name: "getCurrentTime", args: {} },
            { type: "tool", name: "calculate", args: { expression: "2+2" } },
        ]);
        expect(track(multi, multi)).toHaveLength(2);
    });

    it("announces from accumulated chunks once the name is known", () => {
        const complete = new AIMessage({
            content: "",
            tool_calls: [{ id: "call-9", name: "getCurrentTime", args: {} }],
        });
        const events = track(
            new AIMessageChunk({
                tool_call_chunks: [
                    { id: "call-9", name: "getCurrentTime", args: "{}" },
                ],
            }),
            complete,
        );
        expect(events).toEqual([
            { type: "tool", name: "getCurrentTime", args: {} },
        ]);
    });

    it("emits one correct tool event when name arrives under a different key than args", () => {
        // Regression: LM Studio streams the tool-call name keyed by index and
        // the complete args keyed by id. Before the fix this leaked a second
        // `{ type: "tool", name: "tool" }` frame.
        const events = track(
            new AIMessageChunk({
                tool_call_chunks: [
                    { index: 0, name: "getCurrentTime", args: "" },
                ],
            }),
            new AIMessageChunk({
                tool_call_chunks: [{ id: "call-1", name: "", args: "{}" }],
            }),
            COMPLETE_CALL,
        );
        expect(events).toEqual([
            { type: "tool", name: "getCurrentTime", args: {} },
        ]);
    });

    it("waits for the final message when a chunk's name is still unknown", () => {
        const events = track(
            new AIMessageChunk({
                tool_call_chunks: [{ id: "call-2", name: "", args: "{}" }],
            }),
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "call-2",
                        name: "calculate",
                        args: { expression: "1" },
                    },
                ],
            }),
        );
        expect(events).toEqual([
            { type: "tool", name: "calculate", args: { expression: "1" } },
        ]);
    });

    it("yields a token for plain text, but never while chunks are streaming", () => {
        expect(track(new AIMessage({ content: "hello" }))).toEqual([
            { type: "token", text: "hello" },
        ]);
        expect(
            track(
                new AIMessageChunk({
                    content: "reasoning",
                    tool_call_chunks: [{ id: "c2", name: "x", args: "{}" }],
                }),
            ),
        ).toEqual([{ type: "tool", name: "x", args: {} }]);
    });

    it("announces a call at toolResult time if it was never announced", () => {
        expect(
            track(
                new ToolMessage({
                    content: "2026-09-20T00:00:00.000Z",
                    tool_call_id: "call-1",
                    name: "getCurrentTime",
                }),
            ),
        ).toEqual([
            { type: "tool", name: "getCurrentTime", args: {} },
            {
                type: "toolResult",
                name: "getCurrentTime",
                output: "2026-09-20T00:00:00.000Z",
            },
        ]);
    });

    it("reuses the tracked name and args for the toolResult", () => {
        expect(
            track(
                new AIMessageChunk({
                    tool_call_chunks: [
                        { id: "call-3", name: "getCurrentTime", args: "{}" },
                    ],
                }),
                new ToolMessage({
                    content: "2026-09-20T00:00:00.000Z",
                    tool_call_id: "call-3",
                }),
            ),
        ).toEqual([
            { type: "tool", name: "getCurrentTime", args: {} },
            {
                type: "toolResult",
                name: "getCurrentTime",
                output: "2026-09-20T00:00:00.000Z",
            },
        ]);
    });
});
