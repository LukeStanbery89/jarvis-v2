/**
 * The state and placement one floating menu needs (#156 review).
 *
 * Both of a row's menus — the snooze presets and the folded `⋯` actions — are
 * **popovers**: they live in the browser's top layer, so a scroll container
 * cannot clip them and a card that sets `backdrop-filter` (which makes it a
 * stacking context) cannot paint over them. That is the platform's half. This
 * hook owns the half the platform does not do for us:
 *
 * - a stable `menuId` to point `popoverTarget` at,
 * - whether the menu is open, kept from its own `toggle` event,
 * - the two refs (`toggleRef`, `menuRef`) the measurement needs,
 * - the placement itself, and re-placing on scroll/resize while open.
 *
 * The mutual exclusion the reviewer asked for is the platform's too: two
 * `popover="auto"` menus cannot be open at once, so opening either closes the
 * other without either component knowing the other exists.
 *
 * `react-dom/server` never runs effects, so a component using this renders its
 * markup (the toggle, the popover, the buttons) with no DOM — which is what the
 * node-only suites assert.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RefObject, SyntheticEvent } from "react";
import { menuPlacement } from "../popover";

/** What {@link usePopoverMenu} hands back to the component that renders it. */
export interface PopoverMenu {
    /** The popover's id; the toggle's `popoverTarget` and `aria-controls`. */
    menuId: string;
    /** Whether the menu is currently open (from its `toggle` event). */
    open: boolean;
    /** The element that opens the menu. */
    toggleRef: RefObject<HTMLButtonElement | null>;
    /** The popover itself, measured for placement. */
    menuRef: RefObject<HTMLDivElement | null>;
    /** The popover's `onToggle` handler: tracks state and places on open. */
    onToggle(event: SyntheticEvent<HTMLDivElement>): void;
}

/**
 * Wire up one popover menu.
 *
 * @returns The id, state, refs and toggle handler a menu component binds to.
 */
export function usePopoverMenu(): PopoverMenu {
    const menuId = useId();
    const [open, setOpen] = useState(false);
    const toggleRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);

    /**
     * Puts the menu under its toggle, or above it when that is where the room
     * is. Measured, because the toggle is in an action row inside a card inside
     * a scrolling column — nothing in the stylesheet could know where it is.
     */
    const place = useCallback((): void => {
        const menu = menuRef.current;
        const toggle = toggleRef.current;
        if (menu === null || toggle === null) {
            return;
        }
        const placed = menuPlacement(
            toggle.getBoundingClientRect(),
            { width: menu.offsetWidth, height: menu.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
        );
        menu.style.left = `${placed.left}px`;
        menu.style.top = `${placed.top}px`;
    }, []);

    // While open, the anchor can move under the menu: the page behind scrolls,
    // or the window resizes. Re-place rather than close — a menu that
    // disappeared on a scroll would lose the click it was opened for.
    useEffect(() => {
        if (!open) {
            return;
        }
        const reposition = (): void => place();
        window.addEventListener("scroll", reposition, {
            capture: true,
            passive: true,
        });
        window.addEventListener("resize", reposition);
        return () => {
            window.removeEventListener("scroll", reposition, { capture: true });
            window.removeEventListener("resize", reposition);
        };
    }, [open, place]);

    const onToggle = useCallback(
        (event: SyntheticEvent<HTMLDivElement>): void => {
            // The popover's own event is the state: Escape and a click outside
            // close it without this hook being asked. Placement happens here
            // because the event fires with the popover already laid out, so it
            // is positioned before the browser paints.
            const opened =
                (event.nativeEvent as ToggleEvent).newState === "open";
            setOpen(opened);
            if (opened) {
                place();
            }
        },
        [place],
    );

    return { menuId, open, toggleRef, menuRef, onToggle };
}
