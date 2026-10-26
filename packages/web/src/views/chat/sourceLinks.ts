/**
 * Original-source bookkeeping for the chat transcript (#199).
 *
 * The server attaches a search result's links to its `toolResult` as
 * presentation metadata. The transcript stores those links on the adjacent
 * tool notice, so this module turns the message list back into "the sources
 * behind each assistant answer" without changing the turn's text records:
 *
 * - a turn runs from one user message to the next;
 * - every source from any tool in that turn belongs to its final assistant
 *   bubble (the answer the user is reading), not to each intermediate tool
 *   notice;
 * - the final turn's answer is named separately so the view can hold its
 *   sources back until the turn settles.
 */
import type { ToolSource } from "@lukestanbery/jarvis-protocol";
import { safeHref } from "../../safeHref";
import type { ThreadMessage } from "../../threads";

/** A source vetted for rendering as an external link. */
export interface SourceLink {
    /** Display title (falls back to the hostname). */
    title: string;
    /** Normalized absolute URL. */
    href: string;
    /** Hostname without a leading `www.`, for the secondary line. */
    domain: string;
}

/**
 * Vets and de-duplicates a source list for display.
 *
 * `safeHref` is the same allowlist the Markdown renderer uses, so a search
 * provider (or a compromised result) cannot turn a source into a
 * `javascript:`/`data:` link. Only external `http(s)` targets survive; an
 * unparseable or unsupported URL is skipped rather than rendered as text.
 * Duplicates are collapsed by their normalized URL, preserving first-seen
 * order.
 *
 * @param sources - Raw source metadata from one or more tool results.
 * @returns The link-ready sources, in first-seen order.
 */
export function sourceLinks(sources: readonly ToolSource[]): SourceLink[] {
    const seen = new Set<string>();
    const links: SourceLink[] = [];
    for (const source of sources) {
        const link = safeHref(source.url);
        if (!link || !link.external || seen.has(link.href)) {
            continue;
        }
        let domain: string;
        try {
            domain = new URL(link.href).hostname.replace(/^www\./i, "");
        } catch {
            continue;
        }
        if (domain === "") {
            continue;
        }
        seen.add(link.href);
        links.push({
            title: source.title.trim() || domain,
            href: link.href,
            domain,
        });
    }
    return links;
}

/** Sources mapped to the assistant answers that should display them. */
export interface SourceGroups {
    /** Assistant message id → the sources from its turn. */
    byAssistant: Map<string, ToolSource[]>;
    /**
     * The final turn's assistant id, or `null` when that turn has no answer
     * yet. The view uses this to keep an in-flight answer's sources hidden
     * until the turn settles.
     */
    currentAssistantId: string | null;
}

/**
 * Groups a transcript's tool sources onto the last assistant message of each
 * user turn.
 *
 * @param messages - The active thread's messages, oldest first.
 * @returns The per-answer sources and the final turn's assistant id.
 */
export function groupSources(messages: readonly ThreadMessage[]): SourceGroups {
    const byAssistant = new Map<string, ToolSource[]>();
    let pending: ToolSource[] = [];
    let currentAssistantId: string | null = null;

    const commit = (): void => {
        if (currentAssistantId !== null && pending.length > 0) {
            byAssistant.set(currentAssistantId, pending);
        }
        pending = [];
        currentAssistantId = null;
    };

    for (const message of messages) {
        if (message.role === "user") {
            commit();
            continue;
        }
        if (message.role === "tool") {
            if (message.tool.sources?.length) {
                pending.push(...message.tool.sources);
            }
            continue;
        }
        currentAssistantId = message.id;
    }

    const finalAssistantId = currentAssistantId;
    commit();
    return { byAssistant, currentAssistantId: finalAssistantId };
}
