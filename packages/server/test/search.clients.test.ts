import { describe, expect, it, vi } from "vitest";
import { createTavilyClient } from "../src/llm/tools/search/tavily";
import { createSerperClient } from "../src/llm/tools/search/serper";
import { SearchError } from "../src/llm/tools/search/types";

/** Builds a `Response` from JSON text with a status. */
function jsonResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const TAVILY_BODY = JSON.stringify({
    answer: "Cyan is a greenish-blue color.",
    results: [
        {
            title: "Cyan - Wikipedia",
            url: "https://en.wikipedia.org/wiki/Cyan",
            content: "Cyan is the color between blue and green…",
        },
        { title: "No url result", url: "", content: "filtered out" },
    ],
});

const opts = {
    apiKey: "tvly-secret",
    maxResults: 5,
    timeoutMs: 1_000,
};

describe("tavily client", () => {
    it("sends the query, topic, and bearer auth; normalizes results", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(TAVILY_BODY));
        const provider = createTavilyClient({ ...opts, fetchImpl });
        const answer = await provider.search("what is cyan", "general");
        expect(answer).toEqual({
            provider: "tavily",
            summary: "Cyan is a greenish-blue color.",
            results: [
                {
                    title: "Cyan - Wikipedia",
                    url: "https://en.wikipedia.org/wiki/Cyan",
                    snippet: "Cyan is the color between blue and green…",
                },
            ],
        });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://api.tavily.com/search");
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).Authorization).toBe(
            "Bearer tvly-secret",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
            query: "what is cyan",
            topic: "general",
            max_results: 5,
            include_answer: true,
        });
    });

    it("passes the vertical through as the tavily topic", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(TAVILY_BODY));
        const provider = createTavilyClient({ ...opts, fetchImpl });
        await provider.search("fed rate", "news");
        expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).topic).toBe(
            "news",
        );
    });

    it("maps a non-OK status to a typed error without the API key", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse("nope", 401));
        const provider = createTavilyClient({ ...opts, fetchImpl });
        const err = await provider.search("q", "general").catch((e) => e);
        expect(err).toBeInstanceOf(SearchError);
        expect(err.message).toBe("tavily returned 401");
        expect(err.message).not.toContain("tvly-secret");
    });

    it("maps malformed JSON to a typed error", async () => {
        const fetchImpl = vi.fn(
            async () => new Response("<html>oops</html>", { status: 200 }),
        );
        const provider = createTavilyClient({ ...opts, fetchImpl });
        await expect(provider.search("q", "general")).rejects.toMatchObject({
            name: "SearchError",
        });
    });

    it("maps a missing results array to a typed error", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse('{"foo":1}'));
        const provider = createTavilyClient({ ...opts, fetchImpl });
        await expect(provider.search("q", "general")).rejects.toMatchObject({
            message: "tavily response missing results array",
        });
    });
});

const SERPER_BODY = JSON.stringify({
    searchParameters: { q: "cyan", num: 5 },
    organic: [
        {
            title: "Cyan - Wikipedia",
            link: "https://en.wikipedia.org/wiki/Cyan",
            snippet: "Cyan is the color between blue and green…",
        },
        { title: "", link: "", snippet: "filtered out" },
    ],
    answerBox: { answer: "a greenish-blue" },
});

const serperOpts = {
    apiKey: "serper-secret",
    maxResults: 5,
    timeoutMs: 1_000,
};

describe("serper client", () => {
    it("sends the query with the X-API-KEY header; normalizes organic + answerBox", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(SERPER_BODY));
        const provider = createSerperClient({ ...serperOpts, fetchImpl });
        const answer = await provider.search("what is cyan", "general");
        expect(answer).toEqual({
            provider: "serper",
            summary: "a greenish-blue",
            results: [
                {
                    title: "Cyan - Wikipedia",
                    url: "https://en.wikipedia.org/wiki/Cyan",
                    snippet: "Cyan is the color between blue and green…",
                },
            ],
        });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://google.serper.dev/search");
        expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe(
            "serper-secret",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
            q: "what is cyan",
            num: 5,
        });
    });

    it("routes verticals to their endpoint paths", async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse(
                JSON.stringify({
                    images: [
                        {
                            title: "cyan swatch",
                            imageUrl: "https://img.example/cyan.png",
                        },
                    ],
                }),
            ),
        );
        const provider = createSerperClient({ ...serperOpts, fetchImpl });
        const answer = await provider.search("cyan", "images");
        expect(fetchImpl.mock.calls[0][0]).toBe(
            "https://google.serper.dev/images",
        );
        // Images carry the picture under imageUrl; no snippet field.
        expect(answer.results[0]).toEqual({
            title: "cyan swatch",
            url: "https://img.example/cyan.png",
            snippet: "",
        });
    });

    it("uses /video for the videos vertical (serper's path name)", async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse(
                JSON.stringify({ videos: [{ title: "v", link: "l" }] }),
            ),
        );
        const provider = createSerperClient({ ...serperOpts, fetchImpl });
        await provider.search("cyan", "videos");
        expect(fetchImpl.mock.calls[0][0]).toBe(
            "https://google.serper.dev/video",
        );
    });

    it("maps a non-OK status to a typed error without the API key", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse("denied", 403));
        const provider = createSerperClient({ ...serperOpts, fetchImpl });
        const err = await provider.search("q", "general").catch((e) => e);
        expect(err.message).toBe("serper returned 403");
        expect(err.message).not.toContain("serper-secret");
    });

    it("maps a response with no known result array to a typed error", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse('{"unexpected":[]}'));
        const provider = createSerperClient({ ...serperOpts, fetchImpl });
        await expect(provider.search("q", "general")).rejects.toMatchObject({
            message: "serper response has no result array",
        });
    });
});
