/**
 * The `webSearch` tool (#9): the agent's window onto the live web.
 *
 * One tool for the model — not one per provider — because a 4B local model
 * handles a single well-described search surface far more reliably than two
 * overlapping ones. Provider selection is routing behind the tool:
 *
 * - **Tavily first** for its verticals (`general` / `news` / `finance`): it
 *   is LLM-optimized AND runs on a free monthly quota, while Serper is
 *   pay-as-you-go — so the default path preserves the operator's Serper
 *   budget.
 * - **Serper for everything else** (`images` / `videos` / `places` /
 *   `reviews` / `patents` / `shopping` / `scholar`): verticals Tavily does
 *   not have.
 * - **Fallback**: a Tavily-route query that fails (or arrives with Tavily
 *   unconfigured) retries on Serper; a Serper-only vertical has no Tavily
 *   equivalent and simply reports failure.
 *
 * Calls are metered: the per-user fixed-window quota is checked BEFORE any
 * provider fetch, and its refusal returns model-facing retry text rather
 * than throwing — the model relays "try again in Ns" instead of erroring
 * the turn. Provider failures surface as actionable model-facing text too,
 * never as raw exceptions (the model can still answer from its own
 * knowledge).
 *
 * The caller's identity arrives through LangGraph's `configurable.userId`
 * (stamped by `ws.ts` on every authenticated turn — the same verified seam
 * the `analyzeImage` tool uses), so the quota keys on the real account.
 */
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import {
    TAVILY_VERTICALS,
    SearchError,
    type SearchAnswer,
    type SearchProvider,
    type SearchVertical,
} from "./search/types";
import { FixedWindowQuota } from "../../rate/fixedWindowQuota";
import { logger } from "../../logger";

/** Everything the tool needs, injected at wiring time. */
export interface WebSearchDeps {
    /** Configured providers in priority order (Tavily before Serper). */
    providers: SearchProvider[];
    /** Per-user metered-call budget. */
    quota: FixedWindowQuota;
}

/**
 * Formats a normalized search answer as model-facing text.
 *
 * Pure and exported for tests: Tavily's summary (when present) leads, then
 * numbered `title — url` lines with indented snippets. Empty results say so
 * plainly — the model should tell the user rather than invent hits.
 */
export function formatSearchAnswer(answer: SearchAnswer): string {
    if (answer.results.length === 0 && !answer.summary) {
        return "No results found.";
    }
    const lines: string[] = [];
    if (answer.summary) {
        lines.push(answer.summary, "");
    }
    answer.results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.title} — ${result.url}`);
        if (result.snippet) {
            lines.push(`   ${result.snippet}`);
        }
    });
    return lines.join("\n");
}

/** Model-facing text for a failed search; never leaks keys or internals. */
function failureText(attempts: { provider: string; reason: string }[]): string {
    const detail = attempts.map((a) => `${a.provider}: ${a.reason}`).join("; ");
    logger.warn(`webSearch failed — ${detail}`);
    return "Web search failed. Answer from your own knowledge, or tell the user that search is temporarily unavailable.";
}

/** The `kind` tokens the tool's schema accepts (the full vertical union). */
const VERTICAL_ENUM = [
    "general",
    "news",
    "finance",
    "images",
    "videos",
    "places",
    "reviews",
    "patents",
    "shopping",
    "scholar",
] as const;

/**
 * Builds the `webSearch` tool over injected providers and quota.
 *
 * `deps.providers` MUST be ordered Tavily-first (the wiring guarantees it);
 * the router re-orders per vertical anyway, so a future provider slot stays
 * safe.
 */
export function createWebSearchTool(deps: WebSearchDeps) {
    return tool(
        async ({ query, kind }, runtime: ToolRuntime): Promise<string> => {
            const owner = runtime.configurable?.userId;
            if (typeof owner !== "number" || !Number.isInteger(owner)) {
                logger.warn("webSearch called without a user id");
                return "Web search requires signing in. Ask the user to authenticate and retry.";
            }
            const admission = deps.quota.tryAcquire(owner);
            if (!admission.ok) {
                const seconds = Math.max(
                    1,
                    Math.ceil(admission.retryAfterMs / 1000),
                );
                return `Web search is rate limited — try again in about ${seconds}s.`;
            }
            const vertical: SearchVertical = kind ?? "general";
            // Prefer Tavily wherever it can serve the vertical; otherwise
            // Serper is the only candidate.
            const ordered = [
                ...deps.providers.filter(
                    (p) =>
                        p.name === "tavily" && TAVILY_VERTICALS.has(vertical),
                ),
                ...deps.providers.filter((p) => p.name === "serper"),
            ];
            const attempts: { provider: string; reason: string }[] = [];
            for (const provider of ordered) {
                try {
                    const answer = await provider.search(query, vertical);
                    logger.debug(
                        `webSearch(${vertical}) via ${answer.provider}: ${answer.results.length} results`,
                    );
                    return formatSearchAnswer(answer);
                } catch (err) {
                    attempts.push({
                        provider: provider.name,
                        reason:
                            err instanceof SearchError
                                ? err.message
                                : "unexpected error",
                    });
                }
            }
            return failureText(attempts);
        },
        {
            name: "webSearch",
            description:
                "Searches the live web and returns titles, URLs, and snippets. " +
                "Pass the user's information need as `query`. Use `kind` to pick " +
                "the vertical: 'general' (default), 'news', or 'finance' go to " +
                "a search engine optimized for LLMs; 'images', 'videos', " +
                "'places', 'reviews', 'patents', 'shopping', and 'scholar' go " +
                "to Google-search verticals. Use it whenever the answer needs " +
                "current or outside knowledge.",
            schema: z.object({
                query: z
                    .string()
                    .min(1)
                    .describe(
                        "The user's information need, verbatim or lightly sharpened",
                    ),
                kind: z
                    .enum(VERTICAL_ENUM)
                    .optional()
                    .describe("The search vertical; 'general' when omitted"),
            }),
        },
    );
}
