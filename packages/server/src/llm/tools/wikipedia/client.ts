/**
 * The Wikipedia lookup client (#8).
 *
 * One MediaWiki Action API endpoint (`https://<lang>.wikipedia.org/w/api.php`)
 * over the shared `requestJson` transport (#103), so this client inherits the
 * timeout/signal composition every other metered provider uses: a cancelled
 * turn aborts the fetch, and a quiet caller is still bounded.
 *
 * The whole lookup is deliberately ONE HTTP request. A `generator=search`
 * query resolves the best title *and* fetches its extract in the same
 * response, so the common path is a single round trip; a second request
 * (a `list=search`) happens only when the top hit turns out to be unusable
 * (a disambiguation page, or a hit with no extract) and the model needs
 * candidates to choose from instead.
 *
 * Depth is bounded on purpose. The Action API's own limits are much
 * tighter than they look — `exsentences` caps at 10 (~950 characters) and
 * `exchars` at ~1200 — so "the full article" means fetching the *unbounded*
 * plain text (40–60 KB for a popular subject) and cutting it here to
 * `maxFullChars`. Per-section retrieval would mean `action=parse` and
 * stripping 50 KB+ of HTML per section, so it is not attempted.
 *
 * A descriptive `User-Agent` is required by Wikimedia's policy, not
 * optional: the API answers 403 to an empty one, and reserves the right to
 * block generic agents.
 */
import {
    WikipediaError,
    type WikipediaArticleRef,
    type WikipediaDetail,
    type WikipediaLookup,
    type WikipediaProvider,
} from "./types";
import { asString, requestJson } from "../http";

/**
 * Defensive ceiling on a summary extract.
 *
 * The API already bounds a summary via `exsentences` (hard max 10, ~950
 * characters), so this never bites in practice — it is a backstop against a
 * pathological response, and it is not surfaced as truncation the way the
 * `full` budget is.
 */
const SUMMARY_CEILING_CHARS = 4000;

/** The API's hard cap on `exsentences` (values above are rejected/clamped). */
const MAX_EXSENTENCES = 10;

/** Options for {@link createWikipediaClient}. */
export interface WikipediaClientOptions {
    /** Wiki language subdomain (`JARVIS_WIKIPEDIA_LANG`), e.g. `en`. */
    readonly lang: string;
    /** Wall-clock cap per request, combined with any caller signal. */
    readonly timeoutMs: number;
    /** Descriptive `User-Agent` (`JARVIS_WIKIPEDIA_USER_AGENT`). */
    readonly userAgent: string;
    /** Leading sentences a summary extract asks for (`JARVIS_WIKIPEDIA_MAX_SENTENCES`). */
    readonly maxSentences: number;
    /** Character budget for `detail: "full"` (`JARVIS_WIKIPEDIA_MAX_FULL_CHARS`). */
    readonly maxFullChars: number;
    /** Candidate titles returned for an ambiguous query (`JARVIS_WIKIPEDIA_MAX_CANDIDATES`). */
    readonly maxCandidates: number;
    /** Injectable for tests (defaults to global `fetch`). */
    readonly fetchImpl?: typeof fetch;
}

/**
 * Builds the Wikipedia provider over the shared transport.
 *
 * Transport failures arrive as typed {@link WikipediaError}s already mapped
 * by `requestJson`; a well-formed response that simply has no usable article
 * is a *value* (`no-match` / `candidates`), never an error — the tool turns
 * each into model-facing text.
 */
export function createWikipediaClient(
    opts: WikipediaClientOptions,
): WikipediaProvider {
    const origin = `https://${opts.lang}.wikipedia.org`;
    const endpoint = `${origin}/w/api.php`;
    const articleUrl = (title: string): string =>
        `${origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    const sentences = Math.min(
        MAX_EXSENTENCES,
        Math.max(1, Math.floor(opts.maxSentences)),
    );

    /** Runs one Action API query and resolves the parsed body. */
    async function call(
        params: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<unknown> {
        const query = new URLSearchParams({
            action: "query",
            format: "json",
            formatversion: "2",
            ...params,
        });
        return requestJson({
            url: `${endpoint}?${query.toString()}`,
            label: "wikipedia",
            headers: {
                "User-Agent": opts.userAgent,
                Accept: "application/json",
            },
            timeoutMs: opts.timeoutMs,
            signal,
            fetchImpl: opts.fetchImpl,
            mapFailure: (failure) =>
                new WikipediaError(failure.message, failure.cause),
        });
    }

    /**
     * The candidate list for a query the top hit could not answer.
     *
     * The rejected page itself is excluded: a query that lands on a
     * disambiguation page usually ranks that same page first in this search,
     * and it is by definition not an answer. One extra result is requested so
     * removing the page still fills up to `maxCandidates`.
     */
    async function candidates(
        query: string,
        excludeTitle: string,
        signal?: AbortSignal,
    ): Promise<WikipediaArticleRef[]> {
        const body = (await call(
            {
                list: "search",
                srsearch: query,
                srlimit: String(opts.maxCandidates + 1),
                srnamespace: "0",
            },
            signal,
        )) as { query?: { search?: unknown } };
        const rows = body.query?.search;
        if (!Array.isArray(rows)) {
            return [];
        }
        return rows
            .map((raw) => asString((raw as { title?: unknown })?.title))
            .filter((title) => title !== "" && title !== excludeTitle)
            .slice(0, opts.maxCandidates)
            .map((title) => ({ title, url: articleUrl(title) }));
    }

    return {
        name: "wikipedia",
        async lookup(
            query: string,
            detail: WikipediaDetail,
            signal?: AbortSignal,
        ): Promise<WikipediaLookup> {
            // One request serves title + extract. `exlimit=1` matches the
            // single generator slot; `redirects` resolves e.g. "USA" →
            // "United States"; `inprop=url` yields the canonical fullurl.
            const body = (await call(
                {
                    generator: "search",
                    gsrsearch: query,
                    gsrlimit: "1",
                    gsrnamespace: "0",
                    prop: "extracts|info|pageprops",
                    explaintext: "1",
                    exlimit: "1",
                    inprop: "url",
                    redirects: "1",
                    ...(detail === "summary"
                        ? { exintro: "1", exsentences: String(sentences) }
                        : {}),
                },
                signal,
            )) as { query?: { pages?: unknown } };

            const page = firstPage(body.query?.pages);
            if (!page) {
                // No results at all: the API answers `{"batchcomplete":true}`
                // with no `query` key, so this is the ordinary empty path.
                return { kind: "no-match" };
            }
            const title = asString(page.title);
            const url =
                asString(page.fullurl) || (title ? articleUrl(title) : "");
            const extract = asString(page.extract).trim();
            if (isDisambiguation(page.pageprops) || extract === "") {
                return {
                    kind: "candidates",
                    ...(title ? { page: { title, url } } : {}),
                    candidates: await candidates(query, title, signal),
                };
            }
            if (detail === "full") {
                const truncated = extract.length > opts.maxFullChars;
                return {
                    kind: "article",
                    title,
                    url,
                    extract: truncated
                        ? extract.slice(0, opts.maxFullChars)
                        : extract,
                    truncated,
                    omittedChars: truncated
                        ? extract.length - opts.maxFullChars
                        : 0,
                };
            }
            return {
                kind: "article",
                title,
                url,
                extract: extract.slice(0, SUMMARY_CEILING_CHARS),
                truncated: false,
                omittedChars: 0,
            };
        },
    };
}

/**
 * Picks the first page out of a `prop` response.
 *
 * `formatversion=2` returns `pages` as an array, which is what this client
 * asks for; the object-keyed shape of `formatversion=1` is still handled, so
 * a response that ignores the version parameter degrades to a lookup rather
 * than a crash.
 */
function firstPage(pages: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(pages)) {
        return pages.length > 0
            ? (pages[0] as Record<string, unknown>)
            : undefined;
    }
    if (pages && typeof pages === "object") {
        const values = Object.values(pages as Record<string, unknown>);
        return values.length > 0
            ? (values[0] as Record<string, unknown>)
            : undefined;
    }
    return undefined;
}

/**
 * True when `pageprops` marks the page as a disambiguation page.
 *
 * The flag is presence-only — the API sends `"disambiguation": ""` — so the
 * key's existence is the signal, not its value.
 */
function isDisambiguation(pageprops: unknown): boolean {
    return (
        !!pageprops &&
        typeof pageprops === "object" &&
        Object.prototype.hasOwnProperty.call(pageprops, "disambiguation")
    );
}
