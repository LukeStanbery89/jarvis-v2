/**
 * Wiring test for the sidebar's delete gesture (#157).
 *
 * The suite is node-only and has no DOM, so this renders the named surface —
 * `Sidebar` — to static markup, the shape `NavigationLabels.test.ts` uses. That
 * is enough to catch the regression this change is about: a row falling back to
 * a one-tap delete, or a hold control that does not carry the row's name and the
 * shared three-second duration.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HOLD_TO_DELETE_MS } from "../app/HoldToDelete";
import { Sidebar, type SidebarProps } from "./Sidebar";

/**
 * The sidebar's props, complete enough to render, overridable per test.
 *
 * @param overrides - Props to replace.
 * @returns A complete prop set.
 */
function sidebar(overrides: Partial<SidebarProps> = {}): SidebarProps {
    return {
        entries: [
            { id: "alpha", title: "Alpha", lastActive: 2 },
            { id: "voice", title: "Voice notes", lastActive: 1, kind: "voice" },
        ],
        activeId: "alpha",
        streaming: false,
        onNewChat: () => undefined,
        onOpenThread: () => undefined,
        onRemoveThread: () => undefined,
        ...overrides,
    };
}

describe("Sidebar", () => {
    it("makes every row's delete a hold, named after that row", () => {
        const html = renderToStaticMarkup(createElement(Sidebar, sidebar()));

        expect(html).toContain('aria-label="Hold to delete Alpha"');
        expect(html).toContain('aria-label="Hold to delete Voice notes"');
        // The old one-tap control is gone, not merely supplemented.
        expect(html).not.toContain('aria-label="Delete Alpha"');
    });

    it("gives each row the shared duration, with no ring at rest", () => {
        const html = renderToStaticMarkup(createElement(Sidebar, sidebar()));

        expect(
            html.match(new RegExp(`data-hold-ms="${HOLD_TO_DELETE_MS}"`, "g")),
        ).toHaveLength(2);
        // #211: the outward ring is mounted only while a hold is live.
        expect(html).not.toContain('class="hold-to-delete-ring"');
        expect(html).not.toContain('class="hold-to-delete-track"');
        expect(html).not.toContain('class="hold-to-delete-fill"');
    });

    it("keeps the delete control's row placement", () => {
        const html = renderToStaticMarkup(createElement(Sidebar, sidebar()));

        expect(html).toContain('class="icon-btn hold-to-delete thread-delete"');
    });
});
