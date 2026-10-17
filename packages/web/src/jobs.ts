/**
 * The client's reading of the jobs list (#90 phase 6b), pure and testable.
 *
 * `GET /api/jobs` answers with the work still owed — settled jobs are history
 * and have to be asked for — so the dashboard's list is a filter, a sort and a
 * bound. The rest is the one thing a payload cannot carry: when a job's moment
 * is, in the words a person would use ("in 4 minutes" while it is a countdown,
 * the clock time beyond that, the day named only when it is not today).
 */
import type { Job } from "./api";
import { clockText, describeSpan, weekdayText } from "./clock";

/** A moment that is close enough to be counted down rather than clocked. */
const COUNTDOWN_MS = 60 * 60_000;

/**
 * The jobs a dashboard should show, soonest first.
 *
 * `pending` and `running` only: the list is what is owed, and a settled job is
 * something that already happened (the notification list is where that is read).
 * An unreadable `runAt` sorts last rather than throwing — a broken row should
 * not take the list down with it.
 *
 * @param jobs - The server's list, in any order.
 * @param limit - How many to keep.
 * @returns Up to `limit` jobs, by `runAt` ascending.
 */
export function upcomingJobs(jobs: Job[], limit: number): Job[] {
    return jobs
        .filter((job) => job.state === "pending" || job.state === "running")
        .sort((left, right) => {
            const leftAt = Date.parse(left.runAt);
            const rightAt = Date.parse(right.runAt);
            if (Number.isNaN(leftAt)) {
                return Number.isNaN(rightAt) ? 0 : 1;
            }
            if (Number.isNaN(rightAt)) {
                return -1;
            }
            return leftAt - rightAt;
        })
        .slice(0, limit);
}

/**
 * When a job's moment is, in words.
 *
 * Deliberately coarse, in the order a person cares: inside the hour it is a
 * countdown ("in 4 minutes"), because that is how someone waits for a timer;
 * beyond it the clock time is what matters, with the day named only when "at
 * 8:00 AM" would be ambiguous. A moment that has passed — a `pending` row the
 * scheduler has not reached, or a clock that drifted — reads "due now" rather
 * than a negative countdown.
 *
 * @param runAt - The job's `runAt` (an ISO instant).
 * @param now - The clock to compare against (injected, for tests).
 * @returns The moment in words.
 */
export function describeRunAt(runAt: string, now: Date): string {
    const at = new Date(runAt);
    if (Number.isNaN(at.getTime())) {
        return "at an unknown time";
    }
    const aheadMs = at.getTime() - now.getTime();
    if (aheadMs < 60_000) {
        return "due now";
    }
    if (aheadMs < COUNTDOWN_MS) {
        return `in ${describeSpan(aheadMs)}`;
    }
    const clock = clockText(at);
    if (isSameDay(at, now)) {
        return `at ${clock}`;
    }
    if (isSameDay(at, addDays(now, 1))) {
        return `tomorrow at ${clock}`;
    }
    return `${weekdayText(at)} at ${clock}`;
}

/**
 * Whether two instants fall on the same calendar day, locally.
 *
 * Built from the local calendar rather than a millisecond window, so "today"
 * survives a DST shift and means the day the user is living in.
 */
function isSameDay(left: Date, right: Date): boolean {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
}

/** The local calendar day `days` after `from` (midday-free: the date parts). */
function addDays(from: Date, days: number): Date {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
}
