/**
 * Time, in the words the client shows a person (#90 phase 6b).
 *
 * Hand-rolled rather than `Intl`: the output is asserted in tests, and a locale
 * default would make those assertions depend on where the suite runs. The app is
 * English-only for now, so the trade is a table of names for a deterministic
 * clock.
 *
 * These lived inside `notifications.ts` until the dashboard needed the same
 * clock. Sharing them is the point: a fired reminder and an upcoming job must
 * not disagree about what "8:00 AM" looks like, and `describeSpan` has to read
 * the same in both directions — "in 3 minutes" forward, "3 minutes ago" back.
 */

/** The weekday names, indexed as `Date.getDay()` is. */
const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
] as const;

/** The month names, indexed as `Date.getMonth()` is. */
const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
] as const;

/** The pieces of a clock face, so a caller can render between them. */
export interface ClockParts {
    /** The 12-hour hour, without a leading zero (`8`, `12`). */
    hour: string;
    /** The minute, always two digits (`07`). */
    minute: string;
    /** `AM` or `PM`. */
    suffix: string;
}

/**
 * `8` / `07` / `AM` — the clock split into the parts a face is drawn from.
 *
 * The dashboard wants the colon between two spans (it blinks once a second), and
 * splitting a formatted string back apart would be the kind of parsing that
 * quietly breaks at midnight. {@link clockText} is this, joined.
 *
 * @param at - The instant to render.
 * @returns The hour, minute and meridiem as separate strings.
 */
export function clockParts(at: Date): ClockParts {
    const hours = at.getHours();
    return {
        hour: String(hours % 12 === 0 ? 12 : hours % 12),
        minute: String(at.getMinutes()).padStart(2, "0"),
        suffix: hours < 12 ? "AM" : "PM",
    };
}

/**
 * `2:20 AM` in the browser's local zone — the only clock a user reads.
 *
 * @param at - The instant to render.
 * @returns The 12-hour time, zero-padded to the minute.
 */
export function clockText(at: Date): string {
    const { hour, minute, suffix } = clockParts(at);
    return `${hour}:${minute} ${suffix}`;
}

/**
 * `Saturday` — the weekday alone, for a moment named by its day.
 *
 * @param at - The instant to render.
 * @returns The weekday's English name.
 */
export function weekdayText(at: Date): string {
    return WEEKDAYS[at.getDay()];
}

/**
 * `Saturday, 17 October` — the weekday first, because a date in a greeting is
 * read to answer "what day is it", not "what is the number".
 *
 * @param at - The instant to render.
 * @returns The weekday, day of month, and month name.
 */
export function formatDate(at: Date): string {
    return `${weekdayText(at)}, ${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/**
 * `3 minutes` / `2 hours` / `1 day` — the unit a person would use, with the
 * largest one that still reads precisely.
 *
 * Direction-agnostic by design: it formats a span, and the caller supplies the
 * preposition. The notification list reads it as "3 minutes ago"; the dashboard
 * reads the same number as "in 3 minutes".
 *
 * @param ms - The span in milliseconds (a magnitude; the sign is the caller's).
 * @returns The span in the largest readable unit.
 */
export function describeSpan(ms: number): string {
    const minutes = Math.floor(Math.abs(ms) / 60_000);
    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 36) {
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
}
