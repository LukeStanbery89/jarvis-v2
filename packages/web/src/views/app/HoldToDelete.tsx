/**
 * A press-and-hold delete button (#157).
 *
 * The chat sidebar's trash icon used to delete a conversation on a single tap.
 * This control makes the destructive action deliberate: the pointer (or Space/
 * Enter) must stay down for {@link HOLD_TO_DELETE_MS} while a red ring fills
 * clockwise around the icon, and the conversation is removed only when the ring
 * closes. Letting go at any point before that cancels the hold and resets the
 * ring, so a stray click or a scroll that starts on the button deletes nothing.
 *
 * The timing lives in {@link scheduleHold} rather than in a CSS animation alone,
 * so the timer that fires `onDelete` and the ring the user sees cannot disagree.
 * That helper is exported for the package's node-only suite; the component's
 * pointer and keyboard handlers are the thin shell around it.
 */
import { useEffect, useRef, useState } from "react";
import type {
    CSSProperties,
    KeyboardEvent as ReactKeyboardEvent,
    PointerEvent as ReactPointerEvent,
} from "react";
import { Trash2 } from "lucide-react";

/** How long the delete button must be held, in milliseconds. */
export const HOLD_TO_DELETE_MS = 3000;

/** A live hold that a caller can abandon before it completes. */
export interface HoldHandle {
    /** Stops the hold; `onComplete` will not run. */
    cancel(): void;
}

/**
 * Schedules a hold's completion, cancellably.
 *
 * Kept free of React and the DOM so the rule the gesture exists for — release
 * early and nothing happens, hold to the end and it fires exactly once — is
 * testable under fake timers in the node-only suite.
 *
 * @param durationMs - How long the hold must last.
 * @param onComplete - Called once, after the full duration.
 * @returns A handle whose `cancel()` abandons the hold.
 */
export function scheduleHold(
    durationMs: number,
    onComplete: () => void,
): HoldHandle {
    let cancelled = false;
    const timer = setTimeout(() => {
        if (cancelled) {
            return;
        }
        cancelled = true;
        onComplete();
    }, durationMs);
    return {
        cancel(): void {
            if (cancelled) {
                return;
            }
            cancelled = true;
            clearTimeout(timer);
        },
    };
}

/** Props for {@link HoldToDelete}. */
export interface HoldToDeleteProps {
    /** The thing being deleted, used in the button's accessible name. */
    label: string;
    /** Runs once the hold completes. */
    onDelete(): void;
    /** How long the button must be held; defaults to {@link HOLD_TO_DELETE_MS}. */
    durationMs?: number;
    /** Extra class names for the button (the caller's own placement). */
    className?: string;
}

/**
 * The hold-to-delete control.
 *
 * A pointer hold captures the pointer, so a finger that drifts off the button
 * still delivers `pointerup`; without capture the timer could outlive the press
 * and delete after the user let go somewhere else. Every end path — pointer up,
 * leave, cancel, lost capture, key up, blur, unmount — funnels into one cancel.
 *
 * @param props - See {@link HoldToDeleteProps}.
 */
export function HoldToDelete({
    label,
    onDelete,
    durationMs = HOLD_TO_DELETE_MS,
    className,
}: HoldToDeleteProps) {
    const [holding, setHolding] = useState(false);
    const holdRef = useRef<HoldHandle | null>(null);

    // A row can be removed (or the drawer closed) mid-hold; a timer that
    // survived the unmount would delete a conversation the user can no longer
    // see.
    useEffect(() => {
        return () => {
            holdRef.current?.cancel();
            holdRef.current = null;
        };
    }, []);

    /** Starts the hold, unless one is already running. */
    function begin(): void {
        if (holdRef.current !== null) {
            return;
        }
        setHolding(true);
        holdRef.current = scheduleHold(durationMs, () => {
            holdRef.current = null;
            setHolding(false);
            onDelete();
        });
    }

    /** Abandons a live hold and snaps the ring back to empty. */
    function cancel(): void {
        holdRef.current?.cancel();
        holdRef.current = null;
        setHolding(false);
    }

    /** A left press starts the hold and captures the pointer. */
    function handlePointerDown(
        event: ReactPointerEvent<HTMLButtonElement>,
    ): void {
        if (event.button !== 0) {
            return;
        }
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // Capture is a convenience; the end handlers still cancel the hold.
        }
        begin();
    }

    /** A key press starts the hold; repeat events must not stack timers. */
    function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
        if (event.key !== " " && event.key !== "Enter") {
            return;
        }
        if (event.repeat) {
            return;
        }
        // Space would scroll the page, and the native click would otherwise
        // fire on release; the gesture is the hold, not the click.
        event.preventDefault();
        begin();
    }

    /** A key release cancels the hold, exactly as a pointer release does. */
    function handleKeyUp(event: ReactKeyboardEvent<HTMLButtonElement>): void {
        if (event.key !== " " && event.key !== "Enter") {
            return;
        }
        event.preventDefault();
        cancel();
    }

    const classes = [
        "icon-btn",
        "hold-to-delete",
        className,
        holding ? "holding" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <button
            type="button"
            className={classes}
            style={
                {
                    "--hold-duration": `${durationMs}ms`,
                } as CSSProperties
            }
            aria-label={`Hold to delete ${label}`}
            title={`Press and hold to delete ${label}`}
            data-hold-ms={durationMs}
            data-holding={holding ? "true" : "false"}
            onPointerDown={handlePointerDown}
            onPointerUp={cancel}
            onPointerLeave={cancel}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onBlur={cancel}
            onContextMenu={(event) => event.preventDefault()}
        >
            <span className="hold-to-delete-ring" aria-hidden="true">
                <svg viewBox="0 0 40 40" focusable="false">
                    <circle
                        className="hold-to-delete-track"
                        cx="20"
                        cy="20"
                        r="17"
                        pathLength={100}
                    />
                    <circle
                        className="hold-to-delete-fill"
                        cx="20"
                        cy="20"
                        r="17"
                        pathLength={100}
                    />
                </svg>
            </span>
            <Trash2 size={16} aria-hidden="true" />
        </button>
    );
}
