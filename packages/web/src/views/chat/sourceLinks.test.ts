/**
 * Source bookkeeping for the chat transcript (#199).
 *
 * Node-only: the helpers take plain transcript messages and return the link
 * list a static renderer can display. The browser allowlist is exercised in
 * `safeHref.test.ts`; here the important behavior is grouping and rejecting
 * anything a tool might have slipped into the source list.
 */
import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "../../threads";
import { groupSources, sourceLinks } from "./sourceLinks";

const sources = [
    { title: "Cyan - Wikipedia", url: "https://en.wikipedia.org/wiki/Cyan" },
    {
        title: "Color - Britannica",
        url: "https://www.britannica.com/science/color",
    },
];

function user(id: string, text: string): ThreadMessage {
    return { id, role: "user", text, at: 1 };
}

function tool(
    id: string,
    sourceList: { title: string; url: string }[] = sources,
): ThreadMessage {
    return {
        id,
        role: "tool",
        tool: { name: "webSearch", output: "results", sources: sourceList },
        at: 2,
    };
}

function assistant(id: string, text: string): ThreadMessage {
    return { id, role: "assistant", text, at: 3 };
}

describe("sourceLinks", () => {
    it("vets, normalizes, de-duplicates, and labels sources", () => {
        expect(
            sourceLinks([
                sources[0]!,
                { title: "", url: "https://www.example.com/page" },
                {
                    title: "duplicate",
                    url: "https://en.wikipedia.org/wiki/Cyan",
                },
                { title: "bad", url: "javascript:alert(1)" },
                { title: "bad", url: "mailto:someone@example.com" },
            ]),
        ).toEqual([
            {
                title: "Cyan - Wikipedia",
                href: "https://en.wikipedia.org/wiki/Cyan",
                domain: "en.wikipedia.org",
            },
            {
                title: "example.com",
                href: "https://www.example.com/page",
                domain: "example.com",
            },
        ]);
    });
});

describe("groupSources", () => {
    it("attaches a turn's sources to its final assistant answer", () => {
        const groups = groupSources([
            user("u1", "first"),
            tool("t1"),
            assistant("a1", "an intermediate thought"),
            assistant("a2", "the answer"),
            user("u2", "second"),
            tool("t2", [sources[1]!]),
            assistant("a3", "another answer"),
        ]);

        expect(groups.byAssistant.get("a1")).toBeUndefined();
        expect(groups.byAssistant.get("a2")).toEqual(sources);
        expect(groups.byAssistant.get("a3")).toEqual([sources[1]]);
        expect(groups.currentAssistantId).toBe("a3");
    });

    it("leaves a turn without an answer unassigned", () => {
        const groups = groupSources([user("u1", "search"), tool("t1")]);

        expect(groups.byAssistant.size).toBe(0);
        expect(groups.currentAssistantId).toBeNull();
    });

    it("combines sources from every search in a turn", () => {
        const groups = groupSources([
            user("u1", "compare"),
            tool("t1", [sources[0]!]),
            assistant("a1", "let me check another angle"),
            tool("t2", [sources[1]!]),
            assistant("a2", "the answer"),
        ]);

        expect(groups.byAssistant.get("a2")).toEqual(sources);
    });
});
