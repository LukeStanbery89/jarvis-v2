/**
 * The timer ring (#90 phase 4): the one notification that is an interruption in
 * the physical sense.
 *
 * A `timer` is the class the user chose for a moment they chose, so it does not
 * queue politely behind a banner — it takes the screen, and the only way out is
 * **Stop**. Deliberately a modal `<dialog>` rather than a fixed `<div>`: a modal
 * dialog lives in the browser's top layer, so the ring covers the settings
 * dialog (and anything else that opens later) without either component knowing
 * about the other's stacking. That is the "wherever the user is" promise made
 * structural instead of a z-index race.
 *
 * Two smaller decisions:
 *
 * - **Escape is a Stop**, not a dismissal of the overlay: the timer stays owed
 *   until it is acknowledged, so there is no way to make the overlay vanish
 *   while leaving it unacknowledged.
 * - **The tab title carries it too** (`⏰ kettle`), which is the cheapest way to
 *   make a ringing timer visible to someone looking at their tab strip before
 *   they look at the page.
 *
 * The "how late" line ticks while the overlay is up: a timer left ringing
 * overnight must not keep claiming it is still "due 1 minute ago".
 */
import { useEffect, useRef, useState } from "react";
import { describeDue } from "../../notifications";
import type { ClientNotification } from "../../notifications";

/** Props for {@link TimerRing}. */
export interface TimerRingProps {
    /** The fired timer the user has to acknowledge. */
    timer: ClientNotification;
    /** Acknowledges it: dismisses the notification and silences the ring. */
    onStop(id: string): void;
}

/** How often the "how late it is" line refreshes, in milliseconds. */
const CLOCK_TICK_MS = 30_000;

/**
 * Renders the modal ring overlay for one fired timer.
 *
 * Mount it only while there is a timer to ring; the effect opens the modal on
 * mount and closes it on unmount, so the overlay's presence *is* the selection
 * from `selectAlerts` (one source of truth for which timer is ringing).
 */
export function TimerRing({ timer, onStop }: TimerRingProps) {
    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const stopRef = useRef<HTMLButtonElement | null>(null);
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog !== null && !dialog.open) {
            dialog.showModal();
        }
        // The only action is acknowledgement, so it is already focused: one
        // keystroke (Enter/Space, or Escape) ends it.
        stopRef.current?.focus();
        return () => {
            if (dialog?.open === true) {
                dialog.close();
            }
        };
    }, [timer.id]);

    useEffect(() => {
        const interval = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const previous = document.title;
        document.title = `⏰ ${timer.title}`;
        return () => {
            document.title = previous;
        };
    }, [timer.title]);

    const due = describeDue(timer, now);
    const dueLine = due.charAt(0).toUpperCase() + due.slice(1);

    return (
        <dialog
            ref={dialogRef}
            className="timer-ring"
            role="alertdialog"
            aria-labelledby="timer-ring-title"
            onCancel={(event) => {
                // Escape: prevent the browser's default close, because the
                // timer is acknowledged (Stop), not hidden.
                event.preventDefault();
                onStop(timer.id);
            }}
        >
            <p className="timer-ring-eyebrow">Timer</p>
            <h2 id="timer-ring-title" className="timer-ring-title">
                {timer.title}
            </h2>
            {timer.body !== undefined && (
                <p className="timer-ring-body">{timer.body}</p>
            )}
            <p className="timer-ring-when">{dueLine}</p>
            <button
                ref={stopRef}
                type="button"
                className="timer-ring-stop"
                onClick={() => onStop(timer.id)}
            >
                Stop
            </button>
        </dialog>
    );
}
