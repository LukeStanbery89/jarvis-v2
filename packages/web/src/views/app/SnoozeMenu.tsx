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
 * Escape, a click outside, one open at a time — and the shared
 * {@link usePopoverMenu} owns only the placement, because a popover is centred
 * in the viewport unless measured (`menuPlacement` in `src/popover.ts`).
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
import { SNOOZE_PRESETS } from "../../jobs";
import { usePopoverMenu } from "../../hooks/usePopoverMenu";

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
    const { menuId, open, toggleRef, menuRef, onToggle } = usePopoverMenu();

    return (
        <span className={`snooze${open ? " open" : ""}`}>
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
                onToggle={onToggle}
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
