/**
 * Menu-based actions for rows (#156) - controls cost nothing until invoked.
 */
import { useState } from "react";

export interface RowAction {
    label: string;
    onClick: () => void;
    primary?: boolean;
}

export interface RowActionsProps {
    actions: RowAction[];
    className?: string;
}

export function RowActions({ actions, className = "" }: RowActionsProps) {
    const [open, setOpen] = useState(false);
    if (actions.length === 0) {
        return null;
    }
    // If only primary action and no menu needed? Issue says "single ⋯ or ✎ + ⋯",
    // but be flexible - show primary inline if present and small set
    const primary = actions.find((a) => a.primary);
    const others = actions.filter((a) => !a.primary);

    return (
        <div className={`row-actions ${className}`.trim()}>
            {primary && (
                <button
                    type="button"
                    className="row-action-primary"
                    onClick={primary.onClick}
                >
                    {primary.label}
                </button>
            )}
            {others.length > 0 && (
                <div className="row-actions-menu">
                    <button
                        type="button"
                        className="row-actions-trigger"
                        aria-haspopup="menu"
                        aria-expanded={open}
                        onClick={() => setOpen((o) => !o)}
                    >
                        ⋯
                    </button>
                    {open && (
                        <div className="row-actions-dropdown" role="menu">
                            {others.map((action, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        action.onClick();
                                        setOpen(false);
                                    }}
                                >
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
