/**
 * A row's actions, folded into one `⋯` menu (#156).
 *
 * The presentation module's point is that a row's primary fact gets the room;
 * a bar of Edit / Snooze / Cancel buttons is what took it. So the list pages
 * show a single trigger and the actions live behind it — the controls are
 * effectively zero-width until they are asked for.
 *
 * It is a native `<details>` rather than a popover or a JS menu: the browser
 * hides a closed `<details>` for free (no state, no outside-click handling, no
 * positioning), and — the reason it matters to the tests — the buttons are
 * still in the static markup, so a node-only render can assert them without
 * opening anything. `SnoozeMenu` stays a popover because its presets must
 * escape the toast's scrolling column; a row's actions are never inside that
 * column, so the simpler element is enough.
 */
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
    if (actions.length === 0) {
        return null;
    }
    return (
        <details className={`row-actions ${className}`.trim()}>
            <summary aria-label="Actions">⋯</summary>
            <div className="row-actions-menu" role="group">
                {actions.map((action) => (
                    <button
                        key={action.label}
                        type="button"
                        onClick={action.onClick}
                    >
                        {action.label}
                    </button>
                ))}
            </div>
        </details>
    );
}
