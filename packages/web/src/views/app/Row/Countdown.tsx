/**
 * Live countdown for timers (#156). Ticks at 1 Hz via {@link useClock} and
 * renders the remaining span as `hh:mm:ss` — the same clock face `presentJob`
 * computes for the timer's primary fact, so the static render and the ticking
 * one can never disagree about the shape of the number.
 */
import { useClock } from "../../../hooks/useClock";
import { formatCountdown } from "../../../jobs";

/** Props for {@link Countdown}. */
export interface CountdownProps {
    /** The job's `runAt` (an ISO instant). */
    runAt: string;
    /** The job's state; a running timer has no remaining time. */
    state?: string;
    /** Extra classes for the element. */
    className?: string;
}

/**
 * The remaining time, re-read every second.
 *
 * @param props - See {@link CountdownProps}.
 */
export function Countdown({ runAt, state, className = "" }: CountdownProps) {
    const now = useClock(1000);
    if (state === "running") {
        return (
            <span className={`countdown ${className}`.trim()}>running now</span>
        );
    }
    const text = formatCountdown(runAt, now);
    return <span className={`countdown ${className}`.trim()}>{text}</span>;
}
