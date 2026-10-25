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
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";

/** How long the delete button must be held, in milliseconds. */
export const HOLD_TO_DELETE_MS = 3000;

/**
 * How much larger the phone ring is than the button it belongs to.
 *
 * A 44 px button is exactly thumb-sized, so the ring has to grow past the
 * finger to stay visible. The overlay is also a little larger than the first
 * two-times attempt, with a heavier stroke (see `.hold-to-delete-overlay`).
 */
const PHONE_RING_SCALE = 2.5;

/** Where the phone's portal ring is centred, in viewport pixels. */
interface RingAt {
    left: number;
    top: number;
    size: number;
}

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
    /**
     * The portalled phone ring's centre, or `null` on desktop (where the ring
     * stays inside the button). Keeping it in the body's stacking context is
     * what lets it draw above the sidebar instead of being clipped by that
     * pane's scroll box.
     */
    const [ringAt, setRingAt] = useState<RingAt | null>(null);
    /** Whether the portalled ring is playing its shrink-back animation. */
    const [ringLeaving, setRingLeaving] = useState(false);
    const holdRef = useRef<HoldHandle | null>(null);
    /** The short exit timer, so a quick re-press can cancel the shrink. */
    const exitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // A row can be removed (or the drawer closed) mid-hold; a timer that
    // survived the unmount would delete a conversation the user can no longer
    // see.
    useEffect(() => {
        return () => {
            holdRef.current?.cancel();
            holdRef.current = null;
            if (exitRef.current !== null) {
                clearTimeout(exitRef.current);
                exitRef.current = null;
            }
        };
    }, []);

    /** Stops a pending shrink-back, if there is one. */
    function stopExit(): void {
        if (exitRef.current !== null) {
            clearTimeout(exitRef.current);
            exitRef.current = null;
        }
    }

    /** Starts the hold, unless one is already running. */
    function begin(target: HTMLButtonElement): void {
        if (holdRef.current !== null) {
            return;
        }
        stopExit();
        setRingLeaving(false);
        setHolding(true);
        const phone =
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(max-width: 48rem)").matches;
        if (phone) {
            const rect = target.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height) * PHONE_RING_SCALE;
            setRingAt({
                left: rect.left + rect.width / 2,
                top: rect.top + rect.height / 2,
                size,
            });
        } else {
            setRingAt(null);
        }
        holdRef.current = scheduleHold(durationMs, () => {
            holdRef.current = null;
            stopExit();
            setHolding(false);
            setRingAt(null);
            setRingLeaving(false);
            onDelete();
        });
    }

    /**
     * Abandons a live hold.
     *
     * The phone's portal ring shrinks back into the button instead of vanishing
     * on the next frame; the row stays mounted, so the short exit animation can
     * finish without holding up the pointer gesture.
     */
    function cancel(): void {
        holdRef.current?.cancel();
        holdRef.current = null;
        setHolding(false);
        if (ringAt !== null) {
            stopExit();
            setRingLeaving(true);
            exitRef.current = setTimeout(() => {
                exitRef.current = null;
                setRingAt(null);
                setRingLeaving(false);
            }, 160);
        } else {
            setRingLeaving(false);
        }
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
        begin(event.currentTarget);
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
        begin(event.currentTarget);
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
        <>
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
                data-ring={ringAt !== null ? "true" : "false"}
                onPointerDown={handlePointerDown}
                onPointerUp={cancel}
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
            {/*
             * The phone ring is portalled to `document.body`: the sidebar is a
             * scroll container (`overflow-y: auto`), so a ring drawn inside the
             * button is clipped by the chat list's pane exactly where the user
             * needs to see it. At the body's level it can paint over the pane
             * and every other page control.
             */}
            {ringAt !== null &&
                createPortal(
                    <span
                        className={
                            ringLeaving
                                ? "hold-to-delete-overlay leaving"
                                : "hold-to-delete-overlay"
                        }
                        aria-hidden="true"
                        style={
                            {
                                left: ringAt.left,
                                top: ringAt.top,
                                width: ringAt.size,
                                height: ringAt.size,
                                "--hold-duration": `${durationMs}ms`,
                            } as CSSProperties
                        }
                    >
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
                    </span>,
                    document.body,
                )}
        </>
    );
}
