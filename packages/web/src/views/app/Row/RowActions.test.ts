/**
 * Wiring tests for the folded `⋯` row menu (#156 review).
 *
 * The menu is a **popover**, and that is the fix for two live-pass bugs: a menu
 * inside a card that `backdrop-filter` turns into a stacking context painted
 * behind the cards after it, and the snooze menu and this one could both be
 * open at once. Both are properties of the *markup* — `popover="auto"` (the top
 * layer, and one open at a time) reached through `popovertarget` — so, like
 * `SnoozeMenu.test.ts`, this stays a node-only render with no DOM. Effects do
 * not run in server rendering; the markup is the contract.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RowActions } from "./RowActions";

/**
 * One attribute's value out of a rendered tag, or `null`.
 *
 * Case-insensitive because React's prop is `popoverTarget` while the DOM writes
 * `popovertarget`; comparing the spellings is comparing the same wiring.
 */
function attr(tag: string, name: string): string | null {
    const match = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
    return match === null ? null : (match[1] ?? null);
}

/** The markup, rendered once for every test. */
const html = renderToStaticMarkup(
    createElement(RowActions, {
        actions: [
            { label: "Edit", onClick: () => undefined },
            { label: "Cancel", onClick: () => undefined },
        ],
    }),
);

const toggleTag = /<button[^>]*row-actions-toggle[^>]*>/.exec(html)?.[0] ?? "";
const menuTag = /<div[^>]*row-actions-menu[^>]*>/.exec(html)?.[0] ?? "";

describe("RowActions", () => {
    it("marks the menu as an auto popover", () => {
        // `auto` is the top layer (so no card paints over it) and one-open-at-a-
        // time (so it and the snooze menu close each other).
        expect(attr(menuTag, "popover")).toBe("auto");
    });

    it("points the toggle at the menu, so the button opens it", () => {
        expect(attr(toggleTag, "popovertarget")).not.toBeNull();
        expect(attr(toggleTag, "popovertarget")).toBe(attr(menuTag, "id"));
    });

    it("starts collapsed, and says so", () => {
        expect(attr(toggleTag, "aria-expanded")).toBe("false");
    });

    it("keeps the actions in the markup, in order", () => {
        const edit = html.indexOf(">Edit</button>");
        const cancel = html.indexOf(">Cancel</button>");
        expect(edit).toBeGreaterThan(-1);
        expect(edit).toBeLessThan(cancel);
    });

    it("renders nothing when there are no actions", () => {
        const empty = renderToStaticMarkup(
            createElement(RowActions, { actions: [] }),
        );
        expect(empty).toBe("");
    });
});
