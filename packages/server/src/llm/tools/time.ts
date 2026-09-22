/**
 * Returns the current date and time in the machine's local time.
 *
 * The LLM has no other way to know "now", so this is its clock. Deliberately
 * non-deterministic. Since the server runs on the user's own machine (LAN
 * posture), "local" is the process's local timezone: the output is the local
 * wall-clock with an explicit UTC offset (`2026-09-22T14:30:00+02:00`) so the
 * model can reason about timezones without guesswork.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const getCurrentTime = tool(async () => localClock(), {
    name: "getCurrentTime",
    description:
        "Returns the current date and time in the machine's local time, " +
        "e.g. 2026-09-22T14:30:00 UTC+02:00 (local wall-clock with the " +
        "offset). Use when asked what time it is or what today's date is.",
    schema: z.object({}),
});

/**
 * Formats `now` as local wall-clock with its UTC offset.
 *
 * The offset is derived from `getTimezoneOffset()` (minutes east of UTC,
 * negated by the Date API), formatted like the final `+02:00` of an ISO 8601
 * local timestamp while the wall-clock part is assembled from local getters so
 * it matches what the user sees on their clock.
 */
export function localClock(now: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const wall = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
        now.getDate(),
    )}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
        now.getSeconds(),
    )}`;
    return `${wall} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
