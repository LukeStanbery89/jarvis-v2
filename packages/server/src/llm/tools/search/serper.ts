/**
 * The Serper search provider (#9) — pay-as-you-go Google SERP.
 *
 * Serper's value is breadth: per-vertical endpoints (`/images`, `/video`,
 * `/patents`, …) covering everything Tavily does not, so the tool defers
 * here for those verticals and as a fallback when Tavily is unavailable.
 * Hand-rolled `fetch` — one endpoint family, full timeout/error control,
 * zero new dependencies.
 */
import {
    SearchError,
    type SearchAnswer,
    type SearchProvider,
    type SearchVertical,
    type SearchResult,
} from "./types";

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
    /** Wall-clock cap applied when the caller supplies no signal. */
    readonly timeoutMs: number;
    /** Injectable for tests (defaults to global `fetch`). */
    readonly fetchImpl?: typeof fetch;
}

/** Defensive field coercion for untrusted provider JSON: a string or nothing. */
function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
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
 */
export function createSerperClient(opts: SerperOptions): SearchProvider {
    const doFetch = opts.fetchImpl ?? ((...args) => fetch(...args));

    return {
        name: "serper",
        async search(
            query: string,
            vertical: SearchVertical,
            signal?: AbortSignal,
        ): Promise<SearchAnswer> {
            const effectiveSignal =
                signal ?? AbortSignal.timeout(opts.timeoutMs);
            let response: Response;
            try {
                response = await doFetch(
                    `${SERPER_ROOT}${VERTICAL_PATH[vertical]}`,
                    {
                        method: "POST",
                        headers: {
                            "X-API-KEY": opts.apiKey,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                            q: query,
                            num: opts.maxResults,
                        }),
                        signal: effectiveSignal,
                    },
                );
            } catch (err) {
                // Abort/timeout or transport failure — never the key.
                throw new SearchError(
                    `serper unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
                );
            }
            if (!response.ok) {
                throw new SearchError(`serper returned ${response.status}`);
            }
            let parsed: unknown;
            try {
                parsed = await response.json();
            } catch {
                throw new SearchError("serper returned invalid JSON");
            }
            const answer = normalizeAnswer(parsed);
            answer.results = answer.results.slice(0, opts.maxResults);
            return answer;
        },
    };
}
