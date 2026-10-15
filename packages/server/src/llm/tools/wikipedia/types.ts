/**
 * Shared contracts for the Wikipedia lookup client (#8).
 *
 * Normalization happens at the client boundary, mirroring the search and
 * weather providers: the MediaWiki Action API's JSON is mapped onto ONE
 * shape the `wikipedia` tool can format for the model, so the tool never
 * sees an endpoint, a parameter name, or a raw vendor field. Everything
 * returned from the API is untrusted external data — shapes are checked
 * defensively, and a malformed response is a typed error, not a crash.
 */

/** How much of an article one lookup asks for. */
export type WikipediaDetail = "summary" | "full";

/** An article's stable identity: its title and canonical URL. */
export interface WikipediaArticleRef {
    /** The article title as the wiki spells it ("Ada Lovelace"). */
    title: string;
    /** The canonical article URL (`https://<lang>.wikipedia.org/wiki/…`). */
    url: string;
}

/** A single resolved article, with the extract the model should read. */
export interface WikipediaArticle extends WikipediaArticleRef {
    kind: "article";
    /** The article's plain-text extract, already bounded. */
    extract: string;
    /** True only for `detail: "full"` cut to the configured budget. */
    truncated: boolean;
    /** Characters omitted by that cut (0 when nothing was dropped). */
    omittedChars: number;
}

/**
 * The lookup landed on an ambiguous page, or on a hit with no usable extract
 * — the model is handed choices instead of a body to answer from.
 */
export interface WikipediaCandidates {
    kind: "candidates";
    /** The page reached, when the API named one (a disambiguation page). */
    page?: WikipediaArticleRef;
    /** Articles to choose among; may be empty (then it reads as no match). */
    candidates: WikipediaArticleRef[];
}

/** Nothing on the wiki matched the query. */
export interface WikipediaNoMatch {
    kind: "no-match";
}

/** What one lookup produced. */
export type WikipediaLookup =
    WikipediaArticle | WikipediaCandidates | WikipediaNoMatch;

/** The configured Wikipedia client the tool calls. */
export interface WikipediaProvider {
    /** Human-readable provider name for logs and telemetry. */
    readonly name: "wikipedia";
    /**
     * Resolves one query to an article, a set of candidates, or no match.
     * Throws {@link WikipediaError} on transport or shape failure.
     */
    lookup(
        query: string,
        detail: WikipediaDetail,
        signal?: AbortSignal,
    ): Promise<WikipediaLookup>;
}

/** Why a lookup failed; drives the tool's model-facing error text. */
export class WikipediaError extends Error {
    /**
     * The underlying error (transport/parse), chained by the shared client.
     *
     * Hand-assigned rather than `super(message, { cause })`: the ES2020 lib's
     * `Error` interface predates `ErrorOptions`, so the options bag does not
     * typecheck under this tsconfig.
     */
    readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "WikipediaError";
        this.cause = cause;
    }
}
