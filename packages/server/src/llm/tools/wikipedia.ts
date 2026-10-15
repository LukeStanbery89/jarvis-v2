/**
 * The `wikipedia` tool (#8): the agent's window onto encyclopedic knowledge.
 *
 * One tool, one optional `detail` — a bounded lead summary by default, the
 * article's plain text (cut to a character budget, with the omission stated)
 * on request. The model gets `Title — URL` plus the extract, so it can relay
 * facts and point the user at the source.
 *
 * Depth was chosen from what the API can actually serve: its bounded knobs
 * (`exsentences`, `exchars`) top out around 1.2 KB, so anything deeper means
 * fetching the unbounded article and cutting it here. `detail: "full"` says
 * so in its result rather than pretending to be complete.
 *
 * Unlike every other optional tool, this one **admits guests** — Wikipedia
 * needs no API key and costs nothing, so gating it behind a login buys
 * nothing. Guests pay for that with a much stricter budget: the call is
 * charged to both a per-session bucket and an aggregate per-address bucket
 * (see {@link requireMeteredCaller}), and both are checked before any fetch.
 * Signed-in users get the ordinary per-user quota.
 */
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import {
    WikipediaError,
    type WikipediaArticleRef,
    type WikipediaLookup,
    type WikipediaProvider,
} from "./wikipedia/types";
import { FixedWindowQuota } from "../../rate/fixedWindowQuota";
import { logger } from "../../logger";
import { requireMeteredCaller } from "./metering";

/** Everything the tool needs, injected at wiring time. */
export interface WikipediaDeps {
    /** The configured Wikipedia client. */
    provider: WikipediaProvider;
    /** Per-user metered-call budget (signed-in callers). */
    quota: FixedWindowQuota;
    /**
     * Guest budgets (#8), both enforced: a strict per-session bucket and an
     * aggregate per-address bucket, so rotating sessions cannot reset the
     * allowance. When omitted, guests are refused rather than admitted
     * unmetered.
     */
    guest?: {
        session: FixedWindowQuota<string>;
        address: FixedWindowQuota<string>;
    };
}

/** Renders one candidate line: `Title — url`. */
function candidateLine(ref: WikipediaArticleRef): string {
    return `- ${ref.title} — ${ref.url}`;
}

/**
 * Formats one lookup as model-facing text.
 *
 * Pure and exported for tests. Three shapes, each saying plainly what
 * happened so the model neither invents an answer nor pretends a lookup
 * succeeded:
 *
 * - an article: `Title — url` then its extract (with an explicit truncation
 *   note when `detail: "full"` had to cut);
 * - candidates: the ambiguous page's choices, with an instruction to pick
 *   one or narrow the query;
 * - no match: a single sentence naming the query.
 */
export function formatWikipediaLookup(
    result: WikipediaLookup,
    query: string,
): string {
    if (result.kind === "no-match") {
        return `No Wikipedia article matched "${query}".`;
    }
    if (result.kind === "candidates") {
        if (result.candidates.length === 0) {
            // The ambiguous page itself is dropped from the candidate list, so
            // an empty list right after reaching a disambiguation page still
            // has context worth stating rather than a bare "no match".
            return result.page
                ? `"${result.page.title}" is a disambiguation page and no single article matched "${query}". Ask the user to be more specific.`
                : `No Wikipedia article matched "${query}".`;
        }
        const header = result.page
            ? `"${result.page.title}" is a disambiguation page, so it does not answer the question. Closest articles:`
            : `No single Wikipedia article matched "${query}". Candidates:`;
        return [
            header,
            ...result.candidates.map(candidateLine),
            "Ask the user which one they mean, or call again with a more specific query.",
        ].join("\n");
    }
    const body = `${result.title} — ${result.url}\n\n${result.extract}`;
    if (!result.truncated) {
        return body;
    }
    const total = result.extract.length + result.omittedChars;
    return `${body}\n\n[extract truncated: ${result.omittedChars} of ${total} characters omitted — the full article is at ${result.url}]`;
}

/** Model-facing text for a failed lookup; never leaks HTTP internals. */
function failureText(reason: string): string {
    logger.warn(`wikipedia failed — ${reason}`);
    return "Wikipedia lookup failed. Answer from your own knowledge, or tell the user that Wikipedia is temporarily unavailable.";
}

/**
 * Builds the `wikipedia` tool over the injected client and budgets.
 */
export function createWikipediaTool(deps: WikipediaDeps) {
    return tool(
        async ({ query, detail }, runtime: ToolRuntime): Promise<string> => {
            const gate = requireMeteredCaller(
                runtime,
                { user: deps.quota, guest: deps.guest },
                { subject: "Wikipedia lookup", logName: "wikipedia" },
            );
            if (!gate.ok) {
                return gate.text;
            }
            const effectiveDetail = detail ?? "summary";
            try {
                const result = await deps.provider.lookup(
                    query,
                    effectiveDetail,
                    runtime.signal,
                );
                logger.debug(
                    `wikipedia(${effectiveDetail}) for ${gate.caller.kind} → ${result.kind}`,
                );
                return formatWikipediaLookup(result, query);
            } catch (err) {
                // A cancelled turn must reject (the graph's bare-done path),
                // not hand the model "lookup failed" text to relay.
                runtime.signal?.throwIfAborted();
                return failureText(
                    err instanceof WikipediaError
                        ? err.message
                        : "unexpected error",
                );
            }
        },
        {
            name: "wikipedia",
            description:
                "Looks up an encyclopedic topic on Wikipedia and returns the " +
                "article's title, its URL, and a text extract — use it for " +
                "facts about people, places, things, events, science, and " +
                "history, and base your answer on the returned extract rather " +
                "than on memory or a guess. Pass the topic as `query` in " +
                "natural words ('Ada Lovelace', 'the War of 1812'). It returns " +
                "a short lead summary by default; pass `detail: 'full'` only " +
                "when the user needs more depth, and note that the returned " +
                "extract may be truncated (the result says so, and links the " +
                "full article). If the result lists candidate articles, ask " +
                "the user which they mean or retry with a more specific " +
                "query. For recent news, live prices, schedules, or anything " +
                "that changes often, use webSearch instead — Wikipedia is for " +
                "settled, encyclopedic background.",
            schema: z.object({
                query: z
                    .string()
                    .describe(
                        "The topic to look up, in natural words " +
                            "('Ada Lovelace', 'photosynthesis', 'the War of 1812')",
                    ),
                detail: z
                    .enum(["summary", "full"])
                    .optional()
                    .describe(
                        "'summary' (the default) returns a short lead " +
                            "extract; 'full' returns much more of the " +
                            "article, possibly truncated",
                    ),
            }),
        },
    );
}
