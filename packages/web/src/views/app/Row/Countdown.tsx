/**
 * Live countdown for timers (#156). Ticks at 1s via useClock; shows seconds
 * when under an hour.
 */
import { useClock } from "../../../hooks/useClock";
import { describeRunAt } from "../../../jobs";

export interface CountdownProps {
    runAt: string;
    state?: string;
    className?: string;
}

export function Countdown({ runAt, state, className = "" }: CountdownProps) {
    const now = useClock(1000);
    if (state === "running") {
        return (
            <span className={`countdown ${className}`.trim()}>running now</span>
        );
    }
    const text = describeRunAt(runAt, now);
    return <span className={`countdown ${className}`.trim()}>{text}</span>;
}
