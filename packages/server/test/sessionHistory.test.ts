/**
 * Durable transcript service (#122): encryption, paging by row id, title
 * input, retention, and thread deletion.
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import { createChatCipher } from "../src/chatCrypto";
import {
    createChatHistoryService,
    MAX_STORED_ASSISTANT_CHARS,
} from "../src/sessionHistory";

const cipher = createChatCipher(Buffer.alloc(32, 9));

function setup(limits = { maxMessages: 2_000, maxBytes: 10 * 1024 * 1024 }) {
    const store = createInMemoryAppDatabase();
    const user = store.createUser("alice", "hash", "user");
    const session = store.claimSession("thread-1", {
        userId: user.id,
        deviceId: null,
        kind: "text",
    }).session;
    const deleteThread = vi.fn(async () => {});
    const history = createChatHistoryService({
        store,
        cipher,
        deleteThread,
        limits,
    });
    return { store, user, session, history, deleteThread };
}

describe("createChatHistoryService", () => {
    it("stores encrypted messages and returns decrypted pages", () => {
        const { store, session, history } = setup();
        history.append(session, [
            {
                role: "user",
                payload: {
                    kind: "user",
                    text: "hello",
                    attachmentIds: ["a1"],
                },
            },
            {
                role: "tool",
                payload: {
                    kind: "tool",
                    name: "webSearch",
                    args: { query: "x" },
                    output: "result",
                    sources: [{ title: "Source", url: "https://example.com" }],
                },
            },
            {
                role: "assistant",
                payload: { kind: "assistant", text: "world" },
            },
        ]);

        const raw = store.listChatMessages(session.id, { limit: 10 });
        expect(raw).toHaveLength(3);
        expect(raw[0].payload).not.toContain("hello");

        const page = history.page(session, { limit: 10 });
        expect(page.messages).toEqual([
            expect.objectContaining({
                role: "user",
                text: "hello",
                attachmentIds: ["a1"],
            }),
            expect.objectContaining({
                role: "tool",
                tool: expect.objectContaining({
                    name: "webSearch",
                    output: "result",
                }),
            }),
            expect.objectContaining({
                role: "assistant",
                text: "world",
            }),
        ]);
        expect(page.hasMore).toBe(false);
        expect(page.nextBefore).toBeNull();
    });

    it("pages older rows by the oldest loaded id", () => {
        const { session, history } = setup();
        const entries = Array.from({ length: 25 }, (_, index) => ({
            role: "user" as const,
            payload: {
                kind: "user" as const,
                text: `message ${index}`,
            },
        }));
        history.append(session, entries);

        const newest = history.page(session, { limit: 10 });
        expect(newest.messages).toHaveLength(10);
        expect(newest.messages[0].text).toBe("message 15");
        expect(newest.messages[9].text).toBe("message 24");
        expect(newest.hasMore).toBe(true);
        expect(newest.nextBefore).toBe(newest.messages[0].id);

        const older = history.page(session, {
            limit: 10,
            before: newest.nextBefore!,
        });
        expect(older.messages[0].text).toBe("message 5");
        expect(older.messages[9].text).toBe("message 14");
        expect(older.hasMore).toBe(true);

        const oldest = history.page(session, {
            limit: 10,
            before: older.nextBefore!,
        });
        expect(oldest.messages.map((message) => message.text)).toEqual([
            "message 0",
            "message 1",
            "message 2",
            "message 3",
            "message 4",
        ]);
        expect(oldest.hasMore).toBe(false);
    });

    it("derives the first exchange for title generation", () => {
        const { session, history } = setup();
        history.append(session, [
            { role: "user", payload: { kind: "user", text: "first" } },
            {
                role: "assistant",
                payload: { kind: "assistant", text: "answer" },
            },
            { role: "user", payload: { kind: "user", text: "later" } },
        ]);
        expect(history.firstExchange(session)).toEqual({
            user: "first",
            assistant: "answer",
        });
    });

    it("applies retention and marks the session trimmed", () => {
        const { store, session, history } = setup({
            maxMessages: 3,
            maxBytes: 10 * 1024 * 1024,
        });
        history.append(session, [
            { role: "user", payload: { kind: "user", text: "one" } },
            { role: "user", payload: { kind: "user", text: "two" } },
            { role: "user", payload: { kind: "user", text: "three" } },
            { role: "user", payload: { kind: "user", text: "four" } },
            { role: "user", payload: { kind: "user", text: "five" } },
        ]);
        expect(history.enforceRetention(session)).toBe(2);
        expect(
            history.page(session, { limit: 10 }).messages.map((m) => m.text),
        ).toEqual(["three", "four", "five"]);
        expect(
            store.getSessionByThread("thread-1")?.historyTrimmedAt,
        ).not.toBeNull();
    });

    it("caps an oversized assistant row", () => {
        const { session, history } = setup();
        history.append(session, [
            {
                role: "assistant",
                payload: {
                    kind: "assistant",
                    text: "x".repeat(MAX_STORED_ASSISTANT_CHARS + 50),
                },
            },
        ]);
        const text = history.page(session, { limit: 10 }).messages[0].text!;
        expect(text.length).toBeLessThan(MAX_STORED_ASSISTANT_CHARS + 20);
        expect(text).toContain("[truncated]");
    });

    it("deletes through the injected checkpoint seam", async () => {
        const { history, deleteThread } = setup();
        await history.deleteThread("thread-1");
        expect(deleteThread).toHaveBeenCalledWith("thread-1");
    });
});
