/**
 * The snooze control (#90 phase 6c): one button, three offsets.
 *
 * Shared by everything that can defer a reminder — the floating toast, the
 * notifications page's rows, the reminder list — because a snooze offered in three
 * places has to be the same three choices in the same order, and the labels are
 * the interface (the server takes minutes; `SNOOZE_PRESETS` is what they mean).
 *
 * Collapsed until asked: three buttons is one more decision than a corner card
 * should be showing at rest, and the row underneath already has two.
 *
 * `onSnooze` is synchronous by design — the caller owns the request and its
 * outcome, and `useJobs` reports failure as a value rather than a rejection, so
 * there is nothing here to catch.
 */
import { useState } from "react";
import { SNOOZE_PRESETS } from "../../jobs";

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
    const [open, setOpen] = useState(false);
    return (
        <span className="snooze">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((wasOpen) => !wasOpen)}
            >
                Snooze
            </button>
            {open && (
                <span
                    className="snooze-options"
                    role="group"
                    aria-label="Snooze for"
                >
                    {SNOOZE_PRESETS.map((preset) => (
                        <button
                            key={preset.minutes}
                            type="button"
                            onClick={() => {
                                setOpen(false);
                                onSnooze(preset.minutes);
                            }}
                        >
                            {preset.label}
                        </button>
                    ))}
                </span>
            )}
        </span>
    );
}
