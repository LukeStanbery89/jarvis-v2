/**
 * A row's actions, folded into one `⋯` menu (#156).
 *
 * The presentation module's point is that a row's primary fact gets the room; a
 * bar of Edit / Snooze / Cancel buttons is what took it. So the list pages show
 * a single trigger and the actions live behind it — the controls are
 * effectively zero-width until they are asked for.
 *
 * The menu is a **popover** (via {@link usePopoverMenu}), not a `<details>`. The
 * `<details>` it used to be painted *behind* later cards: `.page-rows` gives
 * every card `backdrop-filter`, which makes each one a stacking context, so an
 * absolutely-positioned menu inside an earlier card lost to the card after it.
 * A popover lives in the top layer, so nothing paints over it. It also gives
 * the reviewer's other note for free: two `popover="auto"` menus cannot be open
 * at once, so opening the snooze presets closes this menu and vice versa, with
 * neither control knowing the other exists. (The row's runs disclosure stays a
 * `<details>` — it is inline content, not a floating menu.)
 */
import { usePopoverMenu } from "../../../hooks/usePopoverMenu";
import { HapticButton } from "../HapticButton";

/** One action in a row's `⋯` menu. */
export interface RowAction {
    /** The button's label. Also its React key (labels are unique per row). */
    label: string;
    /** Runs the action. */
    onClick(): void;
}

/** Props for {@link RowActions}. */
export interface RowActionsProps {
    /** The actions to offer, in menu order. Empty renders nothing. */
    actions: RowAction[];
    /** Extra classes for the menu. */
    className?: string;
}

/**
 * One `⋯` menu of actions.
 *
 * @param props - See {@link RowActionsProps}.
 */
export function RowActions({ actions, className = "" }: RowActionsProps) {
    const { menuId, open, toggleRef, menuRef, onToggle } = usePopoverMenu();

    if (actions.length === 0) {
        return null;
    }
    return (
        <span
            className={`row-actions${open ? " open" : ""} ${className}`.trim()}
        >
            <button
                ref={toggleRef}
                type="button"
                className="row-actions-toggle"
                // The platform's own invoker, not a handler calling
                // `togglePopover()`: light dismiss closes the menu on
                // *pointerdown*, so a click handler would find it closed and
                // re-open it — the button could never close its own menu.
                popoverTarget={menuId}
                aria-label="Actions"
                aria-expanded={open}
                aria-controls={menuId}
            >
                ⋯
            </button>
            <div
                ref={menuRef}
                id={menuId}
                popover="auto"
                className="row-actions-menu"
                role="group"
                onToggle={onToggle}
            >
                {actions.map((action) => (
                    <HapticButton
                        key={action.label}
                        onClick={() => {
                            menuRef.current?.hidePopover();
                            action.onClick();
                        }}
                    >
                        {action.label}
                    </HapticButton>
                ))}
            </div>
        </span>
    );
}
