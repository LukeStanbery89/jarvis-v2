/**
 * Preference helpers (pure) — the web client's half of the settings panel.
 *
 * The panel edits two kinds of setting, and they are stored in two different
 * places on purpose:
 *
 * - **Your account** — `notify.enabled` and `notify.quietHours`, read and
 *   written through `GET`/`PUT /api/prefs` (see `api.ts`). They are routing
 *   decisions the *server* makes, so they must hold on every device.
 * - **This browser** — desktop notifications, wake word, location sharing.
 *   Those live in `localStorage` (see `browserNotify.ts`, `voice.ts`,
 *   `location.ts`): a browser's permission and a microphone are per-device
 *   facts, and syncing them would be a lie.
 *
 * The rules live here, as pure functions, for the same reason `threads.ts`,
 * `sidebar.ts`, and `notifications.ts` do: `hooks/usePrefs.ts` stays a thin
 * state shell and the behaviour that matters (reading a stored value the way
 * the server does, and writing one it will accept) is unit-testable without a
 * DOM.
 *
 * The key strings are mirrored from `packages/server/src/notify/prefs.ts`.
 * That mirror cannot drift silently: the server validates known keys on write,
 * so a renamed or reshaped key comes back as a 400 rather than a setting that
 * appears to save and does nothing.
 */
import type { Prefs } from "./api";

/** Notifications master switch. Mirrors the server's `NOTIFY_ENABLED_PREF`. */
export const NOTIFY_ENABLED_PREF = "notify.enabled";

/** Quiet-hours window. Mirrors the server's `NOTIFY_QUIET_HOURS_PREF`. */
export const NOTIFY_QUIET_HOURS_PREF = "notify.quietHours";

/** A quiet-hours window in the server's local time, `"HH:MM"` to `"HH:MM"`. */
export interface QuietHours {
    start: string;
    end: string;
}

/**
 * How one stored preference reads.
 *
 * `value` is always **what the server would do** with the stored bytes, which
 * is what the panel must show. `unreadable` flags that those bytes are not a
 * value we can render as controls — a malformed pref is ignored rather than
 * fatal server-side, so the honest rendering is "not in effect, and here is
 * why", never a crash and never the default presented as though nothing were
 * stored (which would hide a write that went wrong).
 *
 * An absent key is `unreadable: false`: it reads as the documented default.
 */
export interface PrefReading<T> {
    value: T;
    unreadable: boolean;
}

/**
 * Reads the notifications master switch.
 *
 * The server honours exactly one value — a literal `false` — and treats
 * everything else as "on" (`service.ts` `suppressionFor`), so this mirrors
 * that: absent and `null` (= "no restriction set") are on. Any other stored
 * value still reads as on, because that is what actually happens, but is
 * flagged `unreadable`.
 */
export function readNotificationsEnabled(prefs: Prefs): PrefReading<boolean> {
    const stored = prefs[NOTIFY_ENABLED_PREF];
    if (
        stored === undefined ||
        stored === null ||
        typeof stored === "boolean"
    ) {
        return { value: stored !== false, unreadable: false };
    }
    return { value: true, unreadable: true };
}

/**
 * Reads the quiet-hours window the server would apply.
 *
 * `null` means "no quiet hours" and covers the absent key, an explicit `null`
 * (the off value the panel writes), and a window that is present but
 * meaningless (a zero-length window, which the server refuses to treat as
 * "always quiet"). The last of those is flagged `unreadable`, since the user's
 * stored intent was not honoured.
 */
export function readQuietHours(prefs: Prefs): PrefReading<QuietHours | null> {
    const stored = prefs[NOTIFY_QUIET_HOURS_PREF];
    if (stored === undefined || stored === null) {
        return { value: null, unreadable: false };
    }
    const window = asQuietHours(stored);
    if (window === null) {
        return { value: null, unreadable: true };
    }
    return { value: window, unreadable: false };
}

/**
 * Quiet hours as a sentence for the panel: the window, "off", or the reason a
 * stored value was ignored.
 */
export function describeQuietHours(
    reading: PrefReading<QuietHours | null>,
): string {
    if (reading.unreadable) {
        return "not in effect — the stored value is not a readable time window";
    }
    if (reading.value === null) {
        return "off";
    }
    return `${reading.value.start} → ${reading.value.end}`;
}

/**
 * Validates a window the user typed, before it is sent.
 *
 * Returns a message to show beside the fields, or `null` when the window is
 * one the server will accept. The same shape and the same zero-length refusal
 * the server enforces (`notify/prefs.ts`), so a failed write is a surprise
 * rather than the expected outcome of an accepted input.
 */
export function validateQuietHours(start: string, end: string): string | null {
    if (!isClockTime(start) || !isClockTime(end)) {
        return "Use 24-hour times, like 22:00 or 07:30.";
    }
    if (start === end) {
        return "Start and end must differ — a zero-length window is never in effect.";
    }
    return null;
}

/** True for a `"HH:MM"` 24-hour clock string. Mirrors the server's check. */
export function isClockTime(value: string): boolean {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** The patch that sets the notifications master switch. */
export function notificationsEnabledPatch(enabled: boolean): Prefs {
    return { [NOTIFY_ENABLED_PREF]: enabled };
}

/**
 * The patch that sets quiet hours: a window, or `null` to turn them off.
 *
 * `null` is the documented off value — writing the key rather than removing it
 * keeps the panel from ever reaching for `DELETE /api/prefs`, which would clear
 * every pref on the account.
 */
export function quietHoursPatch(hours: QuietHours | null): Prefs {
    return { [NOTIFY_QUIET_HOURS_PREF]: hours };
}

/**
 * A stored value as a quiet-hours window, or `null` when it is not one.
 *
 * Deliberately as strict as the server's `parseQuietHours` and no stricter:
 * anything the server would ignore must read as `null` here, so the panel shows
 * what the system does rather than what the bytes say.
 */
function asQuietHours(value: unknown): QuietHours | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const { start, end } = value as { start?: unknown; end?: unknown };
    if (
        typeof start !== "string" ||
        typeof end !== "string" ||
        !isClockTime(start) ||
        !isClockTime(end) ||
        start === end
    ) {
        return null;
    }
    return { start, end };
}
