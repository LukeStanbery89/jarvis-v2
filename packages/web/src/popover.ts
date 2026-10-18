/**
 * Where a floating menu hangs from the control that opened it (#90 phase 7).
 *
 * A dropdown cannot be placed by CSS alone in this app: the toast lives in a
 * scrolling column (`.toast-stack`), and a scroll container clips its
 * descendants — absolutely positioned ones included. So the menu is a **popover**
 * (the top layer, where nothing clips it) and "below the button, right-aligned" is
 * a measurement of two boxes rather than a stylesheet rule.
 *
 * The measurement is pure and lives here, next to the test suite, because the
 * failures it can have are silent: a menu that refuses to flip is off-screen on a
 * short window, and one that is not clamped is half over the edge on a narrow
 * one. It is also the only part of a popover the platform does not do for us.
 */

/** The part of an anchor's `DOMRect` the placement needs. */
export interface AnchorBox {
    /** Distance from the viewport's top edge to the anchor's top. */
    top: number;
    /** Distance from the viewport's left edge to the anchor's right. */
    right: number;
    /** Distance from the viewport's top edge to the anchor's bottom. */
    bottom: number;
}

/** A menu's measured size. */
export interface MenuBox {
    /** Its rendered width. */
    width: number;
    /** Its rendered height. */
    height: number;
}

/** The viewport, as a box (`window.innerWidth` / `innerHeight`). */
export interface ViewportBox {
    /** The viewport's width. */
    width: number;
    /** The viewport's height. */
    height: number;
}

/** Where the menu's top-left corner goes, in viewport coordinates. */
export interface MenuPlacement {
    /** Distance from the viewport's left edge. */
    left: number;
    /** Distance from the viewport's top edge. */
    top: number;
    /** Whether it went above the anchor instead of below. */
    flipped: boolean;
}

/** The gap left between an anchor and its menu, in pixels. */
export const MENU_GAP = 4;

/**
 * Places a menu under its anchor, right-aligned, flipping and clamping as needed.
 *
 * The anchor is a button in an action row, so the menu's right edge lines up with
 * the button's — the direction a dropdown from a row's end reads. It flips above
 * only when there is no room below *and* real room above; when neither side fits
 * (a menu taller than both gaps) it stays below, because the top of a menu is the
 * part worth seeing and the first preset is there.
 *
 * @param anchor - The toggle's box.
 * @param menu - The menu's measured box.
 * @param viewport - The window's inner size.
 * @param gap - The gap to leave between the anchor and the menu (and the edge).
 * @returns The coordinates for the menu's top-left corner, and whether it flipped.
 */
export function menuPlacement(
    anchor: AnchorBox,
    menu: MenuBox,
    viewport: ViewportBox,
    gap: number = MENU_GAP,
): MenuPlacement {
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - menu.height;
    const fitsBelow = below + menu.height <= viewport.height - gap;
    const fitsAbove = above >= gap;
    const flipped = !fitsBelow && fitsAbove;
    // Right-aligned to the anchor, then pulled inside the left edge; a menu wider
    // than the viewport keeps the gap rather than going negative.
    const left = Math.min(
        Math.max(gap, anchor.right - menu.width),
        Math.max(gap, viewport.width - gap - menu.width),
    );
    return { left, top: flipped ? above : below, flipped };
}
