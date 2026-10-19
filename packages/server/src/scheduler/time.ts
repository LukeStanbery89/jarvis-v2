/**
 * Wall-clock → run-instant resolution for scheduled jobs (#90 phase 3).
 *
 * The model never produces timestamps. It is told what the user said — a delay,
 * a clock time, or a clock time on a named day — and this module turns that into
 * one instant, in the **server's local zone**: the same clock `getCurrentTime`
 * reports and the same assumption the scheduler's due-scan already makes (the
 * server runs on the user's own machine). A client in another timezone would be
 * scheduled in server time; that limitation is written down rather than guessed
 * around, and the fix — carrying the client's zone — is a later protocol change.
 *
 * Pure and injected (`now` is a parameter, never `new Date()`), because the rules
 * it owns are the ones worth pinning:
 *
 * - a bare clock time means **the next time the clock reads that** — "at 8" said
 *   at 9pm is tomorrow, said at 7:50pm is ten minutes away;
 * - a clock time that passed *seconds* ago still means today, because the model
 *   resolves the user's words and the tool runs a moment later — silently
 *   sending that to tomorrow would be a wrong answer to a correct request;
 * - a weekday means the next time that day comes round, today included when its
 *   clock time is still ahead ("Friday at 8" said on Friday at 7am is today);
 * - an **explicit** date in the past is refused rather than shifted, because an
 *   explicit date is explicit intent and the user can be told it has passed.
 *
 * Callers: the jobs tools (`llm/tools/jobs.ts`) for `remindMe` and
 * `scheduleTask`, and `test/jobTime.test.ts`. `setTimer` takes a duration
 * directly, so it does not need this module.
 */

/** What the model said about when a job should run. */
export interface WhenInput {
    /** A delay in minutes ("in 10 minutes"); a fraction is a fraction of one. */
    inMinutes?: number;
    /** A 24-hour clock time ("08:30"); the hour's leading zero is optional. */
    at?: string;
    /**
     * The day for `at`: `today`, `tomorrow`, a weekday name (three or more
     * letters, so `fri` works), or a calendar date as `YYYY-MM-DD`.
     */
    onDate?: string;
}

/** The resolved instant, or why the input cannot be resolved. */
export type WhenResult = { ok: true; at: Date } | { ok: false; reason: string };

/**
 * How far in the past a clock time may be and still mean "today".
 *
 * The gap between the model deciding on a time and the tool executing is
 * typically well under a second, but a slow turn — or a prompt that says "at
 * 8" at 7:59:58 — can cross the minute boundary. A minute of grace keeps that
 * ordinary case honest: it schedules the instant that just passed, which the
 * runner's lateness window then fires on the next tick.
 */
const CLOCK_GRACE_MS = 60_000;

/** `HH:MM` with an optional leading zero on the hour, and nothing else. */
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** A calendar date the model can have derived, e.g. `2026-10-20`. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Lower-case weekday names, indexed as `Date.getDay()` indexes them. */
const WEEKDAYS = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

/**
 * Turns what the model said into the instant a job should run.
 *
 * Accepts exactly one time form — a delay, or a clock time with an optional day
 * — and refuses anything ambiguous with a reason written to be relayed to the
 * user ("that time has already passed…"), never a thrown error: the model may
 * retry with a corrected argument, which is the whole point of refusing.
 */
export function resolveWhen(input: WhenInput, now: Date): WhenResult {
    const hasDelay = input.inMinutes !== undefined;
    const hasClock = input.at !== undefined;
    const hasDate = input.onDate !== undefined;

    if (hasDelay && (hasClock || hasDate)) {
        return {
            ok: false,
            reason: "give either `inMinutes` or `at`/`onDate`, not both.",
        };
    }
    if (hasDate && !hasClock) {
        return {
            ok: false,
            reason: "`onDate` needs a time of day — pass `at` (HH:MM) as well.",
        };
    }
    if (!hasDelay && !hasClock) {
        return {
            ok: false,
            reason: "no time was given — pass `inMinutes`, or `at` (HH:MM) with an optional `onDate`.",
        };
    }

    if (hasDelay) {
        const minutes = input.inMinutes as number;
        if (!Number.isFinite(minutes) || minutes <= 0) {
            return {
                ok: false,
                reason: "`inMinutes` must be a positive number of minutes.",
            };
        }
        const at = new Date(now.getTime() + minutes * 60_000);
        if (!Number.isFinite(at.getTime())) {
            return {
                ok: false,
                reason: "that delay is too large to schedule.",
            };
        }
        return { ok: true, at };
    }

    const clock = parseClock(input.at as string);
    if (clock === null) {
        return {
            ok: false,
            reason: "`at` must be a 24-hour clock time like 08:30 (or 8:30).",
        };
    }

    // A bare clock time: the next time the clock reads that. Today, unless the
    // time has gone by more than the grace window.
    if (!hasDate) {
        const today = localInstant(now, 0, clock.hours, clock.minutes);
        const at =
            today.getTime() >= now.getTime() - CLOCK_GRACE_MS
                ? today
                : localInstant(now, 1, clock.hours, clock.minutes);
        return { ok: true, at };
    }

    const day = dayOffsetFor(input.onDate as string, now);
    if (day === null) {
        return {
            ok: false,
            reason: "`onDate` must be 'today', 'tomorrow', a weekday name, or a date like 2026-10-20.",
        };
    }

    let at = localInstant(now, day.offset, clock.hours, clock.minutes);
    // A weekday names a recurring day; an explicit date does not. So "Friday at
    // 8" said after Friday's 8 still resolves — to next Friday — while
    // "2026-10-20 at 8" said afterwards is a mistake to report.
    if (day.weekly && at.getTime() < now.getTime() - CLOCK_GRACE_MS) {
        at = localInstant(now, day.offset + 7, clock.hours, clock.minutes);
    }
    if (at.getTime() < now.getTime() - CLOCK_GRACE_MS) {
        return {
            ok: false,
            reason: `that time has already passed (${stamp(at)}). Use "tomorrow" or a later date.`,
        };
    }
    return { ok: true, at };
}

/**
 * One local instant `dayOffset` days from `base`'s local date.
 *
 * Built from local fields on purpose: the resolver's contract is the server's
 * wall clock, so DST crossings are the platform's own answer (a time inside a
 * spring-forward gap shifts to the next valid clock reading) rather than
 * arithmetic this module invents.
 */
function localInstant(
    base: Date,
    dayOffset: number,
    hours: number,
    minutes: number,
): Date {
    return new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate() + dayOffset,
        hours,
        minutes,
        0,
        0,
    );
}

/** `HH:MM` → hours/minutes, or `null` when it is not a wall-clock time. */
function parseClock(value: string): { hours: number; minutes: number } | null {
    const match = CLOCK_PATTERN.exec(value.trim());
    if (match === null) {
        return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
        return null;
    }
    return { hours, minutes };
}

/**
 * Which calendar day `value` names, as an offset from `now`'s local date.
 *
 * `weekly` marks a weekday name, the one form that may roll forward rather
 * than be refused when its clock time has passed. `null` means the value is not
 * a day this module understands.
 */
function dayOffsetFor(
    value: string,
    now: Date,
): { offset: number; weekly: boolean } | null {
    const normalized = value.trim().toLowerCase();
    if (normalized === "today") {
        return { offset: 0, weekly: false };
    }
    if (normalized === "tomorrow") {
        return { offset: 1, weekly: false };
    }
    const weekday = weekdayIndex(normalized);
    if (weekday !== null) {
        return { offset: (weekday - now.getDay() + 7) % 7, weekly: true };
    }
    const date = parseDate(normalized);
    if (date === null) {
        return null;
    }
    // UTC midnights make the difference a whole number of days regardless of a
    // DST change between the two dates.
    const days = Math.round(
        (Date.UTC(date.year, date.month - 1, date.day) -
            Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
            86_400_000,
    );
    return { offset: days, weekly: false };
}

/**
 * A weekday from a name or an unambiguous prefix of at least three letters
 * (`fri`, `friday`), or `null` when the fragment names no day or several.
 */
function weekdayIndex(value: string): number | null {
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 3) {
        return null;
    }
    const matches = WEEKDAYS.flatMap((name, index) =>
        name.startsWith(normalized) ? [index] : [],
    );
    return matches.length === 1 ? matches[0] : null;
}

/**
 * A real calendar date from `YYYY-MM-DD`, or `null` — including impossible ones
 * (`2026-02-30`) rather than letting the platform roll them into March.
 */
function parseDate(
    value: string,
): { year: number; month: number; day: number } | null {
    const match = DATE_PATTERN.exec(value);
    if (match === null) {
        return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }
    const check = new Date(year, month - 1, day);
    if (
        check.getFullYear() !== year ||
        check.getMonth() !== month - 1 ||
        check.getDate() !== day
    ) {
        return null;
    }
    return { year, month, day };
}

/** A local `YYYY-MM-DD HH:MM` stamp, for refusal text only. */
function stamp(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
        ` ${pad(at.getHours())}:${pad(at.getMinutes())}`
    );
}
