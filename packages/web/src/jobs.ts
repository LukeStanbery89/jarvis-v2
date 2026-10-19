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
import type { Job, JobRun, JobUpdateRequest, QuietForecast } from "./api";
import {
    describeRepeat,
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
    nextOccurrence,
    parseJobRepeat,
} from "@lukestanbery/jarvis-protocol";
import type { JobRepeat, Weekday } from "@lukestanbery/jarvis-protocol";
import { clockText, describeSpan, weekdayText } from "./clock";
import { describeBody } from "./notifications";

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
 * (`+60m`, `+24h`, `+7d`) — and the server's own bound is a week, so no preset
 * here can produce a refusal.
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
 * A job's detail, or `null` when it only repeats the label (#90 phase 7).
 *
 * The rows on the Timers and Reminders pages rendered `message` verbatim, which
 * nobody noticed because they held no page-created jobs: the create route
 * defaults a missing detail to the label, so the first timer made by hand would
 * have read "Kettle Kettle". This is the *same* rule the notification rows got
 * in phase 6c — `describeBody` already takes a structural `{ title, body }`, so
 * the two cannot drift into two opinions about what "saying it twice" means.
 *
 * @param job - The job (or the part of it a caller holds).
 * @returns The detail to render, or `null` when the label says it all.
 */
export function jobBody(job: Pick<Job, "label" | "message">): string | null {
    return describeBody({ title: job.label, body: job.message });
}

/**
 * A jobs read, split into the two lists a page renders (#90 phase 7).
 *
 * The server's list is one list with an `includeSettled` switch, because a
 * settled-only read is not expressible through its `created_at DESC` page: ask
 * for settled rows and the newest-created rows come back, which are usually the
 * pending ones. Retention bounds the whole table instead (~50 rows per user,
 * pending or settled), so one read carries everything and the split is the
 * client's — here, purely, rather than inside the polling hook.
 */
export interface JobLists {
    /** The work still owed: `pending` and `running`. */
    owed: Job[];
    /** Everything else: `done`, `failed`, `cancelled`, `missed`. */
    settled: Job[];
}

/**
 * Partitions a jobs read into what is owed and what is history.
 *
 * Order is the server's (`createdAt` descending) and is left alone: the owed
 * list is sorted for display by {@link upcomingJobs} anyway, and a history list
 * wants its own order (when it settled, not when it was made), which
 * `recentJobs` applies at the page that shows it.
 *
 * @param jobs - The server's list, in any order.
 * @returns The two halves, each in the order it arrived.
 */
export function splitJobs(jobs: Job[]): JobLists {
    const owed: Job[] = [];
    const settled: Job[] = [];
    for (const job of jobs) {
        if (job.state === "pending" || job.state === "running") {
            owed.push(job);
        } else {
            settled.push(job);
        }
    }
    return { owed, settled };
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
 * How long one attempt took, in the unit its size deserves (#90 phase 7d).
 *
 * `describeSpan` floors to whole minutes, which is right for a list of moments
 * ("3 minutes ago") and wrong for a run: a tool job is done in milliseconds and
 * a prompt job in seconds, and "0 minutes" is the answer neither of them
 * deserves. So an attempt measures itself — milliseconds, then seconds, then the
 * same span every other surface reads.
 *
 * `null` when there is nothing to measure: an attempt still in flight (no
 * `finishedAt`), or timestamps that do not parse. The caller then simply says
 * nothing about duration rather than inventing one.
 *
 * @param run - The attempt, as `GET /api/jobs/{id}` reports it.
 * @returns The duration in words, or `null` when it cannot be known.
 */
export function runDuration(run: JobRun): string | null {
    if (run.finishedAt === undefined) {
        return null;
    }
    const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (!Number.isFinite(ms) || ms < 0) {
        return null;
    }
    if (ms < 1000) {
        return `${ms} ms`;
    }
    if (ms < 60_000) {
        const seconds = Math.round(ms / 1000);
        return `${seconds} second${seconds === 1 ? "" : "s"}`;
    }
    return describeSpan(ms);
}

/**
 * A page's history: the settled rows of one class, most recently settled first.
 *
 * "Recently settled" is its own order — a history list is about *when it ended*,
 * not when it was made — so this sorts on `settledAt` (the moment the ledger
 * stamped) and falls back to `createdAt` for a row that has none. `cancelled`
 * rows are included on purpose: a cancelled job leaves no notification record
 * anywhere else, so this list is the only place a row that quietly vanished can
 * be explained. A row still owed is excluded even if a caller hands it one: a
 * history that showed pending work would be a second, worse list of the same
 * thing.
 *
 * @param jobs - The server's jobs, or the settled half of them.
 * @param options.limit - How many to keep.
 * @param options.jobClass - The page's class.
 * @returns Up to `limit` settled jobs, most recently settled first.
 */
export function recentJobs(
    jobs: Job[],
    options: { limit: number; jobClass: JobClass },
): Job[] {
    return jobs
        .filter(
            (job) =>
                job.class === options.jobClass &&
                job.state !== "pending" &&
                job.state !== "running",
        )
        .sort((left, right) => settledAtOf(right) - settledAtOf(left))
        .slice(0, options.limit);
}

/** A settled job's moment, or the epoch when it has no readable one (sorts last). */
function settledAtOf(job: Job): number {
    const settled =
        job.settledAt === undefined ? NaN : Date.parse(job.settledAt);
    if (!Number.isNaN(settled)) {
        return settled;
    }
    const created = Date.parse(job.createdAt);
    return Number.isNaN(created) ? 0 : created;
}

/**
 * What the server's quiet-hours forecast means for a job just saved, or `null`
 * when it means nothing (#90 phase 7).
 *
 * The create and edit responses carry the forecast precisely so a page can say
 * it before the user walks away: a reminder set for 23:00 will be deferred to the
 * window's end, and a timer with notifications off will not ring. The server
 * remains the authority — this only renders the answer it sent.
 *
 * @param quiet - The forecast from the save response.
 * @param jobClass - The class, because "won't ring" and "won't be pushed" are
 *   different disappointments.
 * @returns The sentence to show, or `null` for a clear forecast.
 */
export function describeQuiet(
    quiet: QuietForecast,
    jobClass: JobClass,
): string | null {
    if (quiet.state === "disabled") {
        return jobClass === "timer"
            ? "notifications are off, so this timer will not ring."
            : "notifications are off, so this will be recorded but not pushed.";
    }
    if (quiet.state === "held" && quiet.until !== undefined) {
        const until = new Date(quiet.until);
        if (Number.isNaN(until.getTime())) {
            return null;
        }
        const window =
            quiet.window === undefined ? "" : ` (quiet hours ${quiet.window})`;
        // A timer's forecast is never `held` (the window does not hold one), so
        // this sentence is only ever about a reminder or a note.
        return `it falls inside quiet hours${window}, so it will wait until ${clockText(until)}.`;
    }
    return null;
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

/* --- Writing a job by hand (#90 phase 7) ------------------------------------
 *
 * A form has to turn what a person chose into what the server accepts: a
 * duration into an instant, a `<input type="datetime-local">` value into local
 * wall-clock time, and a draft into the first thing that is wrong with it. All
 * three are here, pure, because this package's test suite runs in node and never
 * renders a component — a decision that lives only in a `.tsx` is a decision
 * nobody asserts.
 *
 * The client's bounds are **courtesies**: they mirror `scheduler/create.ts` so
 * the form can say what is wrong before a round trip, and the server stays the
 * authority on every one of them.
 */

/**
 * The longest countdown the server will store, in minutes (#90 phase 5).
 *
 * Mirrors `MAX_DURATION_MINUTES` in `scheduler/create.ts`: beyond a day, a
 * countdown is a reminder. Duplicated on purpose — the scheduler's policy is not
 * something the wire protocol carries, and a form that let you type 25 hours
 * only to be refused has taught the user nothing.
 */
export const MAX_TIMER_MINUTES = 1440;

/** How far ahead a job may be set, in days (mirrors `JARVIS_JOB_MAX_HORIZON_DAYS`). */
export const HORIZON_DAYS = 366;

/** A unit of a countdown, as the timer form offers them. */
export type DurationUnit = "seconds" | "minutes" | "hours";

/** Milliseconds in each unit the timer form offers. */
const UNIT_MS: Record<DurationUnit, number> = {
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
};

/**
 * The lengths worth one click, in the order a person reaches for them.
 *
 * In minutes because that is the unit the server's own bound is expressed in —
 * the form maps these onto its amount/unit fields, so a preset and a typed
 * duration go down one path.
 */
export const DURATION_PRESETS: { label: string; minutes: number }[] = [
    { label: "5 minutes", minutes: 5 },
    { label: "10 minutes", minutes: 10 },
    { label: "25 minutes", minutes: 25 },
    { label: "1 hour", minutes: 60 },
];

/**
 * The moment `amount` of `unit` from now, or `null` when that is not a length.
 *
 * Seconds are offered because a countdown has no floor beyond what the clock can
 * express (phase 4 learned this the hard way: the half-minute floor turned "set
 * a timer for ten seconds" into a refusal).
 *
 * @param now - The clock to count from.
 * @param duration - An amount and its unit.
 * @returns The instant, or `null` for a zero, negative or unreadable amount.
 */
export function instantFromDuration(
    now: Date,
    duration: { amount: number; unit: DurationUnit },
): Date | null {
    if (!Number.isFinite(duration.amount) || duration.amount <= 0) {
        return null;
    }
    return new Date(now.getTime() + duration.amount * UNIT_MS[duration.unit]);
}

/**
 * Tomorrow at 09:00 local — the moment a new reminder starts on.
 *
 * A default rather than an empty field: most reminders are "tomorrow morning",
 * and the chips beside the input cover the two other common shapes. Built from
 * calendar parts, so a DST day still means 09:00 rather than 08:00 or 10:00.
 *
 * @param now - Today.
 * @returns Tomorrow morning, local.
 */
export function defaultMoment(now: Date): Date {
    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        9,
        0,
        0,
        0,
    );
}

/**
 * The two moments worth one click, beside the moment input.
 *
 * Both are relative to the clock the form opened with, so a chip means what it
 * says whenever it is pressed.
 */
export const MOMENT_CHIPS: { label: string; at(now: Date): Date }[] = [
    {
        label: "in an hour",
        at: (now) => new Date(now.getTime() + 60 * 60_000),
    },
    { label: "tomorrow 9 AM", at: defaultMoment },
];

/**
 * An instant as a `datetime-local` value, in the browser's own zone.
 *
 * The control has no concept of a zone — it is a wall clock and a calendar day —
 * so this is the local reading of the instant, to the minute (the control's
 * default step). Round-tripping through {@link parseMomentInput} returns the same
 * instant to the minute, which is what lets the form tell an untouched moment
 * from an edited one.
 *
 * @param at - The instant to render.
 * @returns `YYYY-MM-DDTHH:MM`.
 */
export function momentInputValue(at: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${String(at.getFullYear()).padStart(4, "0")}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * A `datetime-local` value as the instant it names, in the browser's own zone.
 *
 * Built from the parts rather than handed to `new Date(string)`: a date-time
 * without a zone is defined as local, but implementations have disagreed about
 * the exact form, and the parts are what make "09:00 on a DST-shift day is
 * 09:00" assertable in a test.
 *
 * Rejects what the calendar would otherwise correct — 2026-02-30 would silently
 * become March 2, and a form that stored "the user asked for a day that does not
 * exist" under a different day is worse than one that says it could not read the
 * field.
 *
 * @param value - The input's value.
 * @returns The instant, or `null` when the value is not a date and time.
 */
export function parseMomentInput(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
        value.trim(),
    );
    if (match === null) {
        return null;
    }
    const [, year, month, day, hour, minute, secondText] = match;
    // The seconds group is optional and unmatched groups come back `undefined`:
    // `Number(undefined)` is NaN, and a NaN in the seconds slot makes the whole
    // Date unreadable — which the rollover guard below would report as "not a
    // date" rather than as the bug it is.
    const second = secondText === undefined ? 0 : Number(secondText);
    if (
        Number(month) < 1 ||
        Number(month) > 12 ||
        Number(day) < 1 ||
        Number(day) > 31 ||
        Number(hour) > 23 ||
        Number(minute) > 59 ||
        second > 59
    ) {
        return null;
    }
    const at = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        second,
        0,
    );
    // The rollover guard: February has no 30th, so a corrected date is a
    // misread value rather than the moment the user picked.
    if (
        at.getFullYear() !== Number(year) ||
        at.getMonth() !== Number(month) - 1 ||
        at.getDate() !== Number(day)
    ) {
        return null;
    }
    return at;
}

/**
 * The cadences the form offers as one tap (#90 phase 8e).
 *
 * Chips rather than a cron field: these are what people actually say ("every
 * day", "every weekday", "the first of the month"), and anything they cannot
 * express by tapping is expressible in chat, where the model maps the words.
 */
export const REPEAT_CHOICES = [
    { id: "never", label: "Never" },
    { id: "daily", label: "Daily" },
    { id: "weekdays", label: "Weekdays" },
    { id: "weekly", label: "Weekly" },
    { id: "monthly", label: "Monthly" },
] as const;

/** One cadence the form offers. */
export type RepeatChoice = (typeof REPEAT_CHOICES)[number]["id"];

/**
 * What a form has in hand about repetition (#90 phase 8e).
 *
 * A flat draft rather than a rule: the rule's shape depends on its frequency
 * (`weekdays` means nothing to a daily rule), and a form is a set of controls
 * that are all visible at once. {@link repeatDraftToRule} is the one place that
 * turns one into the other, and {@link repeatDraftFromRule} reads a stored rule
 * back, so opening an edit never loses a schedule it cannot render.
 */
export interface RepeatDraft {
    choice: RepeatChoice;
    /** Every N days, weeks or months — "every 3 weeks". */
    interval: number;
    /** The days a weekly repeat names, in calendar order. */
    weekdays: Weekday[];
    /** What a monthly repeat names: a day of the month, or an ordinal weekday. */
    monthly: "day" | "ordinal";
    /** The day of the month, 1..31 — or -1 for the last day. */
    monthDay: number;
    /** The ordinal weekday, spelled `2tu` / `-1fr` as the rule takes it. */
    weekOrdinal: string;
    /** When it stops: never, after N firings, or on a date (through that day). */
    ends: "never" | "after" | "until";
    after: number;
    until: Date | null;
}

/** A draft that repeats nothing — the state every new job starts in. */
export function noRepeat(): RepeatDraft {
    return {
        choice: "never",
        interval: 1,
        weekdays: ["mo"],
        monthly: "day",
        monthDay: 1,
        weekOrdinal: "1mo",
        ends: "never",
        after: 4,
        until: null,
    };
}

/** The ordinal weekdays the monthly control offers, in the order it lists them. */
export const MONTH_ORDINALS: { value: string; label: string }[] = [
    { value: "1mo", label: "first Monday" },
    { value: "1tu", label: "first Tuesday" },
    { value: "1we", label: "first Wednesday" },
    { value: "1th", label: "first Thursday" },
    { value: "1fr", label: "first Friday" },
    { value: "1sa", label: "first Saturday" },
    { value: "1su", label: "first Sunday" },
    { value: "2mo", label: "second Monday" },
    { value: "2tu", label: "second Tuesday" },
    { value: "2we", label: "second Wednesday" },
    { value: "2th", label: "second Thursday" },
    { value: "2fr", label: "second Friday" },
    { value: "2sa", label: "second Saturday" },
    { value: "2su", label: "second Sunday" },
    { value: "3mo", label: "third Monday" },
    { value: "3tu", label: "third Tuesday" },
    { value: "3we", label: "third Wednesday" },
    { value: "3th", label: "third Thursday" },
    { value: "3fr", label: "third Friday" },
    { value: "3sa", label: "third Saturday" },
    { value: "3su", label: "third Sunday" },
    { value: "4mo", label: "fourth Monday" },
    { value: "4tu", label: "fourth Tuesday" },
    { value: "4we", label: "fourth Wednesday" },
    { value: "4th", label: "fourth Thursday" },
    { value: "4fr", label: "fourth Friday" },
    { value: "4sa", label: "fourth Saturday" },
    { value: "4su", label: "fourth Sunday" },
    { value: "5mo", label: "fifth Monday" },
    { value: "5tu", label: "fifth Tuesday" },
    { value: "5we", label: "fifth Wednesday" },
    { value: "5th", label: "fifth Thursday" },
    { value: "5fr", label: "fifth Friday" },
    { value: "5sa", label: "fifth Saturday" },
    { value: "5su", label: "fifth Sunday" },
    { value: "-1mo", label: "last Monday" },
    { value: "-1tu", label: "last Tuesday" },
    { value: "-1we", label: "last Wednesday" },
    { value: "-1th", label: "last Thursday" },
    { value: "-1fr", label: "last Friday" },
    { value: "-1sa", label: "last Saturday" },
    { value: "-1su", label: "last Sunday" },
];

/** The weekday toggles the weekly control offers, in calendar order. */
export const WEEKDAY_CHIPS: { day: Weekday; label: string }[] = [
    { day: "su", label: "S" },
    { day: "mo", label: "M" },
    { day: "tu", label: "T" },
    { day: "we", label: "W" },
    { day: "th", label: "T" },
    { day: "fr", label: "F" },
    { day: "sa", label: "S" },
];

/** The same set with one day added or removed, in calendar order. */
export function toggleWeekday(days: Weekday[], day: Weekday): Weekday[] {
    const next = days.includes(day)
        ? days.filter((value) => value !== day)
        : [...days, day];
    return next.sort(
        (a, b) =>
            WEEKDAY_CHIPS.findIndex((c) => c.day === a) -
            WEEKDAY_CHIPS.findIndex((c) => c.day === b),
    );
}

/** The weekdays a "weekday" repeat means, in calendar order. */
const BUSINESS_DAYS: Weekday[] = ["mo", "tu", "we", "th", "fr"];

/**
 * The last instant of a local day, which is what an "until" date means.
 *
 * A millisecond before the next midnight rather than the midnight itself: the
 * rule keeps occurrences up to and including its `until`, and a midnight daily
 * job whose end date was the 20th should not also fire at 00:00 on the 21st.
 */
function endOfDay(date: Date): Date {
    return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        23,
        59,
        59,
        999,
    );
}

/** What an "ends" choice becomes, in the rule's own words. */
function endsFor(
    draft: RepeatDraft,
): { until: string } | { after: number } | undefined {
    if (draft.ends === "after") {
        return { after: Math.max(1, Math.floor(draft.after)) };
    }
    if (draft.ends === "until" && draft.until !== null) {
        return { until: endOfDay(draft.until).toISOString() };
    }
    return undefined;
}

/**
 * The rule a draft asks for, anchored at the moment the form has, or `null` when
 * it repeats nothing (#90 phase 8e).
 *
 * The anchor is the *first occurrence* — the moment the user picked — which is
 * what a rule's `start` means, so the server derives the same instant back and
 * the two agree by construction rather than by luck. The result is handed
 * straight to `parseJobRepeat`-validating code either side, so a bug here is a
 * refusal rather than a strange schedule.
 *
 * @param draft - What the form has.
 * @param first - The moment the form's picker holds.
 * @returns The rule, or `null`.
 */
export function repeatDraftToRule(
    draft: RepeatDraft,
    first: Date,
): JobRepeat | null {
    if (draft.choice === "never") {
        return null;
    }
    const interval = Math.max(1, Math.floor(draft.interval));
    const ends = endsFor(draft);
    const start = first.toISOString();
    const common = { interval, start, ...(ends !== undefined ? { ends } : {}) };
    if (draft.choice === "daily") {
        return { every: "day", ...common };
    }
    if (draft.choice === "weekdays") {
        return { every: "week", weekdays: [...BUSINESS_DAYS], ...common };
    }
    if (draft.choice === "weekly") {
        const weekdays = [...draft.weekdays].sort(
            (a, b) =>
                ["su", "mo", "tu", "we", "th", "fr", "sa"].indexOf(a) -
                ["su", "mo", "tu", "we", "th", "fr", "sa"].indexOf(b),
        );
        return {
            every: "week",
            weekdays: weekdays.length > 0 ? weekdays : ["mo"],
            ...common,
        };
    }
    return {
        every: "month",
        ...(draft.monthly === "day"
            ? { monthDays: [draft.monthDay] }
            : { weekOrdinals: [draft.weekOrdinal] }),
        ...common,
    };
}

/**
 * The draft that reproduces a stored rule (#90 phase 8e).
 *
 * An edit has to render what is there, or opening the form on a series would
 * quietly change it. Anything the chips cannot express lands on the nearest
 * choice that keeps the *rule* intact where it can — and a rule that will not
 * parse at all comes back as "never", which the form shows and the server would
 * refuse to accept back as a change.
 *
 * @param repeat - The job's stored rule, as the wire delivers it.
 * @returns The draft the form opens with.
 */
export function repeatDraftFromRule(repeat: unknown): RepeatDraft {
    const draft = noRepeat();
    const parsed = parseJobRepeat(repeat);
    if (!parsed.ok) {
        return draft;
    }
    const rule = parsed.repeat;
    draft.interval = rule.interval;
    if (rule.ends !== undefined) {
        if ("after" in rule.ends) {
            draft.ends = "after";
            draft.after = rule.ends.after;
        } else {
            draft.ends = "until";
            draft.until = new Date(Date.parse(rule.ends.until));
        }
    }
    if (rule.every === "day") {
        draft.choice = "daily";
        return draft;
    }
    if (rule.every === "week") {
        const days = rule.weekdays ?? [];
        const weekdays =
            days.length === BUSINESS_DAYS.length &&
            BUSINESS_DAYS.every((day) => days.includes(day));
        draft.choice = weekdays ? "weekdays" : "weekly";
        if (!weekdays && days.length > 0) {
            draft.weekdays = [...days];
        }
        return draft;
    }
    if (rule.every === "month") {
        draft.choice = "monthly";
        if ((rule.monthDays ?? []).length > 0) {
            draft.monthly = "day";
            draft.monthDay = (rule.monthDays ?? [])[0];
        } else if ((rule.weekOrdinals ?? []).length > 0) {
            draft.monthly = "ordinal";
            draft.weekOrdinal = (rule.weekOrdinals ?? [])[0];
        }
        return draft;
    }
    // A sub-day cadence has no chip and no fields; the form offers "never" so a
    // save cannot silently keep a cadence it cannot show. Sub-day repeats are
    // made in chat, or by a later control.
    return draft;
}

/**
 * The first thing wrong with a draft's schedule, in the server's own spirit
 * (#90 phase 8e).
 *
 * @param draft - What the form has.
 * @param jobClass - The class the page owns.
 * @returns The problem in words, or `null`.
 */
export function checkRepeatDraft(
    draft: RepeatDraft,
    jobClass: JobClass,
): string | null {
    if (draft.choice === "never") {
        return null;
    }
    if (jobClass === "timer") {
        return "a timer is a countdown, not a schedule — set a reminder instead.";
    }
    if (draft.choice === "weekly" && draft.weekdays.length === 0) {
        return "pick at least one day of the week.";
    }
    if (draft.monthly === "day" || draft.choice === "monthly") {
        if (
            draft.monthDay === 0 ||
            draft.monthDay > 31 ||
            draft.monthDay < -31
        ) {
            return "a day of the month is 1 to 31, or -1 for the last day.";
        }
    }
    if (draft.ends === "after" && draft.after < 1) {
        return "give it at least one repeat.";
    }
    if (draft.ends === "until" && draft.until === null) {
        return "pick the date it should stop after.";
    }
    return null;
}

/** What a form has in hand, before the server sees it (#90 phase 7). */
export interface JobDraft {
    /** The headline ("Kettle", "Call Mum"). */
    label: string;
    /** The detail under it. Optional, and never the label written twice. */
    message: string;
    /** The moment, or `null` when the field could not be read as one. */
    runAt: Date | null;
    /** The class the job will carry — the page's, never a field of its own. */
    jobClass: JobClass;
    /** The schedule, or "never" (#90 phase 8e). */
    repeat: RepeatDraft;
}

/**
 * The fields an edit actually changes, or `null` when nothing did (#90 phase 7).
 *
 * Only what moved is sent, for two reasons. The server refuses an empty patch
 * ("give at least one of label, message or runAt"), and the moment control is
 * minute-granular while a stored instant carries seconds — so sending the moment
 * back untouched would quietly round a timer set for 12:34:56 down to 12:34.
 *
 * A blank detail means "the label", the same normalisation creation applies (see
 * `jobBody`), so clearing the field is a request rather than an empty string the
 * server cannot store — and a rename with the field blank carries the new name as
 * the message, or the stored detail would still be the old one ("Tea Kettle").
 * Both are invisible where it counts, because `jobBody` drops a detail that only
 * repeats the label.
 *
 * @param job - The job as stored.
 * @param draft - What the form has now.
 * @returns The patch to send, or `null` when the draft matches the job.
 */
export function editPatchFor(
    job: Pick<Job, "label" | "message" | "runAt"> & { repeat?: unknown },
    draft: JobDraft,
): JobUpdateRequest | null {
    const patch: JobUpdateRequest = {};
    const label = draft.label.trim();
    if (label !== job.label) {
        patch.label = label;
    }
    const message = draft.message.trim() === "" ? label : draft.message.trim();
    if (message !== job.message) {
        patch.message = message;
    }
    if (
        draft.runAt !== null &&
        momentInputValue(draft.runAt) !== momentInputValue(new Date(job.runAt))
    ) {
        patch.runAt = draft.runAt.toISOString();
    }
    // A rule is sent when it *changes*, and its absence is how the server is told
    // to stop repeating: `null` clears, absent leaves alone. A repeating job's
    // moment is its rule's, so the server derives `runAt` and the one above is
    // ignored — the same instant, because the draft's anchor is the picker's.
    const hadRule = job.repeat !== null && job.repeat !== undefined;
    const wantsRule = draft.repeat.choice !== "never";
    if (hadRule !== wantsRule) {
        patch.repeat =
            wantsRule && draft.runAt !== null
                ? (repeatDraftToRule(draft.repeat, draft.runAt) ?? null)
                : null;
    } else if (wantsRule && draft.runAt !== null) {
        const next = repeatDraftToRule(draft.repeat, draft.runAt);
        if (
            next !== null &&
            JSON.stringify(next) !== JSON.stringify(job.repeat)
        ) {
            patch.repeat = next;
        }
    }
    return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * The first thing wrong with a draft, in the server's own spirit.
 *
 * Every check mirrors a bound `scheduler/create.ts` enforces, so a form can
 * answer without a round trip; a refusal that still gets through (a rule this
 * list does not know about, or a race at the boundary) is shown verbatim, so the
 * two can never disagree about the truth — only about who noticed first.
 *
 * @param draft - What the form has.
 * @param now - The clock to compare the moment against.
 * @returns The problem in words, or `null` when the draft may be sent.
 */
export function checkJobInput(draft: JobDraft, now: Date): string | null {
    const label = draft.label.trim();
    if (label === "") {
        return "give it a name — that is what you will see when it fires.";
    }
    if (label.length > MAX_NOTIFICATION_TITLE_LENGTH) {
        return `a name is at most ${MAX_NOTIFICATION_TITLE_LENGTH} characters.`;
    }
    if (draft.message.trim().length > MAX_NOTIFICATION_BODY_LENGTH) {
        return `the detail is at most ${MAX_NOTIFICATION_BODY_LENGTH} characters.`;
    }
    const at = draft.runAt;
    if (at === null) {
        return draft.jobClass === "timer"
            ? "give it a length — a timer needs one."
            : "pick a moment that reads as a date and time.";
    }
    const aheadMs = at.getTime() - now.getTime();
    if (aheadMs <= 0) {
        return "that moment has already passed — give one in the future.";
    }
    if (draft.jobClass === "timer" && aheadMs > MAX_TIMER_MINUTES * 60_000) {
        return "a countdown longer than a day is a reminder — set a reminder instead.";
    }
    if (aheadMs > HORIZON_DAYS * 24 * 60 * 60_000) {
        return `that is more than ${HORIZON_DAYS} days away.`;
    }
    return checkRepeatDraft(draft.repeat, draft.jobClass);
}

/**
 * A job's cadence in words (#90 phase 8e), or `null` for a one-shot.
 *
 * The protocol's phrase verbatim, because it is the same sentence the model says
 * back when it sets a schedule in chat: a row that read differently from the
 * confirmation would be a second answer to one question.
 *
 * @param job - The job as stored.
 * @returns The cadence, or `null`.
 */
export function repeatText(job: Pick<Job, "repeat">): string | null {
    if (job.repeat === null || job.repeat === undefined) {
        return null;
    }
    const parsed = parseJobRepeat(job.repeat);
    return parsed.ok ? describeRepeat(parsed.repeat) : null;
}

/**
 * When a draft's schedule fires next (#90 phase 8e), or `null` when it does not
 * repeat (or the rule's next occurrence cannot be found).
 *
 * The *same* function the server schedules with, so the preview cannot disagree
 * with what will happen. It runs in the browser's zone, which is the server's for
 * this app's one-box deployment; a cross-zone browser would see its own local
 * reading of the same instant, which is why the row it describes is the server's.
 *
 * @param draft - What the form has.
 * @param now - The clock to search forward from.
 * @returns The next instant, or `null`.
 */
export function nextRepeatAt(draft: RepeatDraft, now: Date): Date | null {
    if (draft.choice === "never") {
        return null;
    }
    const rule = repeatDraftToRule(draft, now);
    if (rule === null) {
        return null;
    }
    const next = nextOccurrence(rule, now);
    return next.ok ? next.at : null;
}
