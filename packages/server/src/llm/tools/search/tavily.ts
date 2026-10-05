/**
 * The Tavily search provider (#9).
 *
 * Tavily is the preferred provider: it is built for LLM consumption (a
 * synthesized `answer` plus clean result excerpts) and it is the metered-but-
 * free-quota API, so the tool routes every vertical Tavily supports here
 * before spending pay-as-you-go Serper calls. Hand-rolled `fetch` rather
 * than the community package — one endpoint, full control over timeout and
 * error shapes, zero new dependencies.
 */
import {
    SearchError,
    type SearchAnswer,
    type SearchProvider,
    type SearchVertical,
    type SearchResult,
} from "./types";

/** Tavily's search endpoint. */
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/** Options for {@link createTavilyClient}. */
export interface TavilyOptions {
    /** The `TAVILY_API_KEY` secret; never logged, never in error text. */
    readonly apiKey: string;
    /** Results per call (`JARVIS_SEARCH_MAX_RESULTS`). */
    readonly maxResults: number;
    /** Wall-clock cap applied when the caller supplies no signal. */
    readonly timeoutMs: number;
    /** Injectable for tests (defaults to global `fetch`). */
    readonly fetchImpl?: typeof fetch;
}

/**
 * Defensive field coercion for untrusted provider JSON: a string or nothing.
 */
function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/**
 * Builds the Tavily provider.
 *
 * Serves only its verticals (`general` / `news` / `finance`) — the tool owns
 * routing and never asks Tavily for anything else.
 */
export function createTavilyClient(opts: TavilyOptions): SearchProvider {
    const doFetch = opts.fetchImpl ?? ((...args) => fetch(...args));

    return {
        name: "tavily",
        async search(
            query: string,
            vertical: SearchVertical,
            signal?: AbortSignal,
        ): Promise<SearchAnswer> {
            const effectiveSignal =
                signal ?? AbortSignal.timeout(opts.timeoutMs);
            let response: Response;
            try {
                response = await doFetch(TAVILY_ENDPOINT, {
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
                    signal: effectiveSignal,
                });
            } catch (err) {
                // Abort/timeout or transport failure — never the key.
                throw new SearchError(
                    `tavily unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
                );
            }
            if (!response.ok) {
                throw new SearchError(`tavily returned ${response.status}`);
            }
            let parsed: unknown;
            try {
                parsed = await response.json();
            } catch {
                throw new SearchError("tavily returned invalid JSON");
            }
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
