/**
 * The Serper search provider (#9) — pay-as-you-go Google SERP.
 *
 * Serper's value is breadth: per-vertical endpoints (`/images`, `/video`,
 * `/patents`, …) covering everything Tavily does not, so the tool defers
 * here for those verticals and as a fallback when Tavily is unavailable.
 * One endpoint family over the shared `requestJson` transport (#103) —
 * full timeout/error control, zero new dependencies.
 */
import {
    SearchError,
    type SearchAnswer,
    type SearchProvider,
    type SearchVertical,
    type SearchResult,
} from "./types";
import { asString, requestJson } from "../http";

/** Serper's API root; the vertical selects the path. */
const SERPER_ROOT = "https://google.serper.dev";

/** Vertical → Serper endpoint path (`finance` has no endpoint — see below). */
const VERTICAL_PATH: Record<SearchVertical, string> = {
    general: "/search",
    news: "/news",
    // finance is Tavily's topic; if Serper must serve it, organic search is
    // the closest available surface.
    finance: "/search",
    images: "/images",
    videos: "/video",
    places: "/places",
    reviews: "/reviews",
    patents: "/patents",
    shopping: "/shopping",
    scholar: "/scholar",
};

/** Options for {@link createSerperClient}. */
export interface SerperOptions {
    /** The `SERPER_API_KEY` secret; never logged, never in error text. */
    readonly apiKey: string;
    /** Results per call (`JARVIS_SEARCH_MAX_RESULTS`). */
    readonly maxResults: number;
    /** Wall-clock cap per request, combined with any caller signal. */
    readonly timeoutMs: number;
    /** Injectable for tests (defaults to global `fetch`). */
    readonly fetchImpl?: typeof fetch;
}

/**
 * Normalizes Serper's response: each vertical returns a differently-keyed
 * array of loosely-shaped items (`organic`, `images`, `videos`, `places`,
 * `reviews`, `patents`, `shopping`, `scholar`), so the mapper picks the
 * first known array and coerces defensively — items become
 * `{ title, url, snippet }` with whatever fields exist.
 */
function normalizeAnswer(parsed: unknown): SearchAnswer {
    const body = parsed as Record<string, unknown>;
    const arrayKeys = [
        "organic",
        "images",
        "videos",
        "places",
        "reviews",
        "patents",
        "shopping",
        "scholar",
    ] as const;
    let rawItems: unknown[] | undefined;
    for (const key of arrayKeys) {
        if (Array.isArray(body[key])) {
            rawItems = body[key] as unknown[];
            break;
        }
    }
    if (rawItems === undefined) {
        throw new SearchError("serper response has no result array");
    }
    const results: SearchResult[] = rawItems
        .slice(0, 50)
        .map((raw) => {
            const item = raw as Record<string, unknown>;
            return {
                title: asString(item.title),
                // Images carry the picture under `imageUrl`; everything else
                // links to the page itself.
                url: asString(item.link) || asString(item.imageUrl),
                snippet: asString(item.snippet) || asString(item.address),
            };
        })
        .filter((r) => r.title !== "" || r.url !== "");
    // Serper's `answerBox` sometimes carries a direct answer worth surfacing.
    const answerBox = body.answerBox as { answer?: unknown } | undefined;
    const summary = asString(answerBox?.answer) || undefined;
    return { provider: "serper", summary, results };
}

/**
 * Builds the Serper provider.
 *
 * Serves every vertical (routing to the vertical's endpoint path) — the
 * tool decides when to spend Serper calls and when to prefer Tavily.
 * Transport is the shared `requestJson` (#103): the caller's signal and
 * `timeoutMs` are combined, so a cancelled turn aborts the fetch while a
 * quiet caller stays bounded.
 */
export function createSerperClient(opts: SerperOptions): SearchProvider {
    return {
        name: "serper",
        async search(
            query: string,
            vertical: SearchVertical,
            signal?: AbortSignal,
        ): Promise<SearchAnswer> {
            // Transport failures throw typed `SearchError`s already mapped by
            // the shared helper (never the key).
            const parsed = await requestJson({
                url: `${SERPER_ROOT}${VERTICAL_PATH[vertical]}`,
                label: "serper",
                method: "POST",
                headers: {
                    "X-API-KEY": opts.apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    q: query,
                    num: opts.maxResults,
                }),
                timeoutMs: opts.timeoutMs,
                signal,
                fetchImpl: opts.fetchImpl,
                mapFailure: (f) => new SearchError(f.message, f.cause),
            });
            const answer = normalizeAnswer(parsed);
            answer.results = answer.results.slice(0, opts.maxResults);
            return answer;
        },
    };
}
