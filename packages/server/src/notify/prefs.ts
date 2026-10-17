/**
 * The `notify.*` preference shapes (#139) — one home for what these values
 * mean, because two callers must agree on it and must keep agreeing:
 *
 * - the delivery path (`service.ts`) **reads** them leniently. A value it
 *   cannot parse is ignored rather than fatal, so a hand-edited pref can never
 *   change behaviour in a way nobody can see, and the failure direction is
 *   always "no quiet hours", never "silent for the rest of the day".
 * - the prefs write path (`../prefs/known.ts`) **validates** them strictly. A
 *   write that would store something unreadable is a 400 to whoever wrote it,
 *   rather than a setting that appears to save and does nothing.
 *
 * Both halves live here so the definition cannot drift. The strict check is
 * {@link parseQuietHours}'s shape plus a reportable reason — with one
 * deliberate asymmetry: a zero-length window is *tolerated* on read (as "no
 * quiet hours") but refused on write, since there is no reason to store one.
 *
 * A third caller arrived with #90: the scheduler needs the same window
 * arithmetic to know when a deferred reminder may come back
 * ({@link quietHoursEnd}) and whether the window holds a given class at all
 * ({@link quietHoursHold}, also used by `service.ts`). Keeping that here means
 * there is one implementation of "is it quiet now", not two that disagree at
 * midnight.
 */

import type { NotificationClass } from "@lukestanbery/jarvis-protocol";

/** Notifications master switch: `false` interrupts nothing, `null`/absent = on. */
export const NOTIFY_ENABLED_PREF = "notify.enabled";

/** Quiet-hours window: `{ start, end }` in server-local time, `null` = off. */
export const NOTIFY_QUIET_HOURS_PREF = "notify.quietHours";

/** A quiet-hours window in the server's local time, `"HH:MM"` to `"HH:MM"`. */
export interface QuietHours {
    start: string;
    end: string;
}

/** The message a malformed `notify.enabled` write comes back with. */
const ENABLED_ERROR =
    "notify.enabled must be true, false, or null (null clears it)";

/** The message a malformed `notify.quietHours` write comes back with. */
const QUIET_HOURS_ERROR =
    'notify.quietHours must be { "start": "HH:MM", "end": "HH:MM" } or null for off';

/**
 * Parses a quiet-hours pref: `{ start: "22:00", end: "07:30" }`.
 *
 * Returns `null` for anything unrecognized — a malformed window must not
 * silence the user for the rest of the day, so the failure direction is
 * "no quiet hours".
 */
export function parseQuietHours(value: unknown): QuietHours | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const { start, end } = value as { start?: unknown; end?: unknown };
    if (!isClockTime(start) || !isClockTime(end)) {
        return null;
    }
    if (start === end) {
        // A zero-length window is meaningless; treat it as "not configured"
        // rather than as "always quiet".
        return null;
    }
    return { start, end };
}

/**
 * Validates a `notify.enabled` write: a boolean, or `null` to clear it back to
 * the default (on).
 */
/**
 * Whether `at` falls in the window, handling the wrap-past-midnight case.
 *
 * `22:00`–`07:00` is the common shape and spans midnight, so the comparison is
 * a wrap check (`at >= start || at < end`) when `start > end`, and a plain
 * range when it does not (`12:00`–`13:00`). Half-open: the end minute is
 * already outside, so a window that ends at `07:00` is over at `07:00`.
 */
export function withinQuietHours(window: QuietHours, at: Date): boolean {
    const minutes = at.getHours() * 60 + at.getMinutes();
    const start = clockMinutes(window.start);
    const end = clockMinutes(window.end);
    return start < end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
}

/** `"HH:MM"` → minutes past midnight. */
function clockMinutes(value: string): number {
    const [hours, minutes] = value.split(":");
    return Number(hours) * 60 + Number(minutes);
}

/**
 * When the window next closes at or after `at` — the instant a deferred
 * reminder should come back.
 *
 * Computed on the local wall clock, like the window itself: today's `end`, or
 * tomorrow's when today's has already passed (the normal case after midnight in
 * a wrapping window). Wall-clock rather than an instant offset so that an hour
 * of the day means the same thing across a DST change; a full calendar
 * (per-job timezones, DST-aware recurrence) is phase 8's problem, not this
 * one's.
 */
export function quietHoursEnd(window: QuietHours, at: Date): Date {
    const end = new Date(at);
    end.setHours(
        Math.floor(clockMinutes(window.end) / 60),
        clockMinutes(window.end) % 60,
        0,
        0,
    );
    if (end.getTime() <= at.getTime()) {
        end.setDate(end.getDate() + 1);
    }
    return end;
}

/**
 * Whether quiet hours hold a notification of `notificationClass` at `at`.
 *
 * The single answer, shared by the two readers of the policy: the notification
 * service (which suppresses the push) and the scheduler (which defers a
 * reminder to {@link quietHoursEnd}). A `timer` pierces — it is the class the
 * user chose for a moment they chose — and every other class waits.
 *
 * The **master switch** is deliberately not part of this question: it is a kill
 * switch rather than a quiet hour, and each caller checks it first, because the
 * two mean different things to the user ("not now" versus "nothing at all").
 */
export function quietHoursHold(
    prefs: Record<string, unknown>,
    notificationClass: NotificationClass,
    at: Date,
): boolean {
    if (notificationClass === "timer") {
        return false;
    }
    const window = parseQuietHours(prefs[NOTIFY_QUIET_HOURS_PREF]);
    return window !== null && withinQuietHours(window, at);
}

export function validateEnabledPref(value: unknown): string | null {
    if (value === null || typeof value === "boolean") {
        return null;
    }
    return ENABLED_ERROR;
}

/**
 * Validates a `notify.quietHours` write: a well-formed window, or `null` for
 * off. Extra keys are ignored, exactly as {@link parseQuietHours} ignores them,
 * so the check never rejects a value the delivery path would honour.
 */
export function validateQuietHoursPref(value: unknown): string | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return QUIET_HOURS_ERROR;
    }
    const { start, end } = value as { start?: unknown; end?: unknown };
    if (!isClockTime(start) || !isClockTime(end)) {
        return QUIET_HOURS_ERROR;
    }
    if (start === end) {
        return "notify.quietHours needs different start and end times; a zero-length window is never in effect";
    }
    return null;
}

/** True for a `"HH:MM"` 24-hour clock string. */
function isClockTime(value: unknown): value is string {
    return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
