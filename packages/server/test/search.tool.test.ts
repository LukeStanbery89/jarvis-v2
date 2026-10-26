import { describe, expect, it } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import {
    createWebSearchTool,
    formatSearchAnswer,
    searchSources,
} from "../src/llm/tools/webSearch";
import { SearchError } from "../src/llm/tools/search/types";
import { FixedWindowQuota } from "../src/rate/fixedWindowQuota";
import type {
    SearchAnswer,
    SearchProvider,
    SearchVertical,
} from "../src/llm/tools/search/types";

/** A scripted provider recording its calls; throws when scripted to fail. */
function fakeProvider(
    name: "tavily" | "serper",
    script: Map<SearchVertical, string | Error>,
): {
    provider: SearchProvider;
    calls: { query: string; vertical: SearchVertical }[];
} {
    const calls: { query: string; vertical: SearchVertical }[] = [];
    return {
        calls,
        provider: {
            name,
            async search(query, vertical) {
                calls.push({ query, vertical });
                const outcome = script.get(vertical);
                if (outcome instanceof Error) {
                    throw outcome;
                }
                return {
                    provider: name,
                    summary: `summary via ${name}`,
                    results: [
                        {
                            title: `Result via ${name}`,
                            url: `https://${name}.example/r`,
                            snippet: "snippet text",
                        },
                    ],
                };
            },
        },
    };
}

const OWNER_CONFIG = { configurable: { userId: 7 } };

/**
 * Normalizes a direct tool invocation to its model-facing text.
 *
 * A direct `invoke` has no tool-call id, so LangChain returns the content
 * string; the declared `content_and_artifact` output type is the tuple. The
 * artifact is covered separately by the tracker test.
 */
function textOf(result: unknown): string {
    return typeof result === "string"
        ? result
        : (result as [string, unknown])[0];
}

/** Runs the tool with the given providers; returns its text result. */
async function run(
    providers: SearchProvider[],
    { query = "test", kind }: { query?: string; kind?: SearchVertical } = {},
    quota = new FixedWindowQuota(10),
): Promise<string> {
    const tool = createWebSearchTool({ providers, quota });
    return textOf(
        await tool.invoke(
            kind === undefined ? { query } : { query, kind },
            OWNER_CONFIG,
        ),
    );
}

describe("webSearch routing", () => {
    it("prefers tavily on its verticals (general, news, finance)", async () => {
        const tavily = fakeProvider("tavily", new Map());
        const serper = fakeProvider("serper", new Map());
        for (const vertical of ["general", "news", "finance"] as const) {
            const result = await run([tavily.provider, serper.provider], {
                kind: vertical,
            });
            expect(result).toContain("via tavily");
            expect(serper.calls).toHaveLength(0);
        }
        expect(tavily.calls).toHaveLength(3);
    });

    it("sends serper-only verticals straight to serper", async () => {
        const tavily = fakeProvider("tavily", new Map());
        const serper = fakeProvider("serper", new Map());
        for (const vertical of [
            "images",
            "videos",
            "places",
            "reviews",
            "patents",
            "shopping",
            "scholar",
        ] as const) {
            const result = await run([tavily.provider, serper.provider], {
                kind: vertical,
            });
            expect(result).toContain("via serper");
        }
        expect(tavily.calls).toHaveLength(0);
        expect(serper.calls).toHaveLength(7);
    });

    it("falls back to serper when tavily fails on a shared vertical", async () => {
        const tavily = fakeProvider(
            "tavily",
            new Map([["news", new SearchError("tavily returned 500")]]),
        );
        const serper = fakeProvider("serper", new Map());
        const result = await run([tavily.provider, serper.provider], {
            kind: "news",
        });
        expect(result).toContain("via serper");
        expect(serper.calls).toEqual([{ query: "test", vertical: "news" }]);
    });

    it("falls back to serper when tavily is not configured", async () => {
        const serper = fakeProvider("serper", new Map());
        const result = await run([serper.provider], { kind: "general" });
        expect(result).toContain("via serper");
    });

    it("attaches the original links as the tool-call artifact (#199)", async () => {
        const tavily = fakeProvider("tavily", new Map());
        const tool = createWebSearchTool({
            providers: [tavily.provider],
            quota: new FixedWindowQuota(10),
        });
        const result = await tool.invoke(
            {
                type: "tool_call",
                id: "call-search",
                name: "webSearch",
                args: { query: "test" },
            },
            OWNER_CONFIG,
        );

        expect(result).toBeInstanceOf(ToolMessage);
        const message = result as ToolMessage;
        expect(message.content).toContain("Result via tavily");
        expect(message.artifact).toEqual([
            {
                title: "Result via tavily",
                url: "https://tavily.example/r",
            },
        ]);
    });

    it("reports failure as model-facing text when every provider fails", async () => {
        const tavily = fakeProvider(
            "tavily",
            new Map([["general", new SearchError("tavily returned 500")]]),
        );
        const serper = fakeProvider(
            "serper",
            new Map([["general", new SearchError("serper returned 500")]]),
        );
        const result = await run([tavily.provider, serper.provider]);
        expect(result).toMatch(/web search failed/i);
        expect(result).not.toContain("500"); // raw internals stay out of the transcript
    });
});

describe("webSearch metering", () => {
    it("refuses past the per-user quota before any provider call", async () => {
        const tavily = fakeProvider("tavily", new Map());
        const quota = new FixedWindowQuota(2);
        await run([tavily.provider], {}, quota);
        await run([tavily.provider], {}, quota);
        const result = await run([tavily.provider], {}, quota);
        expect(result).toMatch(/rate limited.*try again in about \d+s/i);
        expect(tavily.calls).toHaveLength(2); // the refused call never fetched
    });

    it("refuses without an authenticated user id (defense in depth)", async () => {
        const tavily = fakeProvider("tavily", new Map());
        const tool = createWebSearchTool({
            providers: [tavily.provider],
            quota: new FixedWindowQuota(10),
        });
        const result = textOf(await tool.invoke({ query: "q" }, {}));
        expect(result).toMatch(/requires signing in/i);
        expect(tavily.calls).toHaveLength(0);
    });

    it("keys the quota per user", async () => {
        const tavily = fakeProvider("tavily", new Map());
        const tool = createWebSearchTool({
            providers: [tavily.provider],
            quota: new FixedWindowQuota(1),
        });
        const first = textOf(
            await tool.invoke({ query: "q" }, { configurable: { userId: 1 } }),
        );
        expect(first).toContain("Result via tavily");
        // A different user's budget is untouched.
        const other = textOf(
            await tool.invoke({ query: "q" }, { configurable: { userId: 2 } }),
        );
        expect(other).toContain("Result via tavily");
        expect(tavily.calls).toHaveLength(2);
    });
});

describe("webSearch registry gating", () => {
    it("omits webSearch when no search deps are configured", async () => {
        const { createTools } = await import("../src/llm/tools/index");
        const { createAttachmentStore } =
            await import("../src/attachments/store");
        const { DEFAULT_ATTACHMENT_CONFIG } = await import("../src/config");
        const { createVisionModel } = await import("../src/llm/visionModel");
        const { getLlmConfig } = await import("../src/config");
        const deps = {
            attachments: createAttachmentStore(DEFAULT_ATTACHMENT_CONFIG),
            vision: createVisionModel(getLlmConfig()),
            vlLimiter: new FixedWindowQuota(10),
        };
        const names = createTools(deps).map((t) => t.name);
        expect(names).toEqual(["getCurrentTime", "calculate", "analyzeImage"]);
        expect(names).not.toContain("webSearch");
    });
});

describe("formatSearchAnswer", () => {
    it("leads with the summary and numbers the results", () => {
        const text = formatSearchAnswer({
            provider: "tavily",
            summary: "Cyan is a greenish-blue.",
            results: [
                {
                    title: "Cyan - Wikipedia",
                    url: "https://en.wikipedia.org/wiki/Cyan",
                    snippet: "between blue and green",
                },
                { title: "No snippet", url: "https://x.example/", snippet: "" },
            ],
        });
        expect(text).toBe(
            "Cyan is a greenish-blue.\n\n" +
                "1. Cyan - Wikipedia — https://en.wikipedia.org/wiki/Cyan\n" +
                "   between blue and green\n" +
                "2. No snippet — https://x.example/",
        );
    });

    it("says plainly when a search comes back empty", () => {
        expect(formatSearchAnswer({ provider: "serper", results: [] })).toBe(
            "No results found.",
        );
    });
});

describe("searchSources (#199)", () => {
    it("maps search results to the presentation links", () => {
        expect(
            searchSources({
                provider: "tavily",
                results: [
                    {
                        title: "Cyan - Wikipedia",
                        url: "https://en.wikipedia.org/wiki/Cyan",
                        snippet: "between blue and green",
                    },
                    {
                        title: "",
                        url: "https://example.com/untitled",
                        snippet: "",
                    },
                ],
            }),
        ).toEqual([
            {
                title: "Cyan - Wikipedia",
                url: "https://en.wikipedia.org/wiki/Cyan",
            },
            {
                title: "https://example.com/untitled",
                url: "https://example.com/untitled",
            },
        ]);
    });

    it("skips a result with no URL", () => {
        expect(
            searchSources({
                provider: "serper",
                results: [
                    { title: "no link", url: "   ", snippet: "" },
                    { title: "kept", url: "https://example.com/", snippet: "" },
                ],
            }),
        ).toEqual([{ title: "kept", url: "https://example.com/" }]);
    });
});

describe("webSearch signal threading (#103)", () => {
    /** A scripted provider recording the signals it was handed. */
    function fakeWithSignal(outcome?: SearchAnswer | Error): {
        provider: SearchProvider;
        signals: (AbortSignal | undefined)[];
    } {
        const signals: (AbortSignal | undefined)[] = [];
        return {
            signals,
            provider: {
                name: "tavily",
                async search(_query, _vertical, signal) {
                    signals.push(signal);
                    if (outcome instanceof Error) {
                        throw outcome;
                    }
                    return outcome ?? { provider: "tavily", results: [] };
                },
            },
        };
    }

    it("passes the turn's signal to the provider", async () => {
        const controller = new AbortController();
        const fake = fakeWithSignal();
        const tool = createWebSearchTool({
            providers: [fake.provider],
            quota: new FixedWindowQuota(10),
        });
        await tool.invoke(
            { query: "q" },
            { configurable: { userId: 7 }, signal: controller.signal },
        );
        expect(fake.signals).toEqual([controller.signal]);
    });

    it("rejects instead of falling through to the next provider when cancelled", async () => {
        // throwIfAborted in the loop's catch: a cancelled turn must ride the
        // graph's bare-done path, not spend the fallback provider.
        const controller = new AbortController();
        controller.abort();
        const first = fakeWithSignal(
            new SearchError("tavily unreachable: This operation was aborted"),
        );
        const second = fakeWithSignal();
        const tool = createWebSearchTool({
            providers: [first.provider, second.provider],
            quota: new FixedWindowQuota(10),
        });
        await expect(
            tool.invoke(
                { query: "q" },
                { configurable: { userId: 7 }, signal: controller.signal },
            ),
        ).rejects.toThrow();
        expect(second.signals).toHaveLength(0);
    });
});
