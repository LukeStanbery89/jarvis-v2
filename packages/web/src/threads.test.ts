/**
 * Unit tests for the client-side transcript store: pure mutation helpers
 * (append/stream/error/trim/delete), persistence round-trips through an
 * injected fake storage, and the quota-eviction fallback.
 */
import { describe, expect, it } from "vitest";
import {
    appendChunk,
    appendMessage,
    appendToolResult,
    deleteThread,
    ensureThread,
    hydrateThread,
    loadThreads,
    markAssistantError,
    NEW_CHAT_TITLE,
    prependThreadHistory,
    saveThreads,
    setThreadTitle,
    threadsKey,
    type ThreadMap,
} from "./threads";
import type { SessionDetail } from "./api";

/** In-memory Storage double for node tests. */
class FakeStorage implements Storage {
    private map = new Map<string, string>();
    /** When set, the next setItem throws a quota error once. */
    failNextOnce = false;

    get length(): number {
        return this.map.size;
    }

    clear(): void {
        this.map.clear();
    }

    getItem(key: string): string | null {
        return this.map.get(key) ?? null;
    }

    key(index: number): string | null {
        return [...this.map.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.map.delete(key);
    }

    setItem(key: string, value: string): void {
        if (this.failNextOnce) {
            this.failNextOnce = false;
            throw new DOMException("quota", "QuotaExceededError");
        }
        this.map.set(key, value);
    }
}

describe("thread mutations", () => {
    it("ensureThread creates an untitled thread once", () => {
        const map = ensureThread({}, "s1", 1);
        expect(map.s1).toMatchObject({
            title: NEW_CHAT_TITLE,
            createdAt: 1,
            messages: [],
        });
        expect(ensureThread(map, "s1", 2)).toBe(map);
    });

    it("appendMessage auto-titles from the first user message (capped at 60 chars)", () => {
        let map = appendMessage({}, "s1", {
            id: "m1",
            role: "user",
            text: "a".repeat(70),
            at: 1,
        });
        expect(map.s1?.title).toBe(`${"a".repeat(60)}…`);
        map = appendMessage(map, "s1", {
            id: "m2",
            role: "user",
            text: "second",
            at: 2,
        });
        expect(map.s1?.title).toBe(`${"a".repeat(60)}…`);
    });

    it("appendChunk grows the trailing assistant message", () => {
        let map = appendMessage({}, "s1", {
            id: "m1",
            role: "user",
            text: "hi",
            at: 1,
        });
        map = appendChunk(map, "s1", "Hel", 2);
        map = appendChunk(map, "s1", "lo", 3);
        const messages = map.s1?.messages ?? [];
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatchObject({ role: "assistant", text: "Hello" });
    });

    it("appendChunk starts a fresh assistant message after user/tool turns", () => {
        let map = appendChunk(ensureThread({}, "s1", 1), "s1", "one", 2);
        map = appendMessage(map, "s1", {
            id: "t1",
            role: "tool",
            tool: { name: "calc" },
            at: 3,
        });
        map = appendChunk(map, "s1", "two", 4);
        const roles = (map.s1?.messages ?? []).map((m) => m.role);
        expect(roles).toEqual(["assistant", "tool", "assistant"]);
    });

    it("appendToolResult merges the output into the trailing matching tool call", () => {
        let map = appendMessage(ensureThread({}, "s1", 1), "s1", {
            id: "t1",
            role: "tool",
            tool: { name: "calc", args: { expression: "3 + 3" } },
            at: 2,
        });
        map = appendToolResult(map, "s1", "calc", 6, 3);
        const messages = map.s1?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
            id: "t1",
            role: "tool",
            tool: {
                name: "calc",
                args: { expression: "3 + 3" },
                output: 6,
            },
            at: 2,
        });
    });

    it("appendToolResult stores original sources beside the output (#199)", () => {
        const sources = [
            {
                title: "Cyan - Wikipedia",
                url: "https://en.wikipedia.org/wiki/Cyan",
            },
        ];
        let map = appendMessage(ensureThread({}, "s1", 1), "s1", {
            id: "t1",
            role: "tool",
            tool: { name: "webSearch", args: { query: "cyan" } },
            at: 2,
        });
        map = appendToolResult(map, "s1", "webSearch", "results", 3, sources);

        expect(map.s1?.messages?.[0]).toMatchObject({
            role: "tool",
            tool: { name: "webSearch", output: "results", sources },
        });
    });

    it("appendToolResult appends a standalone notice for a mismatched/absent call", () => {
        let map = appendMessage(ensureThread({}, "s1", 1), "s1", {
            id: "t1",
            role: "tool",
            tool: { name: "calc" },
            at: 2,
        });
        map = appendToolResult(map, "s1", "other", "x", 3);
        const roles = (map.s1?.messages ?? []).map((m) => m.role);
        expect(roles).toEqual(["tool", "tool"]);
        expect(map.s1?.messages?.[1]).toMatchObject({
            role: "tool",
            tool: { name: "other", output: "x" },
        });

        const fresh = appendToolResult({}, "s1", "solo", "y", 4);
        const solo = fresh.s1?.messages ?? [];
        expect(solo).toHaveLength(1);
        expect(solo[0]).toMatchObject({
            role: "tool",
            tool: { name: "solo", output: "y" },
        });
    });

    it("appendChunk ignores unknown sessions", () => {
        const map: ThreadMap = {};
        expect(appendChunk(map, "ghost", "x", 1)).toBe(map);
    });

    it("markAssistantError styles a failed turn without clobbering streamed text", () => {
        let map = appendChunk(ensureThread({}, "s1", 1), "s1", "partial", 2);
        map = markAssistantError(map, "s1", "the request failed", 3);
        const messages = map.s1?.messages ?? [];
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
            role: "assistant",
            text: "partial",
        });
        expect(messages[1]).toMatchObject({
            role: "assistant",
            text: "the request failed",
            error: true,
        });
    });

    it("deleteThread removes the thread", () => {
        const map = ensureThread({}, "s1", 1);
        expect(Object.keys(deleteThread(map, "s1"))).toHaveLength(0);
        expect(deleteThread(map, "ghost")).toBe(map);
    });

    it("keeps every loaded message in memory for paging", () => {
        let map = ensureThread({}, "s1", 0);
        for (let i = 0; i < 205; i += 1) {
            map = appendMessage(map, "s1", {
                id: `m${i}`,
                role: "user",
                text: `m${i}`,
                at: i,
            });
        }
        const messages = map.s1?.messages ?? [];
        expect(messages).toHaveLength(205);
        expect(messages[0]).toMatchObject({ id: "m0" });
        expect(messages[204]).toMatchObject({ id: "m204" });
    });
});

describe("thread persistence", () => {
    it("persists metadata but never message bodies", () => {
        const storage = new FakeStorage();
        const map = appendChunk(ensureThread({}, "s1", 1), "s1", "hi", 2);
        saveThreads(storage, "luke", map);
        expect(loadThreads(storage, "luke")).toEqual({
            s1: { ...map.s1!, messages: [] },
        });
    });

    it("loads an empty map when absent or corrupt", () => {
        const storage = new FakeStorage();
        expect(loadThreads(storage, "luke")).toEqual({});
        storage.setItem(threadsKey("luke"), "{not json");
        expect(loadThreads(storage, "luke")).toEqual({});
    });

    it("namespaces per user", () => {
        const storage = new FakeStorage();
        saveThreads(storage, "luke", ensureThread({}, "s1", 1));
        expect(loadThreads(storage, "other")).toEqual({});
    });

    it("evicts the oldest thread once on quota exhaustion", () => {
        const storage = new FakeStorage();
        storage.failNextOnce = true;
        const map = {
            ...ensureThread(ensureThread({}, "old", 1), "new", 2),
        };
        saveThreads(storage, "luke", map);
        const persisted = loadThreads(storage, "luke");
        expect(persisted.old).toBeUndefined();
        expect(persisted.new).toBeDefined();
    });
});

/** One server detail page with a title and paging cursor. */
function detail(over: Partial<SessionDetail> = {}): SessionDetail {
    return {
        threadId: "s1",
        kind: "text",
        userId: 1,
        title: "Server title",
        historyTrimmed: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
        messages: [
            { id: 10, role: "user", text: "hello", attachmentIds: ["a1"] },
            {
                id: 11,
                role: "tool",
                tool: {
                    name: "webSearch",
                    args: { query: "x" },
                    output: "result",
                    sources: [{ title: "Source", url: "https://example.com" }],
                },
            },
            { id: 12, role: "assistant", text: "answer" },
        ],
        hasMore: true,
        nextBefore: 10,
        ...over,
    };
}

describe("server history hydration", () => {
    it("replaces a thread with the decrypted server page", () => {
        const map = hydrateThread({}, "s1", detail(), 5);
        expect(map.s1?.title).toBe("Server title");
        expect(map.s1?.hasMore).toBe(true);
        expect(map.s1?.nextBefore).toBe(10);
        expect(map.s1?.messages).toHaveLength(3);
        expect(map.s1?.messages[0]).toMatchObject({
            id: "history:10",
            role: "user",
            text: "hello",
            attachmentIds: ["a1"],
        });
        expect(map.s1?.messages[1]).toMatchObject({
            id: "history:11",
            role: "tool",
            tool: { name: "webSearch", output: "result" },
        });
        expect(map.s1?.messages[2]).toMatchObject({
            id: "history:12",
            role: "assistant",
            text: "answer",
        });
    });

    it("prepends an older page and keeps the newer tail", () => {
        const map = hydrateThread({}, "s1", detail(), 5);
        const older = detail({
            messages: [{ id: 8, role: "user", text: "earlier" }],
            hasMore: false,
            nextBefore: null,
        });
        const next = prependThreadHistory(map, "s1", older);
        expect(next.s1?.messages[0]).toMatchObject({
            id: "history:8",
            text: "earlier",
        });
        expect(next.s1?.messages).toHaveLength(4);
        expect(next.s1?.hasMore).toBe(false);
        expect(next.s1?.nextBefore).toBeNull();
    });

    it("updates a title without moving the thread", () => {
        const map = hydrateThread({}, "s1", detail(), 5);
        const next = setThreadTitle(map, "s1", "Better title");
        expect(next.s1?.title).toBe("Better title");
        expect(next.s1?.updatedAt).toBe(map.s1?.updatedAt);
        expect(next.s1?.messages).toEqual(map.s1?.messages);
    });
});
