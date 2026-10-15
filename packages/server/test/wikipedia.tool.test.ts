/**
 * Tests for the `wikipedia` tool (#8): the caller gate (per-user quota for
 * signed-in callers, the dual per-session + per-address buckets for guests),
 * the model-facing formatter for all three lookup shapes, error text, and
 * `AbortSignal` threading. The provider is scripted, never live.
 */
import { describe, expect, it } from "vitest";
import {
    createWikipediaTool,
    formatWikipediaLookup,
    type WikipediaDeps,
} from "../src/llm/tools/wikipedia";
import { WikipediaError } from "../src/llm/tools/wikipedia/types";
import type {
    WikipediaDetail,
    WikipediaLookup,
    WikipediaProvider,
} from "../src/llm/tools/wikipedia/types";
import { FixedWindowQuota } from "../src/rate/fixedWindowQuota";

/** A scripted provider recording its calls; throws when scripted to fail. */
function fakeProvider(script: WikipediaLookup | Error): {
    provider: WikipediaProvider;
    calls: { query: string; detail: WikipediaDetail }[];
    signals: (AbortSignal | undefined)[];
} {
    const calls: { query: string; detail: WikipediaDetail }[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    return {
        calls,
        signals,
        provider: {
            name: "wikipedia",
            async lookup(query, detail, signal) {
                calls.push({ query, detail });
                signals.push(signal);
                if (script instanceof Error) {
                    throw script;
                }
                return script;
            },
        },
    };
}

const ARTICLE: WikipediaLookup = {
    kind: "article",
    title: "Ada Lovelace",
    url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
    extract: "Ada Lovelace was an English mathematician.",
    truncated: false,
    omittedChars: 0,
};

const TRUNCATED: WikipediaLookup = {
    kind: "article",
    title: "Ada Lovelace",
    url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
    extract: "Ada Lovelace was an English mathematician.",
    truncated: true,
    omittedChars: 4_000,
};

const CANDIDATES: WikipediaLookup = {
    kind: "candidates",
    page: {
        title: "Mercury",
        url: "https://en.wikipedia.org/wiki/Mercury",
    },
    candidates: [
        {
            title: "Mercury (planet)",
            url: "https://en.wikipedia.org/wiki/Mercury_(planet)",
        },
        {
            title: "Mercury (element)",
            url: "https://en.wikipedia.org/wiki/Mercury_(element)",
        },
    ],
};

const OWNER = {
    configurable: { sessionId: "s1", clientIp: "10.0.0.1", userId: 7 },
};
const GUEST = { configurable: { sessionId: "s1", clientIp: "10.0.0.1" } };

/** Runs the tool with scripted deps; `runtime` defaults to the owner. */
async function run(
    deps: Partial<WikipediaDeps> & { script?: WikipediaLookup | Error } = {},
    args: { query?: string; detail?: "summary" | "full" } = {
        query: "Ada Lovelace",
    },
    runtime: {
        configurable?: Record<string, unknown>;
        signal?: AbortSignal;
    } = OWNER,
): Promise<string> {
    const fake = fakeProvider(deps.script ?? ARTICLE);
    const tool = createWikipediaTool({
        provider: deps.provider ?? fake.provider,
        quota: deps.quota ?? new FixedWindowQuota(20),
        guest: deps.guest ?? {
            session: new FixedWindowQuota<string>(3),
            address: new FixedWindowQuota<string>(10),
        },
    });
    return (await tool.invoke(
        {
            query: args.query ?? "Ada Lovelace",
            ...(args.detail === undefined ? {} : { detail: args.detail }),
        },
        runtime,
    )) as string;
}

describe("wikipedia tool routing", () => {
    it("defaults to a summary lookup and returns the title, URL, and extract", async () => {
        const fake = fakeProvider(ARTICLE);
        const result = await run(
            { provider: fake.provider },
            { query: "Ada Lovelace" },
        );
        expect(fake.calls).toEqual([
            { query: "Ada Lovelace", detail: "summary" },
        ]);
        expect(result).toBe(
            "Ada Lovelace — https://en.wikipedia.org/wiki/Ada_Lovelace\n\n" +
                "Ada Lovelace was an English mathematician.",
        );
    });

    it("forwards detail: full", async () => {
        const fake = fakeProvider(ARTICLE);
        await run(
            { provider: fake.provider },
            { query: "Ada Lovelace", detail: "full" },
        );
        expect(fake.calls).toEqual([{ query: "Ada Lovelace", detail: "full" }]);
    });

    it("states the truncation and links the full article when the extract was cut", async () => {
        const result = await formatWikipediaLookup(TRUNCATED, "Ada Lovelace");
        expect(result).toContain("[extract truncated: 4000 of");
        expect(result).toContain(
            "the full article is at https://en.wikipedia.org/wiki/Ada_Lovelace",
        );
    });

    it("threads the caller's AbortSignal into the provider call", async () => {
        const controller = new AbortController();
        const fake = fakeProvider(ARTICLE);
        await run(
            { provider: fake.provider },
            { query: "Ada Lovelace" },
            { configurable: OWNER.configurable, signal: controller.signal },
        );
        expect(fake.signals).toEqual([controller.signal]);
    });
});

describe("wikipedia tool metering", () => {
    it("charges a signed-in caller to the per-user quota", async () => {
        const quota = new FixedWindowQuota(1);
        const first = await run({ quota, script: ARTICLE });
        expect(first).toContain("Ada Lovelace");
        const second = await run({ quota, script: ARTICLE });
        expect(second).toContain("rate limited");
    });

    it("admits a guest when both guest buckets have room", async () => {
        const fake = fakeProvider(ARTICLE);
        const result = await run(
            { provider: fake.provider },
            { query: "Ada Lovelace" },
            GUEST,
        );
        expect(fake.calls).toHaveLength(1);
        expect(result).toContain("Ada Lovelace");
    });

    it("refuses a guest once the strict per-session budget is spent", async () => {
        const fake = fakeProvider(ARTICLE);
        const guest = {
            session: new FixedWindowQuota<string>(1),
            address: new FixedWindowQuota<string>(100),
        };
        const first = await run({ provider: fake.provider, guest }, {}, GUEST);
        expect(first).toContain("Ada Lovelace");
        const second = await run({ provider: fake.provider, guest }, {}, GUEST);
        expect(fake.calls).toHaveLength(1);
        expect(second).toContain("rate limited");
    });

    it("refuses a guest who rotates sessions once the per-address budget is spent", async () => {
        const fake = fakeProvider(ARTICLE);
        const guest = {
            session: new FixedWindowQuota<string>(100),
            address: new FixedWindowQuota<string>(1),
        };
        const first = await run(
            { provider: fake.provider, guest },
            {},
            { configurable: { sessionId: "s1", clientIp: "10.0.0.1" } },
        );
        expect(first).toContain("Ada Lovelace");
        // A fresh session from the same address must still be refused.
        const second = await run(
            { provider: fake.provider, guest },
            {},
            { configurable: { sessionId: "s2", clientIp: "10.0.0.1" } },
        );
        expect(fake.calls).toHaveLength(1);
        expect(second).toContain("rate limited");
    });

    it("keys the address bucket independently per address", async () => {
        const fake = fakeProvider(ARTICLE);
        const address = new FixedWindowQuota<string>(1);
        const guest = { session: new FixedWindowQuota<string>(100), address };
        await run(
            { provider: fake.provider, guest },
            {},
            { configurable: { sessionId: "s1", clientIp: "10.0.0.1" } },
        );
        // A different address is unaffected by the first address's budget.
        const other = await run(
            { provider: fake.provider, guest },
            {},
            { configurable: { sessionId: "s2", clientIp: "10.0.0.2" } },
        );
        expect(other).toContain("Ada Lovelace");
    });

    it("refuses a guest without a session id or address instead of admitting it", async () => {
        const fake = fakeProvider(ARTICLE);
        const result = await run(
            { provider: fake.provider },
            {},
            { configurable: {} },
        );
        expect(fake.calls).toHaveLength(0);
        expect(result).toContain("unavailable");
    });

    it("refuses a guest when the tool was wired without guest budgets", async () => {
        const fake = fakeProvider(ARTICLE);
        const tool = createWikipediaTool({
            provider: fake.provider,
            quota: new FixedWindowQuota(20),
            guest: {
                session: new FixedWindowQuota<string>(3),
                address: new FixedWindowQuota<string>(10),
            },
        });
        // Simulate a graph that stamped no guest keys at all.
        const result = (await tool.invoke(
            { query: "Ada Lovelace" },
            { configurable: { userId: undefined } },
        )) as string;
        expect(result).toContain("unavailable");
        expect(fake.calls).toHaveLength(0);
    });
});

describe("formatWikipediaLookup", () => {
    it("lists candidates with an instruction to disambiguate", () => {
        const text = formatWikipediaLookup(CANDIDATES, "mercury");
        expect(text).toContain('"Mercury" is a disambiguation page');
        expect(text).toContain(
            "- Mercury (planet) — https://en.wikipedia.org/wiki/Mercury_(planet)",
        );
        expect(text).toContain("Ask the user which one they mean");
    });

    it("reports a no-match", () => {
        expect(formatWikipediaLookup({ kind: "no-match" }, "zzz")).toBe(
            'No Wikipedia article matched "zzz".',
        );
    });

    it("reports an empty candidate list as a no-match", () => {
        expect(
            formatWikipediaLookup(
                { kind: "candidates", candidates: [] },
                "zzz",
            ),
        ).toBe('No Wikipedia article matched "zzz".');
    });

    it("omits the truncation note when nothing was cut", () => {
        expect(formatWikipediaLookup(ARTICLE, "Ada Lovelace")).not.toContain(
            "truncated",
        );
    });
});

describe("wikipedia tool failures", () => {
    it("returns model-facing failure text on a provider error", async () => {
        const result = await run({
            script: new WikipediaError("wikipedia returned 500"),
        });
        expect(result).toContain("Wikipedia lookup failed");
    });

    it("rethrows instead of answering when the turn was already cancelled", async () => {
        const controller = new AbortController();
        controller.abort();
        const fake = fakeProvider(new WikipediaError("aborted"));
        const tool = createWikipediaTool({
            provider: fake.provider,
            quota: new FixedWindowQuota(20),
            guest: {
                session: new FixedWindowQuota<string>(3),
                address: new FixedWindowQuota<string>(10),
            },
        });
        await expect(
            tool.invoke(
                { query: "Ada Lovelace" },
                { configurable: OWNER.configurable, signal: controller.signal },
            ),
        ).rejects.toThrow();
    });
});
