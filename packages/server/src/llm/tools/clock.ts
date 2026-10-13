/**
 * Shared 12-hour clock formatting for the time and weather tools.
 *
 * Two callers need the same `h:mm AM/PM` shape from different sources:
 * `time.ts` renders the server's wall clock for `getCurrentTime`, and
 * `getWeather.ts` renders the observed conditions' wall clock at the reported
 * city. Rather than duplicate the hour/meridiem/padding arithmetic, both build
 * their located hours/minutes and hand them here.
 *
 * Pure and exported. Callers pass already-located hours (0–23) and minutes
 * (0–59); this does no timezone work of its own.
 */
export function format12Hour(hours: number, minutes: number): string {
    const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const meridiem = hours < 12 ? "AM" : "PM";
    return `${hour12}:${String(minutes).padStart(2, "0")} ${meridiem}`;
}
