/**
 * Shared contracts for the web-search providers (#9).
 *
 * Normalization happens at the provider boundary: each client maps its
 * vendor's response onto ONE shape the tool can format for the model, so
 * swapping or adding providers never touches the tool logic. Everything
 * returned from a provider is untrusted external data — shapes are checked
 * defensively, and a malformed response is a typed error, not a crash.
 */

/**
 * The search verticals the `webSearch` tool exposes.
 *
 * Tavily serves `general` / `news` / `finance` (its `topic` parameter);
 * Serper serves everything else out of its per-vertical endpoints. News
 * exists on both — Tavily wins there (free quota over pay-as-you-go).
 */
export type SearchVertical =
    | "general"
    | "news"
    | "finance"
    | "images"
    | "videos"
    | "places"
    | "reviews"
    | "patents"
    | "shopping"
    | "scholar";

/** The verticals Tavily can serve (its `topic` values, verbatim). */
export const TAVILY_VERTICALS: ReadonlySet<SearchVertical> = new Set([
    "general",
    "news",
    "finance",
]);

/** One normalized result: the model sees titles, URLs, and snippets. */
export interface SearchResult {
    title: string;
    url: string;
    /** Tavily's content excerpt or Serper's snippet — the useful text. */
    snippet: string;
}

/** A provider's normalized answer for one search. */
export interface SearchAnswer {
    /** Which provider produced this answer (surfaced in tool telemetry). */
    provider: "tavily" | "serper";
    /**
     * A synthesized summary when the provider offers one (Tavily's `answer`,
     * Serper's `answerBox`); optional — results alone are always enough.
     */
    summary?: string;
    results: SearchResult[];
}

/** A configured search provider the tool can call. */
export interface SearchProvider {
    /** Human-readable provider name for logs and fallback telemetry. */
    readonly name: "tavily" | "serper";
    /**
     * Runs one search. Throws `SearchError` on transport or shape failure —
     * never leaks the API key into a message.
     */
    search(
        query: string,
        vertical: SearchVertical,
        signal?: AbortSignal,
    ): Promise<SearchAnswer>;
}

/** Why a search failed; drives the tool's user-facing error text. */
export class SearchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SearchError";
    }
}
