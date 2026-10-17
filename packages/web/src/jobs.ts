/**
 * The client's reading of the jobs list (#90 phases 6b–6c), pure and testable.
 *
 * `GET /api/jobs` answers with the work still owed — settled jobs are history
 * and have to be asked for — so a page's list is a filter, a sort and a bound.
 * The rest is the one thing a payload cannot carry: when a job's moment is, in
 * the words a person would use ("in 4 minutes" while it is a countdown, the clock
 * time beyond that, the day named only when it is not today), and what a snoozed
 * row is waiting for.
 */
import type { Job } from "./api";
import { clockText, describeSpan, weekdayText } from "./clock";

/** A job's delivery class, as the API names it. */
export type JobClass = Job["class"];

/** A moment that is close enough to be counted down rather than clocked. */
const COUNTDOWN_MS = 60 * 60_000;

/**
 * The offsets a snooze offers, in the order a person reaches for them (#90).
 *
 * Three fixed presets rather than a time picker, because a snooze is a "not now"
 * and the words are the interface: the server takes minutes, and these are the
 * values behind the labels. Matches the classification table the plan settled
 * (`+60m`, `+24h`, `+7d`).
 */
export const SNOOZE_PRESETS: { label: string; minutes: number }[] = [
    { label: "in an hour", minutes: 60 },
    { label: "tomorrow", minutes: 24 * 60 },
    { label: "next week", minutes: 7 * 24 * 60 },
];

/**
 * The jobs a page should show, soonest first.
 *
 * `pending` and `running` only: the list is what is owed, and a settled job is
 * something that already happened (the notification list is where that is read).
 * `jobClass` filters (the Timers and Reminders pages) **before** the bound is
 * applied — bounding first would hand a page four timers because a reminder
 * filled the cut.
 *
 * An unreadable `runAt` sorts last rather than throwing: a broken row should not
 * take the list down with it.
 *
 * @param jobs - The server's list, in any order.
 * @param options.limit - How many to keep.
 * @param options.jobClass - One delivery class, or every class.
 * @returns Up to `limit` jobs, by `runAt` ascending.
 */
export function upcomingJobs(
    jobs: Job[],
    options: { limit: number; jobClass?: JobClass },
): Job[] {
    return jobs
        .filter(
            (job) =>
                (job.state === "pending" || job.state === "running") &&
                (options.jobClass === undefined ||
                    job.class === options.jobClass),
        )
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
        .slice(0, options.limit);
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
    return describeMoment(runAt, now);
}

/**
 * A moment's parts, for a sentence to assemble (#90 phase 6c).
 *
 * Split for the same reason `clockParts` is: "snoozed until at 7:00 PM" is what
 * happens when a caller prefixes a preposition to a string that already carries
 * one. The day is `null` when the clock time alone is unambiguous.
 */
export interface MomentParts {
    /** `tomorrow` / `Tuesday`, or `null` when the moment is today. */
    day: string | null;
    /** The clock time (`8:00 AM`), or the phrase that stands in for one. */
    clock: string;
}

/**
 * Splits a moment into the day and the clock time.
 *
 * @param runAt - The job's `runAt` (an ISO instant).
 * @param now - The clock to compare against (injected, for tests).
 * @returns The day (or `null`) and the clock time.
 */
export function momentParts(runAt: string, now: Date): MomentParts {
    const at = new Date(runAt);
    if (Number.isNaN(at.getTime())) {
        return { day: null, clock: "an unknown time" };
    }
    const clock = clockText(at);
    if (isSameDay(at, now)) {
        return { day: null, clock };
    }
    if (isSameDay(at, addDays(now, 1))) {
        return { day: "tomorrow", clock };
    }
    return { day: weekdayText(at), clock };
}

/**
 * A moment named rather than counted down: `at 8:00 AM`, `tomorrow at 8:00 AM`,
 * `Tuesday at 8:00 AM`.
 *
 * Split from {@link describeRunAt} for the sentences that cannot take a countdown
 * — "snoozed until in 45 minutes" is not English — and because a named moment is
 * what someone checking *when* something will happen actually wants.
 *
 * @param runAt - The job's `runAt` (an ISO instant).
 * @param now - The clock to compare against (injected, for tests).
 * @returns The moment as a clock time, with the day when it is not today.
 */
export function describeMoment(runAt: string, now: Date): string {
    const { day, clock } = momentParts(runAt, now);
    return day === null ? `at ${clock}` : `${day} at ${clock}`;
}

/**
 * The moment a snoozed notification is waiting for, or `null` when nothing can
 * be said (#90 phase 6c).
 *
 * The notification records *that* it was snoozed; the job holds *when*. Joining
 * them is the reason the link exists at all, and this is honest about the ways it
 * fails: the job was pruned (`job_id` is nulled by the FK), the link was absent to
 * begin with, or the job is no longer pending — its successor was cancelled, or it
 * has already run. In every one of those cases the row still says "snoozed"; it
 * just cannot say until when.
 *
 * @param jobId - The notification's `jobId`, if it had one.
 * @param jobs - The caller's jobs, as last read.
 * @returns The job's `runAt`, or `null` when there is nothing to name.
 */
export function snoozeUntil(
    jobId: string | undefined,
    jobs: Job[],
): string | null {
    if (jobId === undefined) {
        return null;
    }
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (job === undefined || job.state !== "pending") {
        return null;
    }
    return job.runAt;
}

/**
 * `snoozed until 7:00 PM`, or plain `snoozed` when the moment is unknown.
 *
 * @param until - {@link snoozeUntil}'s answer.
 * @param now - The clock to compare against (injected, for tests).
 * @returns The row's state in one sentence.
 */
export function describeSnooze(until: string | null, now: Date): string {
    if (until === null) {
        return "snoozed";
    }
    const { day, clock } = momentParts(until, now);
    return day === null
        ? `snoozed until ${clock}`
        : `snoozed until ${day} at ${clock}`;
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
