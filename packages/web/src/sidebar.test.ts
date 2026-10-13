/**
 * Unit tests for the pure sidebar projection: merging server session rows with
 * local threads, and the wake-toggle description.
 */
import { describe, expect, it } from "vitest";
import { describeWakeState, mergeSessions } from "./sidebar";
import type { SessionSummary } from "./api";
import type { ThreadMap, ThreadRecord } from "./threads";

/** A session row with sensible defaults; override what the case exercises. */
function session(
    over: Partial<SessionSummary> & { threadId: string },
): SessionSummary {
    return {
        kind: "text",
        userId: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        ...over,
    };
}

/** A local thread record with sensible defaults. */
function thread(over: Partial<ThreadRecord> = {}): ThreadRecord {
    return {
        title: "Local",
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        ...over,
    };
}

describe("mergeSessions", () => {
    it("uses the local title and the later timestamp for a known thread", () => {
        const rows = [
            session({
                threadId: "abc12345def",
                lastActiveAt: "2026-01-01T00:00:00.000Z",
            }),
        ];
        const laterAt = Date.parse("2026-02-01T00:00:00.000Z");
        const threads: ThreadMap = {
            abc12345def: thread({ title: "My chat", updatedAt: laterAt }),
        };
        expect(mergeSessions(rows, threads)).toEqual([
            {
                id: "abc12345def",
                title: "My chat",
                lastActive: laterAt,
                kind: "text",
            },
        ]);
    });

    it("falls back to a short Thread <id> title for a server-only row", () => {
        const rows = [session({ threadId: "0123456789" })];
        expect(mergeSessions(rows, {})).toEqual([
            {
                id: "0123456789",
                title: "Thread 01234567",
                lastActive: Date.parse("2026-01-01T00:00:00.000Z"),
                kind: "text",
            },
        ]);
    });

    it("keeps the full id when it is short enough", () => {
        const rows = [session({ threadId: "short" })];
        expect(mergeSessions(rows, {})[0]?.title).toBe("Thread short");
    });

    it("includes local-only threads with their own title and no kind", () => {
        const threads: ThreadMap = {
            local1: thread({ title: "New chat", updatedAt: 10 }),
        };
        expect(mergeSessions([], threads)).toEqual([
            { id: "local1", title: "New chat", lastActive: 10 },
        ]);
    });

    it("preserves the server row's voice kind", () => {
        const rows = [session({ threadId: "voice1", kind: "voice" })];
        expect(mergeSessions(rows, {})[0]?.kind).toBe("voice");
    });

    it("sorts rows by lastActive descending", () => {
        const rows = [
            session({
                threadId: "old",
                lastActiveAt: "2026-01-01T00:00:00.000Z",
            }),
            session({
                threadId: "new",
                lastActiveAt: "2026-03-01T00:00:00.000Z",
            }),
        ];
        expect(mergeSessions(rows, {}).map((row) => row.id)).toEqual([
            "new",
            "old",
        ]);
    });
});

describe("describeWakeState", () => {
    it("reports unavailability when the feature is off", () => {
        expect(describeWakeState(false, false)).toBe("Wake word unavailable");
    });

    it("reports armed listening when available and armed", () => {
        expect(describeWakeState(true, true)).toBe(
            "Listening for “Hey JARVIS”",
        );
    });

    it("reports off when available but not armed", () => {
        expect(describeWakeState(true, false)).toBe("Wake word off");
    });
});
