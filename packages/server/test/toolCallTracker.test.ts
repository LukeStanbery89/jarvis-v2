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

    it("drops the whitespace filler that would open a chat bubble", () => {
        // LM Studio answers tool-calling turns with bare `\n\n` before it
        // emits the call, and the client opens a *new* assistant bubble on
        // the first chunk after a tool — so forwarding it drew an empty
        // bubble above the tool call, and again below its result.
        expect(
            track(
                new AIMessage({ content: "\n\n" }),
                new AIMessage({ content: "\n\n" }),
                new AIMessage({ content: "Hello" }),
            ),
        ).toEqual([{ type: "token", text: "Hello" }]);
    });

    it("re-opens the text segment at every tool boundary", () => {
        const events = track(
            new AIMessage({ content: "\n\n" }),
            COMPLETE_CALL,
            new ToolMessage({
                content: "accepted",
                tool_call_id: "call-1",
                name: "getCurrentTime",
            }),
            new AIMessage({ content: "\n\n" }),
            new AIMessage({ content: "Done." }),
        );
        expect(events).toEqual([
            { type: "tool", name: "getCurrentTime", args: {} },
            {
                type: "toolResult",
                name: "getCurrentTime",
                output: "accepted",
            },
            { type: "token", text: "Done." },
        ]);
    });

    it("drops filler after a result even when the segment already held text", () => {
        const events = track(
            new AIMessage({ content: "Checking." }),
            COMPLETE_CALL,
            new ToolMessage({
                content: "ok",
                tool_call_id: "call-1",
                name: "getCurrentTime",
            }),
            new AIMessage({ content: "\n\n" }),
            new AIMessage({ content: "Done." }),
        );
        expect(events).toEqual([
            { type: "token", text: "Checking." },
            { type: "tool", name: "getCurrentTime", args: {} },
            { type: "toolResult", name: "getCurrentTime", output: "ok" },
            { type: "token", text: "Done." },
        ]);
    });

    it("streams whitespace that sits inside a segment untouched", () => {
        expect(
            track(
                new AIMessage({ content: "First" }),
                new AIMessage({ content: "\n\n" }),
                new AIMessage({ content: "second" }),
            ),
        ).toEqual([
            { type: "token", text: "First" },
            { type: "token", text: "\n\n" },
            { type: "token", text: "second" },
        ]);
    });

    it("yields nothing at all for a turn of pure filler", () => {
        // ws.ts counts a turn with no prose as an empty response; suppressing
        // the filler here must not mask that — it must still see zero tokens.
        expect(track(new AIMessage({ content: "\n\n" }))).toEqual([]);
    });

    it("reassembles LM Studio's id-once/index-elsewhere stream into one call", () => {
        // Regression reproducing the real wire capture: LM Studio sends the
        // call id only on the first delta; argument deltas carry just the
        // index. Keying chunks by `id ?? index` split one call into a
        // name-only entry (announced `{}` at result time) and an args-only
        // entry (announced mid-stream as the fallback name "tool").
        const events = track(
            new AIMessageChunk({
                tool_call_chunks: [
                    { id: "968981763", index: 0, name: "calculate", args: "" },
                ],
            }),
            new AIMessageChunk({
                tool_call_chunks: [{ index: 0, args: '{"' }],
            }),
            new AIMessageChunk({
                tool_call_chunks: [{ index: 0, args: "expression" }],
            }),
            new AIMessageChunk({
                tool_call_chunks: [{ index: 0, args: '":' }],
            }),
            new AIMessageChunk({
                tool_call_chunks: [{ index: 0, args: ' "' }],
            }),
            new AIMessageChunk({ tool_call_chunks: [{ index: 0, args: "1" }] }),
            new AIMessageChunk({
                tool_call_chunks: [{ index: 0, args: " +" }],
            }),
            new AIMessageChunk({
                tool_call_chunks: [{ index: 0, args: " 1" }],
            }),
            new AIMessageChunk({
                tool_call_chunks: [{ index: 0, args: '"}' }],
            }),
            new AIMessage({
                content: "",
                tool_calls: [
                    {
                        id: "968981763",
                        name: "calculate",
                        args: { expression: "1 + 1" },
                    },
                ],
            }),
            new ToolMessage({
                content: "2",
                tool_call_id: "968981763",
                name: "calculate",
            }),
        );
        expect(events).toEqual([
            { type: "tool", name: "calculate", args: { expression: "1 + 1" } },
            { type: "toolResult", name: "calculate", output: "2" },
        ]);
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
