/**
 * The timer ring (#90 phase 4): the one notification that is an interruption in
 * the physical sense.
 */
import { useEffect, useRef, useState } from "react";
import { describeDue } from "../../notifications";
import type { ClientNotification } from "../../notifications";
import { presentNotification } from "../../presentation";
import { HapticButton } from "./HapticButton";
import { ClassChip } from "./Row/ClassChip";

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
 */
export function TimerRing({ timer, onStop }: TimerRingProps) {
    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const stopRef = useRef<HTMLButtonElement | null>(null);
    const [now, setNow] = useState(() => new Date());
    const presented = presentNotification(timer, now);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog !== null && !dialog.open) {
            dialog.showModal();
        }
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
                event.preventDefault();
                onStop(timer.id);
            }}
        >
            <ClassChip kind={presented.kind} />
            <h2 id="timer-ring-title" className="timer-ring-title">
                {presented.primary}
            </h2>
            {timer.body !== undefined && (
                <p className="timer-ring-body">{timer.body}</p>
            )}
            <p className="timer-ring-when">{dueLine}</p>
            <HapticButton
                ref={stopRef}
                className="timer-ring-stop"
                onClick={() => onStop(timer.id)}
            >
                Stop
            </HapticButton>
        </dialog>
    );
}
