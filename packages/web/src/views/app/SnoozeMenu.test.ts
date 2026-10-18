/**
 * Wiring tests for the snooze menu (#90 phase 7).
 *
 * This is the one component this suite renders, and it earns the exception: the
 * bug it guards against is invisible to a pure test. The presets are a
 * **popover**, so they are only on screen when the toggle points at the menu
 * (`popovertarget` → the menu's `id`) and the menu is marked `popover="auto"`. A
 * missing attribute renders the menu permanently open over the page; a missing
 * invoker makes the button dead. Both are exactly what a live pass reports as
 * "it does nothing" or "it is always open", and neither is reachable from
 * `jobs.ts`.
 *
 * `react-dom/server` needs no DOM, so this stays inside the package's node-env
 * suite. Effects do not run in server rendering — which is the point: the
 * *markup* is the contract under test, not the placement.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SNOOZE_PRESETS } from "../../jobs";
import { SnoozeMenu } from "./SnoozeMenu";

/**
 * One attribute's value out of a rendered tag, or `null`.
 *
 * Case-insensitive on purpose: React's prop is `popoverTarget` and its server
 * renderer writes that spelling, while the DOM lowercases an attribute name when
 * it is set on an HTML element (so the attribute that actually reaches the
 * browser is `popovertarget`). Comparing the two spellings is comparing the same
 * wiring.
 */
function attr(tag: string, name: string): string | null {
    const match = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
    return match === null ? null : (match[1] ?? null);
}

/** The markup, rendered once for every test. */
const html = renderToStaticMarkup(
    createElement(SnoozeMenu, { onSnooze: () => undefined }),
);

const toggleTag = /<button[^>]*snooze-toggle[^>]*>/.exec(html)?.[0] ?? "";
const menuTag = /<div[^>]*snooze-options[^>]*>/.exec(html)?.[0] ?? "";

describe("SnoozeMenu", () => {
    it("marks the presets as a popover, so the platform hides it while closed", () => {
        // Without this the menu is a plain div: visible all the time, over
        // whatever page the user is on.
        expect(attr(menuTag, "popover")).toBe("auto");
    });

    it("points the toggle at the menu, so the button opens it", () => {
        // The platform's invoker (not a handler calling `togglePopover`), which
        // is also what lets a second press close it — light dismiss fires on
        // pointerdown, and a click handler would find it closed and reopen it.
        expect(attr(toggleTag, "popovertarget")).not.toBeNull();
        expect(attr(toggleTag, "popovertarget")).toBe(attr(menuTag, "id"));
    });

    it("starts collapsed, and says so", () => {
        expect(attr(toggleTag, "aria-expanded")).toBe("false");
    });

    it("offers the three presets, in the plan's order", () => {
        for (const preset of SNOOZE_PRESETS) {
            expect(html).toContain(`>${preset.label}</button>`);
        }
        const first = html.indexOf(">in an hour</button>");
        const last = html.indexOf(">next week</button>");
        expect(first).toBeGreaterThan(-1);
        expect(first).toBeLessThan(last);
    });
});
