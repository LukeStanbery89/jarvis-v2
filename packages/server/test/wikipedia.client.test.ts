/**
 * Tests for the Wikipedia lookup client (#8): request shapes (one
 * `generator=search` call for the common path), the summary vs full depth
 * split, the character budget + truncation report, the disambiguation /
 * empty-extract fallback to candidates, the no-results path, defensive
 * parsing of untrusted shapes, the required `User-Agent`, and typed failure
 * modes. The API is mocked, never live.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWikipediaClient } from "../src/llm/tools/wikipedia/client";
import { WikipediaError } from "../src/llm/tools/wikipedia/types";

/** Builds a mock fetch answering a SEQUENCE of JSON responses in order. */
function mockFetch(
    responses: (
        | { status?: number; body: unknown }
        | { failWith: unknown }
        | { raw: string }
    )[],
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const queue = [...responses];
    const impl = async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        calls.push({ url: String(input), init: (init ?? {}) as RequestInit });
        const respond = queue.shift();
        if (!respond) {
            throw new Error("unexpected extra request in test");
        }
        if ("failWith" in respond) {
            throw respond.failWith;
        }
        if ("raw" in respond) {
            return new Response(respond.raw, {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response(JSON.stringify(respond.body), {
            status: respond.status ?? 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    return { fetch: impl as unknown as typeof fetch, calls };
}

/** Extracts a call's query parameters for readable assertions. */
function params(url: string): URLSearchParams {
    return new URL(url).searchParams;
}

const OPTS = {
    lang: "en",
    timeoutMs: 5_000,
    userAgent: "jarvis-v2-test/0.1 (+https://example.test)",
    maxSentences: 5,
    maxFullChars: 6_000,
    maxCandidates: 5,
};

const ARTICLE_BODY = {
    batchcomplete: true,
    query: {
        pages: [
            {
                pageid: 123,
                ns: 0,
                index: 1,
                title: "Ada Lovelace",
                fullurl: "https://en.wikipedia.org/wiki/Ada_Lovelace",
                extract:
                    "Augusta Ada King, Countess of Lovelace, was an English mathematician and writer.",
            },
        ],
    },
};

const DISAMBIG_BODY = {
    query: {
        pages: [
            {
                pageid: 4,
                ns: 0,
                index: 1,
                title: "Mercury",
                fullurl: "https://en.wikipedia.org/wiki/Mercury",
                pageprops: { disambiguation: "" },
                extract: "Mercury most commonly refers to:",
            },
        ],
    },
};

const CANDIDATES_BODY = {
    query: {
        search: [
            { title: "Mercury (planet)", pageid: 1 },
            { title: "Mercury (element)", pageid: 2 },
        ],
    },
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("createWikipediaClient", () => {
    it("resolves an article from a single generator=search request", async () => {
        const { fetch, calls } = mockFetch([{ body: ARTICLE_BODY }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });

        const result = await client.lookup("Ada Lovelace", "summary");

        expect(calls).toHaveLength(1);
        const url = calls[0]!.url;
        expect(url.startsWith("https://en.wikipedia.org/w/api.php?")).toBe(
            true,
        );
        const query = params(url);
        expect(query.get("action")).toBe("query");
        expect(query.get("formatversion")).toBe("2");
        expect(query.get("generator")).toBe("search");
        expect(query.get("gsrsearch")).toBe("Ada Lovelace");
        expect(query.get("gsrlimit")).toBe("1");
        expect(query.get("prop")).toBe("extracts|info|pageprops");
        expect(query.get("redirects")).toBe("1");
        // A summary is the bounded lead: exintro + exsentences.
        expect(query.get("exintro")).toBe("1");
        expect(query.get("exsentences")).toBe("5");

        expect(result).toEqual({
            kind: "article",
            title: "Ada Lovelace",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
            extract:
                "Augusta Ada King, Countess of Lovelace, was an English mathematician and writer.",
            truncated: false,
            omittedChars: 0,
        });
    });

    it("sends the configured User-Agent (Wikimedia policy) and Accept", async () => {
        const { fetch, calls } = mockFetch([{ body: ARTICLE_BODY }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        await client.lookup("Ada Lovelace", "summary");
        expect(calls[0]!.init.headers).toEqual({
            "User-Agent": OPTS.userAgent,
            Accept: "application/json",
        });
    });

    it("uses the configured language subdomain", async () => {
        const { fetch, calls } = mockFetch([{ body: ARTICLE_BODY }]);
        const client = createWikipediaClient({
            ...OPTS,
            lang: "de",
            fetchImpl: fetch,
        });
        await client.lookup("Ada Lovelace", "summary");
        expect(calls[0]!.url.startsWith("https://de.wikipedia.org/")).toBe(
            true,
        );
    });

    it("asks for the unbounded extract (no exintro) for detail: full", async () => {
        const { fetch, calls } = mockFetch([{ body: ARTICLE_BODY }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });

        await client.lookup("Ada Lovelace", "full");

        const query = params(calls[0]!.url);
        expect(query.get("exintro")).toBeNull();
        expect(query.get("exsentences")).toBeNull();
    });

    it("cuts a full extract to maxFullChars and reports the omission", async () => {
        const extract = "x".repeat(10_000);
        const { fetch } = mockFetch([
            {
                body: {
                    query: {
                        pages: [
                            {
                                title: "Big",
                                fullurl: "https://en.wikipedia.org/wiki/Big",
                                extract,
                            },
                        ],
                    },
                },
            },
        ]);
        const client = createWikipediaClient({
            ...OPTS,
            maxFullChars: 6_000,
            fetchImpl: fetch,
        });

        const result = await client.lookup("Big", "full");
        expect(result).toEqual({
            kind: "article",
            title: "Big",
            url: "https://en.wikipedia.org/wiki/Big",
            extract: "x".repeat(6_000),
            truncated: true,
            omittedChars: 4_000,
        });
    });

    it("clamps exsentences to the API's maximum of 10", async () => {
        const { fetch, calls } = mockFetch([{ body: ARTICLE_BODY }]);
        const client = createWikipediaClient({
            ...OPTS,
            maxSentences: 50,
            fetchImpl: fetch,
        });
        await client.lookup("Ada Lovelace", "summary");
        expect(params(calls[0]!.url).get("exsentences")).toBe("10");
    });

    it("falls back to candidates when the top hit is a disambiguation page", async () => {
        const { fetch, calls } = mockFetch([
            { body: DISAMBIG_BODY },
            { body: CANDIDATES_BODY },
        ]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });

        const result = await client.lookup("mercury", "summary");

        expect(result).toEqual({
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
        });
        // Second request is a plain candidate search, not an extract fetch.
        expect(calls).toHaveLength(2);
        const query = params(calls[1]!.url);
        expect(query.get("list")).toBe("search");
        expect(query.get("srsearch")).toBe("mercury");
        // One extra is requested so removing the rejected page still fills the
        // list (see the exclusion test below).
        expect(query.get("srlimit")).toBe("6");
    });

    it("drops the rejected page itself from the candidate list", async () => {
        // The fallback search usually ranks the disambiguation page first,
        // which is not a usable answer — the client must not offer it back.
        const { fetch } = mockFetch([
            { body: DISAMBIG_BODY },
            {
                body: {
                    query: {
                        search: [
                            { title: "Mercury", pageid: 4 },
                            { title: "Mercury (planet)", pageid: 1 },
                        ],
                    },
                },
            },
        ]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.lookup("mercury", "summary");
        expect(result).toMatchObject({
            kind: "candidates",
            candidates: [
                {
                    title: "Mercury (planet)",
                    url: "https://en.wikipedia.org/wiki/Mercury_(planet)",
                },
            ],
        });
    });

    it("falls back to candidates when the hit has no usable extract", async () => {
        const { fetch } = mockFetch([
            {
                body: {
                    query: {
                        pages: [
                            { title: "Empty", fullurl: "u", extract: "   " },
                        ],
                    },
                },
            },
            { body: CANDIDATES_BODY },
        ]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.lookup("empty", "summary");
        expect(result.kind).toBe("candidates");
    });

    it("reports candidates with an empty list when the fallback search is empty", async () => {
        const { fetch } = mockFetch([
            { body: DISAMBIG_BODY },
            { body: { batchcomplete: true } },
        ]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.lookup("mercury", "summary");
        expect(result).toEqual({
            kind: "candidates",
            page: {
                title: "Mercury",
                url: "https://en.wikipedia.org/wiki/Mercury",
            },
            candidates: [],
        });
    });

    it("returns no-match when the API reports no results (no query key)", async () => {
        const { fetch, calls } = mockFetch([{ body: { batchcomplete: true } }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.lookup("zzzzz", "summary");
        expect(result).toEqual({ kind: "no-match" });
        // No candidates request is made when there was no page at all.
        expect(calls).toHaveLength(1);
    });

    it("tolerates the formatversion=1 object-keyed pages shape", async () => {
        const { fetch } = mockFetch([
            {
                body: {
                    query: {
                        pages: {
                            "123": {
                                title: "Ada Lovelace",
                                extract: "A mathematician.",
                            },
                        },
                    },
                },
            },
        ]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.lookup("Ada Lovelace", "summary");
        expect(result).toMatchObject({
            kind: "article",
            title: "Ada Lovelace",
            extract: "A mathematician.",
        });
    });

    it("derives the article URL from the title when the API omits fullurl", async () => {
        const { fetch } = mockFetch([
            {
                body: {
                    query: {
                        pages: [
                            {
                                title: "Ada Lovelace",
                                extract: "A mathematician.",
                            },
                        ],
                    },
                },
            },
        ]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.lookup("Ada Lovelace", "summary");
        expect(result).toMatchObject({
            kind: "article",
            url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        });
    });

    it("maps a non-2xx response onto a typed WikipediaError", async () => {
        const { fetch } = mockFetch([{ status: 500, body: { error: "boom" } }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.lookup("x", "summary")).rejects.toBeInstanceOf(
            WikipediaError,
        );
    });

    it("maps an unparseable body onto a typed WikipediaError", async () => {
        const { fetch } = mockFetch([{ raw: "<html>not json</html>" }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.lookup("x", "summary")).rejects.toBeInstanceOf(
            WikipediaError,
        );
    });

    it("maps a transport failure onto a typed WikipediaError", async () => {
        const { fetch } = mockFetch([{ failWith: new Error("ECONNREFUSED") }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.lookup("x", "summary")).rejects.toBeInstanceOf(
            WikipediaError,
        );
    });

    it("combines the caller's signal with the timeout (never replaces it)", async () => {
        const controller = new AbortController();
        const { fetch, calls } = mockFetch([{ body: ARTICLE_BODY }]);
        const client = createWikipediaClient({ ...OPTS, fetchImpl: fetch });

        await client.lookup("Ada Lovelace", "summary", controller.signal);
        const sent = calls[0]!.init.signal as AbortSignal;
        expect(sent.aborted).toBe(false);
        controller.abort();
        // The caller's abort reached the request that was sent.
        expect(sent.aborted).toBe(true);
    });

    it("rejects when the caller's signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const impl = (async (_input: string, init?: RequestInit) => {
            if (init?.signal?.aborted) {
                throw new DOMException("aborted", "AbortError");
            }
            return new Response(JSON.stringify(ARTICLE_BODY), { status: 200 });
        }) as unknown as typeof fetch;
        const client = createWikipediaClient({ ...OPTS, fetchImpl: impl });
        await expect(
            client.lookup("Ada Lovelace", "summary", controller.signal),
        ).rejects.toBeInstanceOf(WikipediaError);
    });
});
