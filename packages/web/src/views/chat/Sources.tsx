/**
 * The original-source list under a web-search answer (#199).
 *
 * Search results are shown as compact numbered cards rather than raw URLs:
 * the title is the thing a user recognizes, the hostname says which site it
 * is, and the whole card opens in a new tab. The list is deliberately outside
 * the assistant bubble (a sibling in the transcript's flex column) so the
 * answer keeps its glass shape and the sources read as a separate footnote.
 *
 * The whole block is a collapsed `details`: "Sources · 5" is the quiet
 * affordance, and opening it reveals the cards. In an installed PWA a click
 * is diverted to the system browser by `externalBrowser.ts`; in a normal tab
 * the anchor's `target="_blank"` opens the new tab.
 */
import { ChevronDown, Link2 } from "lucide-react";
import type { ToolSource } from "@lukestanbery/jarvis-protocol";
import {
    detectSourceLinkEnvironment,
    openSourceInSystemBrowser,
    type SourceLinkEnvironment,
} from "./externalBrowser";
import { sourceLinks } from "./sourceLinks";

/** Props for {@link Sources}. */
export interface SourcesProps {
    /** Raw sources attached to the turn's tool result(s). */
    sources: readonly ToolSource[];
}

/**
 * Renders one answer's sources, or nothing when none survive vetting.
 *
 * @param props - See {@link SourcesProps}.
 */
export function Sources({ sources }: SourcesProps) {
    const links = sourceLinks(sources);
    if (links.length === 0) {
        return null;
    }
    // Node-rendered tests have no window; a real page always has one. The
    // detection is cheap and stays out of render until a click needs it.
    const environment: SourceLinkEnvironment | null =
        typeof window === "undefined"
            ? null
            : detectSourceLinkEnvironment(window);
    return (
        <details className="sources">
            <summary className="sources-heading">
                <Link2 size={13} aria-hidden="true" />
                <span>Sources</span>
                <span className="sources-count">{links.length}</span>
                <ChevronDown
                    className="sources-chevron"
                    size={14}
                    aria-hidden="true"
                />
            </summary>
            <ol className="source-list">
                {links.map((link, index) => (
                    <li key={link.href}>
                        <a
                            className="source-link"
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={link.href}
                            onClick={(event) => {
                                if (environment !== null) {
                                    openSourceInSystemBrowser(
                                        event,
                                        link.href,
                                        environment,
                                    );
                                }
                            }}
                        >
                            <span className="source-number" aria-hidden="true">
                                {index + 1}
                            </span>
                            <span className="source-text">
                                <span className="source-title">
                                    {link.title}
                                </span>
                                <span className="source-domain">
                                    {link.domain}
                                </span>
                            </span>
                        </a>
                    </li>
                ))}
            </ol>
        </details>
    );
}
