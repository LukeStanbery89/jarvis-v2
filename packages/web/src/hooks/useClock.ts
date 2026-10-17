/**
 * The current time, re-read on a cadence (#90 phase 6b).
 *
 * A leaf-only concern, deliberately: the dashboard's clock, a jobs page's "in 4
 * minutes", and a snoozed row's "until 7:00 PM" all want the time to move, and a
 * 1 Hz state change in the shell would re-render the whole app every second.
 * Whoever renders the time owns the tick.
 */
import { useEffect, useState } from "react";

/** How often the clock re-reads by default, in milliseconds. */
export const CLOCK_TICK_MS = 1000;

/**
 * Follows the wall clock.
 *
 * @param intervalMs - How often to re-read it (defaults to {@link CLOCK_TICK_MS}).
 * @returns The current time, refreshed on the interval.
 */
export function useClock(intervalMs: number = CLOCK_TICK_MS): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}
