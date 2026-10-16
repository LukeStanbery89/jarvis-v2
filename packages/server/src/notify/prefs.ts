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
 */

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
