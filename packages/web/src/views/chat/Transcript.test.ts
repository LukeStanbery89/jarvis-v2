/**
 * Transcript rendering (#147).
 *
 * The suite is node-only, so the transcript is rendered to static markup. What
 * matters here is the rendering rule rather than the scroll effect: both sides
 * of the conversation go through the same hardened Markdown component.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "./Transcript";
import type { ThreadMessage } from "../../threads";

function render(messages: ThreadMessage[]): string {
    return renderToStaticMarkup(
        createElement(Transcript, {
            messages,
            previews: {},
            hasThread: true,
            activeId: "thread-1",
        }),
    );
}

describe("Transcript", () => {
    it("renders user and assistant text as Markdown (#147)", () => {
        const html = render([
            {
                id: "u1",
                role: "user",
                text: "**Bold** and `code`",
                at: 1,
            },
            {
                id: "a1",
                role: "assistant",
                text: "## Heading\n\n1. one\n2. two",
                at: 2,
            },
        ]);

        expect(html).toContain("<strong>Bold</strong>");
        expect(html).toContain("<code>code</code>");
        expect(html).toContain("<h2>Heading</h2>");
        expect(html).toContain("<ol>");
        expect(html).toContain("<li>one</li>");
    });

    it("keeps a failed assistant turn as an error line, not Markdown", () => {
        const html = render([
            {
                id: "a1",
                role: "assistant",
                text: "**the model failed**",
                at: 1,
                error: true,
            },
        ]);

        expect(html).toContain("msg assistant error");
        expect(html).toContain("**the model failed**");
        expect(html).not.toContain("<strong>");
    });
});
