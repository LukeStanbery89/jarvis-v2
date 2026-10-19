/**
 * Placement tests for a floating menu (#90 phase 7).
 *
 * The menu itself needs a DOM, which this package's suite does not have — so
 * what is asserted is the arithmetic that decides whether it is visible at all:
 * under the toggle, right-aligned, flipped when the room below is gone, clamped
 * when the anchor is near an edge.
 */
import { describe, expect, it } from "vitest";
import { menuPlacement, MENU_GAP } from "./popover";
import type { AnchorBox, MenuBox, ViewportBox } from "./popover";

/** A toggle box; only the fields placement reads need to be given. */
function anchor(over: Partial<AnchorBox> = {}): AnchorBox {
    return { top: 100, right: 300, bottom: 124, ...over };
}

const MENU: MenuBox = { width: 120, height: 96 };
const VIEWPORT: ViewportBox = { width: 800, height: 600 };

describe("menuPlacement", () => {
    it("hangs below the toggle, right-aligned to it", () => {
        const placed = menuPlacement(anchor(), MENU, VIEWPORT);
        expect(placed).toEqual({
            left: 180, // 300 (anchor right) - 120 (menu width)
            top: 128, // 124 (anchor bottom) + 4 (gap)
            flipped: false,
        });
        expect(MENU_GAP).toBe(4);
    });

    it("flips above when the room below is gone", () => {
        // A row near the bottom of a short window: the toast's buttons are the
        // case that matters, and a menu that stayed below would be invisible.
        const placed = menuPlacement(anchor({ top: 500, bottom: 524 }), MENU, {
            width: 800,
            height: 560,
        });
        expect(placed.flipped).toBe(true);
        expect(placed.top).toBe(500 - MENU_GAP - MENU.height);
    });

    it("stays below when there is no room above either", () => {
        // A menu taller than both gaps: below is the half worth showing, and the
        // first preset is at its top.
        const placed = menuPlacement(anchor({ top: 10, bottom: 34 }), MENU, {
            width: 800,
            height: 120,
        });
        expect(placed.flipped).toBe(false);
        expect(placed.top).toBe(34 + MENU_GAP);
    });

    it("keeps the gap from the left edge when the anchor is near it", () => {
        // A short action row: right-aligning to a button at the far left would
        // put the menu off the screen.
        const placed = menuPlacement(anchor({ right: 40 }), MENU, VIEWPORT);
        expect(placed.left).toBe(MENU_GAP);
    });

    it("clamps to the right edge when the anchor is flush with it", () => {
        // Right-aligning to a button that ends 1px from the window's edge would
        // leave the menu's own edge on the glass.
        const placed = menuPlacement(anchor({ right: 799 }), MENU, VIEWPORT);
        expect(placed.left).toBe(800 - MENU_GAP - MENU.width);
    });

    it("keeps the left gap when the menu is wider than the viewport", () => {
        // Nothing to clamp to on either side: the left gap is the honest answer,
        // rather than a negative offset that would clip its first character.
        const placed = menuPlacement(
            anchor({ right: 790 }),
            { width: 300, height: 96 },
            { width: 200, height: 600 },
        );
        expect(placed.left).toBe(MENU_GAP);
    });
});
