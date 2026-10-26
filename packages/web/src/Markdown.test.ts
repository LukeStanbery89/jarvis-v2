/**
 * Markdown surface tests (#147).
 *
 * Node-only static markup: links are not rendered here (the relative `safeHref`
 * context is a browser concern), while the table wrapper is exactly what a
 * wide GFM table needs.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

function render(text: string): string {
    return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("Markdown", () => {
    it("puts a table in its own horizontal scroll region", () => {
        const html = render(
            [
                "| Rank | Album | Weeks at #1 |",
                "| ---: | :--- | ---: |",
                "| 1 | The Tortured Poets Department | 17 weeks |",
            ].join("\n"),
        );

        expect(html).toContain('class="markdown-table-scroll"');
        expect(html).toContain('role="region"');
        expect(html).toContain('aria-label="Table"');
        expect(html).toContain('tabindex="0"');
        expect(html).toContain("<table>");
        expect(html).toContain("The Tortured Poets Department");
        // GFM would put `text-align:right` on this header; the surface
        // left-aligns every header regardless of the column's body alignment.
        expect(html).toContain('<th style="text-align:left">Rank</th>');
        expect(html).not.toContain('<th style="text-align:right"');
    });

    it("does not wrap ordinary prose in a table scroller", () => {
        const html = render("**Bold** paragraph");

        expect(html).toContain("<strong>Bold</strong>");
        expect(html).not.toContain("markdown-table-scroll");
    });
});
