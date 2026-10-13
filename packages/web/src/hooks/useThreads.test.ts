/**
 * Unit tests for the transcript reducer: each action routes through the pure
 * `threads.ts` helpers and produces the expected thread-map transition.
 */
import { describe, expect, it } from "vitest";
import { threadsReducer } from "./useThreads";

describe("threadsReducer", () => {
    it("ensures a thread, then appends and auto-titles on the first user message", () => {
        let map = threadsReducer(
            {},
            { type: "ensure", sessionId: "s1", at: 1 },
        );
        expect(map.s1).toMatchObject({ title: "New chat", createdAt: 1 });
        map = threadsReducer(map, {
            type: "user",
            sessionId: "s1",
            text: "Hello there",
            at: 2,
        });
        expect(map.s1?.title).toBe("Hello there");
        expect(map.s1?.messages).toHaveLength(1);
        expect(map.s1?.messages[0]).toMatchObject({
            role: "user",
            text: "Hello there",
            at: 2,
        });
    });

    it("carries attachment ids on the user message", () => {
        const map = threadsReducer(
            {},
            {
                type: "user",
                sessionId: "s1",
                text: "see pic",
                at: 2,
                attachmentIds: ["a1"],
            },
        );
        expect(map.s1?.messages[0]).toMatchObject({ attachmentIds: ["a1"] });
    });

    it("merges chunks into the trailing assistant message", () => {
        let map = threadsReducer(
            {},
            {
                type: "user",
                sessionId: "s1",
                text: "hi",
                at: 1,
            },
        );
        map = threadsReducer(map, {
            type: "chunk",
            sessionId: "s1",
            text: "wor",
            at: 2,
        });
        map = threadsReducer(map, {
            type: "chunk",
            sessionId: "s1",
            text: "ld",
            at: 3,
        });
        const messages = map.s1?.messages ?? [];
        expect(messages).toHaveLength(2);
        expect(messages[messages.length - 1]).toMatchObject({
            role: "assistant",
            text: "world",
        });
    });

    it("merges a toolResult into the trailing tool notice", () => {
        let map = threadsReducer(
            {},
            {
                type: "tool",
                sessionId: "s1",
                name: "calc",
                args: { a: 1 },
                at: 1,
            },
        );
        map = threadsReducer(map, {
            type: "toolResult",
            sessionId: "s1",
            name: "calc",
            output: 2,
            at: 2,
        });
        const messages = map.s1?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            role: "tool",
            tool: { name: "calc", output: 2 },
        });
    });

    it("records an assistant error marker", () => {
        let map = threadsReducer(
            {},
            {
                type: "user",
                sessionId: "s1",
                text: "hi",
                at: 1,
            },
        );
        map = threadsReducer(map, {
            type: "assistantError",
            sessionId: "s1",
            text: "failed",
            at: 2,
        });
        const messages = map.s1?.messages ?? [];
        expect(messages[messages.length - 1]).toMatchObject({
            role: "assistant",
            text: "failed",
            error: true,
        });
    });

    it("deletes a thread", () => {
        let map = threadsReducer(
            {},
            { type: "ensure", sessionId: "s1", at: 1 },
        );
        map = threadsReducer(map, { type: "deleted", sessionId: "s1" });
        expect(map.s1).toBeUndefined();
    });
});
