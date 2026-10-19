/**
 * How a scheduled job repeats (#90 phase 8) — the rule, its validation, and the
 * one function that says when it fires next.
 *
 * This lives in the protocol package beside {@link NotificationClass} for a
 * reason rather than for tidiness: **both ends compute from it**. The server
 * schedules the next occurrence with `nextOccurrence`, and the web form previews
 * one with the same function, so the preview cannot disagree with what will
 * actually happen. The package stays zero-dependency — the maths is `Date`
 * arithmetic and one injectable {@link Zone}.
 *
 * ## The shape
 *
 * - `start` is the **anchor**. For `day` and up, its wall-clock time is the time
 *   the series fires at; for `minute`/`hour`, its instant is what every-N aligns
 *   to. There is deliberately no separate `at` field: two representations of one
 *   wall clock is how a series drifts, and a snooze or a quiet-hours deferral
 *   moves a job's `run_at`, never its anchor — which is what makes a series
 *   return to its own clock afterwards (a snooze of a 9am daily reminder is 10am
 *   today, 9am tomorrow).
 * - `weekdays` / `monthDays` / `weekOrdinals` **compose as a union** inside a
 *   month: "every Monday and the 1st" is all the Mondays *plus* the 1st (≈6
 *   firings a month), not the once-every-seven-months Monday that is also the
 *   1st. RFC 5545's `BYDAY`+`BYMONTHDAY` intersects; a person means the union,
 *   so the union is what this implements, and a phrase that could mean either is
 *   a question for the model to ask rather than a guess for the code to make.
 * - `ends` is optional from the start: a wall-clock `until`, or `after N`
 *   firings (counted by the ledger, not here — see {@link repeatExhausted}).
 *
 * ## The three tiers of impossible dates (user decision 2026-10-18)
 *
 * | Tier                 | Example                   | Behaviour                                                             |
 * | -------------------- | ------------------------- | --------------------------------------------------------------------- |
 * | **sometimes** exists | "the 31st" in February    | clamped to the last day of the month (`[31]` ≡ `[-1]`)                |
 * | **seldom** exists    | "the 5th Monday"          | literal: that month is skipped, and the caller says when the next one is |
 * | **never** exists     | "the 7th Monday", day 40  | refused by {@link parseJobRepeat} with the reason                     |
 *
 * ## Zones and DST
 *
 * The default {@link LOCAL_ZONE} is the runtime's own clock — the server's local
 * zone everywhere in this app (`scheduler/time.ts` writes that assumption down),
 * and the browser's for the form's preview. {@link Zone} is injectable so the
 * tests can pin DST exactly and a per-job zone stays a later change rather than
 * a rewrite; it is not exposed to users yet.
 *
 * Disambiguation is **explicit, never left to the engine**: a wall clock that
 * does not exist (spring forward) resolves to the instant the clock jumps to, and
 * one that happens twice (autumn) yields both instants, earliest first. V8's own
 * choice is not specified by ECMAScript, and the preview runs in another engine.
 */

/** The units an interval can count in. */
export const REPEAT_FREQUENCIES = [
    "minute",
    "hour",
    "day",
    "week",
    "month",
] as const;

/** How often a job repeats. */
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number];

/**
 * The weekdays a `week` or `month` rule can name, in calendar order (Sunday
 * first, matching `Date#getUTCDay`). The week grid itself starts on **Monday**,
 * so "every 2 weeks on Monday" is two ISO weeks rather than two of whichever
 * week the anchor happened to land in.
 */
export const WEEKDAYS = ["su", "mo", "tu", "we", "th", "fr", "sa"] as const;

/** One day of the week, as a rule names it. */
export type Weekday = (typeof WEEKDAYS)[number];

/** How many units may sit between occurrences ("every 1000 days"). */
export const MAX_REPEAT_INTERVAL = 1000;

/**
 * The largest ordinal accepted for a weekday-in-month ("the 5th Monday").
 *
 * Five is the most any month can hold, so a 6th is a rule that could never come
 * round — refused rather than searched for forever.
 */
export const MAX_REPEAT_ORDINAL = 5;

/**
 * How many periods {@link nextOccurrence} will step before giving up.
 *
 * Every valid rule has an occurrence within a few periods ("the 5th Monday" is
 * the sparse case, and months with five Mondays are ordinary), so this is a
 * guard against a hung process rather than a working limit: 400 months is over
 * 30 years. Exhausting it returns `never`, which no rule built by
 * {@link parseJobRepeat} is expected to reach.
 */
export const MAX_REPEAT_STEPS = 400;

/**
 * A job's recurrence rule.
 *
 * Every field is validated by {@link parseJobRepeat}; construct rules through it
 * rather than by hand, so a malformed one cannot reach the scheduler.
 */
export interface JobRepeat {
    /** The unit the interval counts in. */
    every: RepeatFrequency;
    /** How many of them between occurrences: "every 3 weeks" is `3`. */
    interval: number;
    /**
     * The anchor, as an ISO instant. Its local wall clock is when a `day`, `week`
     * or `month` series fires; its instant is what a `minute`/`hour` interval
     * aligns to. Immutable for the life of a series.
     */
    start: string;
    /** Days of the week — a `week` rule, or part of a `month` union. */
    weekdays?: Weekday[];
    /** Days of the month, 1..31 or negative from the end (`-1` is the last day). */
    monthDays?: number[];
    /** Ordinal weekdays in a month: `"2tu"` (the 2nd Tuesday), `"-1fr"` (the last Friday). */
    weekOrdinals?: string[];
    /** When the series stops. Omitted entirely means "until cancelled". */
    ends?: { until: string } | { after: number };
}

/** What {@link parseJobRepeat} answers. */
export type RepeatParseResult =
    { ok: true; repeat: JobRepeat } | { ok: false; reason: string };

/** What {@link nextOccurrence} answers. */
export type NextOccurrenceResult =
    | { ok: true; at: Date }
    | {
          ok: false;
          /**
           * `ended` — the rule's own `until` has passed, so the series is over.
           * `never` — {@link MAX_REPEAT_STEPS} periods held no occurrence; a
           * rule that cannot come round, or a bug. The creation door refuses it.
           */
          reason: "ended" | "never";
      };

/**
 * A clock's offset from UTC, in milliseconds **east** of it.
 *
 * The seam that makes DST testable and a future per-job zone cheap: everything
 * below asks a zone for an offset instead of asking `Date` for the local time.
 */
export interface Zone {
    /** The offset in effect at an instant (UTC milliseconds since the epoch). */
    offsetAt(utcMs: number): number;
}

/**
 * The running process's own zone — the server's clock, and the browser's.
 *
 * `getTimezoneOffset()` is minutes **west** of UTC and inverted for summer time,
 * hence the negation.
 */
export const LOCAL_ZONE: Zone = {
    offsetAt(utcMs: number): number {
        return -new Date(utcMs).getTimezoneOffset() * 60_000;
    },
};

/** Milliseconds in a day — the probe distance either side of a wall clock. */
const DAY_MS = 86_400_000;

/** The frequency's period in milliseconds; `null` for the calendar frequencies. */
function subDayStepMs(every: RepeatFrequency): number | null {
    if (every === "minute") {
        return 60_000;
    }
    if (every === "hour") {
        return 3_600_000;
    }
    return null;
}

/** How many days are in a month (`month` is 0-based, as `Date` counts). */
function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The weekday of a calendar date (0 = Sunday), computed without any zone. */
function weekdayOf(year: number, month: number, day: number): number {
    return new Date(Date.UTC(year, month, day)).getUTCDay();
}

/** Moves a calendar date by whole days, without any zone. */
function addDays(
    year: number,
    month: number,
    day: number,
    days: number,
): { year: number; month: number; day: number } {
    const moved = new Date(Date.UTC(year, month, day + days));
    return {
        year: moved.getUTCFullYear(),
        month: moved.getUTCMonth(),
        day: moved.getUTCDate(),
    };
}

/** Moves a calendar month by whole months. */
function addMonths(
    year: number,
    month: number,
    months: number,
): { year: number; month: number } {
    const total = year * 12 + month + months;
    return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** The wall-clock reading a zone shows for an instant: a `Date` to read in UTC. */
function wallClock(zone: Zone, utcMs: number): Date {
    return new Date(utcMs + zone.offsetAt(utcMs));
}

/** Whether a wall-clock reading matches the one that was asked for. */
function isWallClock(
    zone: Zone,
    utcMs: number,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
): boolean {
    const at = wallClock(zone, utcMs);
    return (
        at.getUTCFullYear() === year &&
        at.getUTCMonth() === month &&
        at.getUTCDate() === day &&
        at.getUTCHours() === hour &&
        at.getUTCMinutes() === minute
    );
}

/**
 * Every instant at which a zone reads one particular wall clock, earliest
 * first.
 *
 * Normally one; **two** when the clock fell back through it earlier that day, and
 * **one shifted instant** when the clock sprang forward past it and the wall
 * clock never happened ("02:30" on a spring-forward day resolves to 03:30, which
 * is what every calendar does with a time that does not exist).
 *
 * The offsets are probed a day either side of the reading rather than read at a
 * guessed instant, so this works in either hemisphere and through a whole-day
 * offset change.
 */
function wallClockInstants(
    zone: Zone,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
): number[] {
    const asUtc = Date.UTC(year, month, day, hour, minute);
    const before = zone.offsetAt(asUtc - DAY_MS);
    const after = zone.offsetAt(asUtc + DAY_MS);
    const offsets = before === after ? [before] : [before, after];
    const found: number[] = [];
    for (const offset of offsets) {
        const utcMs = asUtc - offset;
        if (isWallClock(zone, utcMs, year, month, day, hour, minute)) {
            found.push(utcMs);
        }
    }
    if (found.length > 0) {
        return found.sort((a, b) => a - b);
    }
    // A gap: the clock jumped forward over this reading. Move the wall clock by
    // the width of the gap and take the instant that results — the moment the
    // clock has skipped to.
    const shifted = asUtc + (after - before);
    return [shifted - after];
}

/** The ordinal-weekday spelling: `2tu`, `-1fr`. */
const ORDINAL_PATTERN = /^(-?)([1-5])(su|mo|tu|we|th|fr|sa)$/;

/**
 * The day of the month an ordinal-weekday names, or `null` when that month has
 * no such occurrence.
 *
 * `"2tu"` is the second Tuesday, `"-1fr"` the last Friday. A five-Monday month
 * is ordinary and a four-Monday one is more common, so `"5mo"` is a real rule
 * that simply skips most months — the tier the plan calls *seldom exists*.
 */
function ordinalDay(
    year: number,
    month: number,
    ordinal: string,
): number | null {
    const parsed = ORDINAL_PATTERN.exec(ordinal);
    if (parsed === null) {
        return null;
    }
    const [, sign, count, weekday] = parsed;
    const target = WEEKDAYS.indexOf(weekday as Weekday);
    const total = daysInMonth(year, month);
    if (sign === "-") {
        // Count back from the end of the month.
        const last = total - ((weekdayOf(year, month, total) - target + 7) % 7);
        const day = last - (Number(count) - 1) * 7;
        return day >= 1 ? day : null;
    }
    const first = 1 + ((target - weekdayOf(year, month, 1) + 7) % 7);
    const day = first + (Number(count) - 1) * 7;
    return day <= total ? day : null;
}

/**
 * The days of one month this rule names, ascending and deduplicated.
 *
 * `monthDays`, `weekdays` and `weekOrdinals` are a **union** (see the module
 * doc): a clamped day of the month, every matching weekday, and every named
 * ordinal. A positive `monthDays` entry beyond the month's length is clamped to
 * its last day — "the 31st" fires on the 28th in February — while an ordinal
 * that does not occur is dropped, because "the 5th Monday" is a real thing that
 * this month simply does not have.
 */
function monthDaysFor(
    repeat: JobRepeat,
    year: number,
    month: number,
): number[] {
    const days = new Set<number>();
    const total = daysInMonth(year, month);
    for (const day of repeat.monthDays ?? []) {
        days.add(day > 0 ? Math.min(day, total) : total + day + 1);
    }
    for (const weekday of repeat.weekdays ?? []) {
        const target = WEEKDAYS.indexOf(weekday);
        for (let day = 1; day <= total; day++) {
            if (weekdayOf(year, month, day) === target) {
                days.add(day);
            }
        }
    }
    for (const ordinal of repeat.weekOrdinals ?? []) {
        const day = ordinalDay(year, month, ordinal);
        if (day !== null) {
            days.add(day);
        }
    }
    return [...days].sort((a, b) => a - b);
}

/**
 * The next firing of a rule, strictly after `now`.
 *
 * Pure and injectable: the same function schedules on the server and previews in
 * the browser, and the tests pin DST with a synthetic {@link Zone}. It answers
 * `ended` once a rule's own `until` has passed (the caller settles the series),
 * and `never` when the step ceiling holds no occurrence — which no rule built by
 * {@link parseJobRepeat} is expected to reach.
 *
 * The contract is **strictly after**: a candidate that is not ahead of `now` is
 * passed over rather than returned. That is not a formality — in the repeated
 * hour of an autumn change an ambiguous wall clock resolves to the *earlier*
 * offset, so "today 01:30" built at 01:45 is already in the past. The second
 * instance is the real answer.
 *
 * @param repeat - The rule, as {@link parseJobRepeat} produced it.
 * @param now - The clock to search forward from (injected, for tests).
 * @param zone - The clock's zone (defaults to {@link LOCAL_ZONE}).
 * @returns The next instant, or why there is none.
 */
export function nextOccurrence(
    repeat: JobRepeat,
    now: Date,
    zone: Zone = LOCAL_ZONE,
): NextOccurrenceResult {
    const anchor = Date.parse(repeat.start);
    if (!Number.isFinite(anchor)) {
        return { ok: false, reason: "never" };
    }
    const nowMs = now.getTime();
    const until =
        repeat.ends !== undefined && "until" in repeat.ends
            ? Date.parse(repeat.ends.until)
            : null;

    // Sub-day frequencies are exact instant arithmetic: "every 24 hours" is not
    // "every day at the same clock time", and saying so is the point — it is how
    // a job that must go off every N hours is expressed.
    const stepMs = subDayStepMs(repeat.every);
    if (stepMs !== null) {
        const period = stepMs * repeat.interval;
        const steps = Math.max(0, Math.floor((nowMs - anchor) / period) + 1);
        let at = anchor + steps * period;
        if (at <= nowMs) {
            at += period;
        }
        if (until !== null && at > until) {
            return { ok: false, reason: "ended" };
        }
        return { ok: true, at: new Date(at) };
    }

    // Calendar frequencies: the anchor's wall clock is the time of day, and the
    // candidates are generated date by date, so DST resolves per occurrence.
    const anchorWall = wallClock(zone, anchor);
    const hour = anchorWall.getUTCHours();
    const minute = anchorWall.getUTCMinutes();
    const nowWall = wallClock(zone, nowMs);
    // Start near the answer rather than at the anchor: a daily series a year old
    // would otherwise spend its whole step budget reaching today.
    const first = estimateStep(repeat, anchorWall, nowWall);

    for (let step = first; step <= first + MAX_REPEAT_STEPS; step++) {
        const candidates = periodInstants(
            repeat,
            zone,
            anchorWall,
            step,
            hour,
            minute,
        );
        for (const candidate of candidates) {
            if (candidate <= nowMs) {
                continue;
            }
            if (until !== null && candidate > until) {
                return { ok: false, reason: "ended" };
            }
            return { ok: true, at: new Date(candidate) };
        }
    }
    // Nothing inside the ceiling: either the rule's own end is behind us — the
    // series finished — or the rule cannot come round at all.
    if (until !== null && until <= nowMs) {
        return { ok: false, reason: "ended" };
    }
    return { ok: false, reason: "never" };
}

/**
 * How many periods a frequency has already passed at `now`.
 *
 * The search's starting point, deliberately a period short and never past the
 * answer (the loop still verifies every candidate against `now`). Calendar days
 * and months are compared as calendar values rather than instants, so a DST
 * change cannot shift the estimate by a day.
 */
function estimateStep(
    repeat: JobRepeat,
    anchorWall: Date,
    nowWall: Date,
): number {
    if (repeat.every === "month") {
        const months =
            nowWall.getUTCFullYear() * 12 +
            nowWall.getUTCMonth() -
            (anchorWall.getUTCFullYear() * 12 + anchorWall.getUTCMonth());
        return Math.max(0, Math.floor(months / repeat.interval) - 1);
    }
    const days =
        (Date.UTC(
            nowWall.getUTCFullYear(),
            nowWall.getUTCMonth(),
            nowWall.getUTCDate(),
        ) -
            Date.UTC(
                anchorWall.getUTCFullYear(),
                anchorWall.getUTCMonth(),
                anchorWall.getUTCDate(),
            )) /
        DAY_MS;
    if (days <= 0) {
        return 0;
    }
    const periodDays =
        repeat.every === "week" ? 7 * repeat.interval : repeat.interval;
    return Math.max(0, Math.floor(days / periodDays) - 1);
}

/**
 * One period's instants, earliest first.
 *
 * `step` counts periods from the anchor, so `interval` is applied here rather
 * than by the caller: a `month` rule steps months, a `week` rule steps weeks
 * from the anchor's Monday, a `day` rule steps days. A day that a spring-forward
 * gap swallowed contributes the instant the clock jumped to; a day the clock
 * passed through twice contributes both, so the caller can pick the first one
 * still ahead of it.
 */
function periodInstants(
    repeat: JobRepeat,
    zone: Zone,
    anchorWall: Date,
    step: number,
    hour: number,
    minute: number,
): number[] {
    const anchorYear = anchorWall.getUTCFullYear();
    const anchorMonth = anchorWall.getUTCMonth();
    const anchorDay = anchorWall.getUTCDate();

    if (repeat.every === "month") {
        const { year, month } = addMonths(
            anchorYear,
            anchorMonth,
            step * repeat.interval,
        );
        const found: number[] = [];
        for (const day of monthDaysFor(repeat, year, month)) {
            found.push(
                ...wallClockInstants(zone, year, month, day, hour, minute),
            );
        }
        return found.sort((a, b) => a - b);
    }

    if (repeat.every === "week") {
        // The anchor's own week, starting Monday, stepped by `interval`.
        const mondayOffset =
            (weekdayOf(anchorYear, anchorMonth, anchorDay) + 6) % 7;
        const week = addDays(anchorYear, anchorMonth, anchorDay, -mondayOffset);
        const start = addDays(
            week.year,
            week.month,
            week.day,
            step * repeat.interval * 7,
        );
        const weekdays = repeat.weekdays ?? [];
        const found: number[] = [];
        for (let offset = 0; offset < 7; offset++) {
            const date = addDays(start.year, start.month, start.day, offset);
            const weekday =
                WEEKDAYS[weekdayOf(date.year, date.month, date.day)];
            if (!weekdays.includes(weekday)) {
                continue;
            }
            found.push(
                ...wallClockInstants(
                    zone,
                    date.year,
                    date.month,
                    date.day,
                    hour,
                    minute,
                ),
            );
        }
        return found.sort((a, b) => a - b);
    }

    const date = addDays(
        anchorYear,
        anchorMonth,
        anchorDay,
        step * repeat.interval,
    );
    return wallClockInstants(
        zone,
        date.year,
        date.month,
        date.day,
        hour,
        minute,
    );
}

/**
 * Whether a series is finished by its own firing count.
 *
 * `until` is a calendar bound and lives in {@link nextOccurrence}; this is the
 * other half of `ends`, and it is the **caller's** to answer because the count
 * lives in the ledger (`attempts`, one per firing). `after: 5` means five
 * firings, and a silent skip — down-time, an overlap, a tripped budget — is not
 * one of them: it never claimed the job, so it never counted.
 *
 * @param repeat - The rule.
 * @param attempts - How many firings the job has claimed so far.
 * @returns Whether no further occurrence should be scheduled.
 */
export function repeatExhausted(repeat: JobRepeat, attempts: number): boolean {
    const ends = repeat.ends;
    return ends !== undefined && "after" in ends && attempts >= ends.after;
}

/** A clock reading one wall clock's worth of fields, for validation. */
function isWholeNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value);
}

/**
 * Validates a rule that arrived as data (a tool argument, a JSON column, a
 * request body), returning a normalized copy.
 *
 * Strict on purpose, and strict about the *tiers*: a rule naming a day that
 * cannot exist ("the 32nd", "the 7th Monday") is refused here with the reason,
 * because no amount of searching will find it. A rule that merely *skips* some
 * months ("the 31st", "the 5th Monday") is legal and resolves in
 * {@link nextOccurrence}. The two are different answers to different questions,
 * which is why they are not the same error.
 *
 * Normalization is limited to what changes nothing: arrays are deduplicated and
 * sorted, so parsing twice yields the same rule.
 *
 * @param value - The candidate rule.
 * @returns The normalized rule, or the reason it is not one.
 */
export function parseJobRepeat(value: unknown): RepeatParseResult {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: "a repeat rule must be an object" };
    }
    const raw = value as Record<string, unknown>;
    const known = new Set([
        "every",
        "interval",
        "start",
        "weekdays",
        "monthDays",
        "weekOrdinals",
        "ends",
    ]);
    for (const key of Object.keys(raw)) {
        if (!known.has(key)) {
            return { ok: false, reason: `unknown repeat field "${key}"` };
        }
    }

    const every = raw.every;
    if (
        typeof every !== "string" ||
        !(REPEAT_FREQUENCIES as readonly string[]).includes(every)
    ) {
        return {
            ok: false,
            reason: `"every" must be one of ${REPEAT_FREQUENCIES.join(", ")}`,
        };
    }
    const frequency = every as RepeatFrequency;

    const interval = raw.interval;
    if (
        !isWholeNumber(interval) ||
        interval < 1 ||
        interval > MAX_REPEAT_INTERVAL
    ) {
        return {
            ok: false,
            reason: `"interval" must be a whole number from 1 to ${MAX_REPEAT_INTERVAL}`,
        };
    }

    const start = raw.start;
    if (typeof start !== "string" || !Number.isFinite(Date.parse(start))) {
        return { ok: false, reason: '"start" must be an instant' };
    }

    const calendar =
        frequency === "day" || frequency === "week" || frequency === "month";
    const weekly = frequency === "week" || frequency === "month";
    const monthly = frequency === "month";

    let weekdays: Weekday[] | undefined;
    if (raw.weekdays !== undefined) {
        if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
            return {
                ok: false,
                reason: '"weekdays" must be a non-empty array',
            };
        }
        if (!weekly) {
            return {
                ok: false,
                reason: `"weekdays" applies to a week or month rule, not to an "${frequency}" one`,
            };
        }
        const names: Weekday[] = [];
        for (const entry of raw.weekdays) {
            if (
                typeof entry !== "string" ||
                !(WEEKDAYS as readonly string[]).includes(entry)
            ) {
                return {
                    ok: false,
                    reason: `"weekdays" entries must be one of ${WEEKDAYS.join(", ")}`,
                };
            }
            names.push(entry as Weekday);
        }
        weekdays = [...new Set(names)].sort(
            (a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b),
        );
    }

    let monthDays: number[] | undefined;
    if (raw.monthDays !== undefined) {
        if (!Array.isArray(raw.monthDays) || raw.monthDays.length === 0) {
            return {
                ok: false,
                reason: '"monthDays" must be a non-empty array',
            };
        }
        if (!monthly) {
            return {
                ok: false,
                reason: `"monthDays" applies to a month rule, not to an "${frequency}" one`,
            };
        }
        const days: number[] = [];
        for (const entry of raw.monthDays) {
            if (
                !isWholeNumber(entry) ||
                entry === 0 ||
                entry > 31 ||
                entry < -31
            ) {
                return {
                    ok: false,
                    reason: '"monthDays" entries must be from 1 to 31, or -1 to -31 counting back from the end of the month',
                };
            }
            days.push(entry);
        }
        monthDays = [...new Set(days)].sort((a, b) => a - b);
    }

    let weekOrdinals: string[] | undefined;
    if (raw.weekOrdinals !== undefined) {
        if (!Array.isArray(raw.weekOrdinals) || raw.weekOrdinals.length === 0) {
            return {
                ok: false,
                reason: '"weekOrdinals" must be a non-empty array',
            };
        }
        if (!monthly) {
            return {
                ok: false,
                reason: `"weekOrdinals" applies to a month rule, not to an "${frequency}" one`,
            };
        }
        const ordinals: string[] = [];
        for (const entry of raw.weekOrdinals) {
            if (typeof entry !== "string" || !ORDINAL_PATTERN.test(entry)) {
                return {
                    ok: false,
                    reason: `"weekOrdinals" entries look like "2tu" or "-1fr" — an ordinal from 1 to ${MAX_REPEAT_ORDINAL}, counted back with a minus, and a weekday`,
                };
            }
            ordinals.push(entry);
        }
        weekOrdinals = [...new Set(ordinals)].sort();
    }

    if (!calendar && (weekdays ?? monthDays ?? weekOrdinals) !== undefined) {
        return {
            ok: false,
            reason: `an "${frequency}" rule cannot name days — use day, week or month`,
        };
    }

    let ends: JobRepeat["ends"];
    if (raw.ends !== undefined) {
        if (
            typeof raw.ends !== "object" ||
            raw.ends === null ||
            Array.isArray(raw.ends)
        ) {
            return { ok: false, reason: '"ends" must be an object' };
        }
        const end = raw.ends as Record<string, unknown>;
        const hasUntil = end.until !== undefined;
        const hasAfter = end.after !== undefined;
        if (hasUntil === hasAfter) {
            return {
                ok: false,
                reason: '"ends" takes either "until" or "after", not both and not neither',
            };
        }
        if (hasUntil) {
            const until = end.until;
            if (
                typeof until !== "string" ||
                !Number.isFinite(Date.parse(until))
            ) {
                return { ok: false, reason: '"ends.until" must be an instant' };
            }
            if (Date.parse(until) <= Date.parse(start)) {
                return {
                    ok: false,
                    reason: '"ends.until" must be after the first occurrence',
                };
            }
            ends = { until };
        } else {
            const after = end.after;
            if (!isWholeNumber(after) || after < 1) {
                return {
                    ok: false,
                    reason: '"ends.after" must be a whole number of firings, at least 1',
                };
            }
            ends = { after };
        }
    }

    return {
        ok: true,
        repeat: {
            every: frequency,
            interval,
            start,
            ...(weekdays !== undefined ? { weekdays } : {}),
            ...(monthDays !== undefined ? { monthDays } : {}),
            ...(weekOrdinals !== undefined ? { weekOrdinals } : {}),
            ...(ends !== undefined ? { ends } : {}),
        },
    };
}
