/**
 * The Tavily search provider (#9).
 *
 * Tavily is the preferred provider: it is built for LLM consumption (a
 * synthesized `answer` plus clean result excerpts) and it is the metered-but-
 * free-quota API, so the tool routes every vertical Tavily supports here
 * before spending pay-as-you-go Serper calls. One endpoint over the shared
 * `requestJson` transport (#103) — full control over timeout and error
 * shapes, zero new dependencies.
 */
import {
    SearchError,
    type SearchAnswer,
    type SearchProvider,
    type SearchVertical,
    type SearchResult,
} from "./types";
import { asString, requestJson } from "../http";

/** Tavily's search endpoint. */
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/** Options for {@link createTavilyClient}. */
export interface TavilyOptions {
    /** The `TAVILY_API_KEY` secret; never logged, never in error text. */
    readonly apiKey: string;
    /** Results per call (`JARVIS_SEARCH_MAX_RESULTS`). */
    readonly maxResults: number;
    /** Wall-clock cap per request, combined with any caller signal. */
    readonly timeoutMs: number;
    /** Injectable for tests (defaults to global `fetch`). */
    readonly fetchImpl?: typeof fetch;
}

/**
 * Builds the Tavily provider.
 *
 * Serves only its verticals (`general` / `news` / `finance`) — the tool owns
 * routing and never asks Tavily for anything else. Transport is the shared
 * `requestJson` (#103): the caller's signal and `timeoutMs` are combined, so
 * a cancelled turn aborts the fetch while a quiet caller stays bounded.
 */
export function createTavilyClient(opts: TavilyOptions): SearchProvider {
    return {
        name: "tavily",
        async search(
            query: string,
            vertical: SearchVertical,
            signal?: AbortSignal,
        ): Promise<SearchAnswer> {
            // Transport failures throw typed `SearchError`s already mapped by
            // the shared helper (never the key).
            const parsed = await requestJson({
                url: TAVILY_ENDPOINT,
                label: "tavily",
                method: "POST",
                headers: {
                    Authorization: `Bearer ${opts.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query,
                    topic: vertical,
                    max_results: opts.maxResults,
                    include_answer: true,
                }),
                timeoutMs: opts.timeoutMs,
                signal,
                fetchImpl: opts.fetchImpl,
                mapFailure: (f) => new SearchError(f.message, f.cause),
            });
            const body = parsed as {
                answer?: unknown;
                results?: unknown;
            };
            if (!Array.isArray(body.results)) {
                throw new SearchError("tavily response missing results array");
            }
            const results: SearchResult[] = body.results
                .slice(0, opts.maxResults)
                .map((raw) => {
                    const item = raw as {
                        title?: unknown;
                        url?: unknown;
                        content?: unknown;
                    };
                    return {
                        title: asString(item.title),
                        url: asString(item.url),
                        snippet: asString(item.content),
                    };
                })
                .filter((r) => r.url !== "");
            return {
                provider: "tavily",
                summary: asString(body.answer) || undefined,
                results,
            };
        },
    };
}
