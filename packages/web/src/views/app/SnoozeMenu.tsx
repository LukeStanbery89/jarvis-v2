/**
 * The snooze control (#90 phase 6c; a dropdown since the 7c live pass): one
 * button, and its three offsets in a menu.
 *
 * **The menu is a popover.** That is the only way a menu opened from inside the
 * toast can be seen at all: `.toast-stack` is a scrolling column, and a scroll
 * container clips every descendant — absolutely positioned ones included. The
 * first attempt was an absolutely positioned menu (clipped, invisible) and the
 * second was inline chips (visible, but they reflowed the card: four actions and
 * three presets do not fit on one line of a 26rem card). A popover lives in the
 * top layer, so nothing clips it; the platform brings what a menu owes a user —
 * Escape, a click outside, one open at a time — and this component owns only the
 * placement, because a popover is centred in the viewport unless measured
 * (`menuPlacement` in `src/popover.ts`).
 *
 * Shared by everything that can defer a reminder — the floating toast, the
 * notifications page's rows, the reminder list — because a snooze offered in
 * three places has to be the same three choices in the same order, and the labels
 * are the interface (the server takes minutes; `SNOOZE_PRESETS` is what they
 * mean).
 *
 * `onSnooze` is synchronous by design — the caller owns the request and its
 * outcome, and `useJobs` reports failure as a value rather than a rejection, so
 * there is nothing here to catch.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SNOOZE_PRESETS } from "../../jobs";
import { menuPlacement } from "../../popover";

/** Props for {@link SnoozeMenu}. */
export interface SnoozeMenuProps {
    /** Defers the reminder by `minutes`. Fire-and-forget by contract. */
    onSnooze(minutes: number): void;
}

/**
 * The snooze button and its three presets.
 *
 * @param props - See {@link SnoozeMenuProps}.
 */
export function SnoozeMenu({ onSnooze }: SnoozeMenuProps) {
    /** The popover's id, and the toggle's `aria-controls` (unique per row). */
    const menuId = useId();
    const [open, setOpen] = useState(false);
    const toggleRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);

    /**
     * Puts the menu under its toggle, or above it when that is where the room is.
     *
     * Measured, because the alternative is CSS that knows where the toggle is —
     * and the toggle is in an action row inside a card inside a scrolling column,
     * so nothing in the stylesheet could know.
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

    // While open, the anchor can move under the menu: the toast's column or the
    // page behind scrolls, or the window resizes. Re-place rather than close — a
    // menu that disappeared on a scroll would lose the click it was opened for.
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

    return (
        <span className="snooze">
            <button
                ref={toggleRef}
                type="button"
                className="snooze-toggle"
                // The platform's own invoker, not a handler that calls
                // `togglePopover()`: light dismiss closes the menu on
                // *pointerdown*, so a click handler would find it closed and
                // re-open it — the button could never close its own menu.
                popoverTarget={menuId}
                aria-expanded={open}
                aria-controls={menuId}
            >
                Snooze
            </button>
            <div
                ref={menuRef}
                id={menuId}
                popover="auto"
                className="snooze-options"
                role="group"
                aria-label="Snooze for"
                // The popover's own events are the state: Escape and a click
                // outside close it without this component being asked. It is also
                // where placement happens — the event fires with the popover
                // already laid out, so measuring here puts it in position before
                // the browser paints, rather than a frame later from an effect.
                onToggle={(event) => {
                    const opened =
                        (event.nativeEvent as ToggleEvent).newState === "open";
                    setOpen(opened);
                    if (opened) {
                        place();
                    }
                }}
            >
                {SNOOZE_PRESETS.map((preset) => (
                    <button
                        key={preset.minutes}
                        type="button"
                        onClick={() => {
                            menuRef.current?.hidePopover();
                            onSnooze(preset.minutes);
                        }}
                    >
                        {preset.label}
                    </button>
                ))}
            </div>
        </span>
    );
}
