/**
 * Returns the facet of the current local time the user actually asked about.
 *
 * The LLM has no other way to know "now", so this is its clock. Deliberately
 * non-deterministic. Since the server runs on the user's own machine (LAN
 * posture), "local" is the process's local timezone. The answer is pared to
 * the ask — time, date, weekday, or the full "what day is it?" — so a small
 * local model hands back a terse, useful value instead of a wall of text.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const getCurrentTime = tool(
    async ({ question }) => localClock(question),
    {
        name: "getCurrentTime",
        description:
            "Returns the current local time, tailed to what the user asked: " +
            "the time alone (e.g. 9:15 PM), the date alone (e.g. June 15, " +
            "2026), the weekday alone (e.g. Monday), or weekday + date for a " +
            "'what day is it?' ask (e.g. Monday, June 15, 2026). Pass the " +
            "user's question verbatim in `question` so the right facet is " +
            "returned.",
        schema: z.object({
            question: z
                .string()
                .describe(
                    "The user's question verbatim, e.g. 'What time is it?'",
                ),
        }),
    },
);

/**
 * Which facet of "now" {@link getCurrentTime} should report, derived from the
 * user's question: `time` (hour:minute AM/PM), `date` (Month day, year),
 * `weekday` (day of the week alone), or `full` (weekday + date for "what day
 * is it?"). Unknown phrasing falls back to `full`, the most informative form.
 */
export type ClockFacet = "time" | "date" | "weekday" | "full";

/** Maps a user question to the {@link ClockFacet} it is asking about. */
export function clockFacet(question: string): ClockFacet {
    const q = question.toLowerCase();
    if (/(day of the week|weekday)/.test(q)) {
        return "weekday";
    }
    if (/\btime\b|clock/.test(q)) {
        return "time";
    }
    if (/\bdate\b|calendar/.test(q)) {
        return "date";
    }
    if (/\bday\b|today/.test(q)) {
        return "full";
    }
    return "full";
}

/**
 * Formats `now` for the facet of the current local time `question` asks about.
 *
 * Everything comes from local Date getters on `now` (defaults to the current
 * instant): the wall-clock is 12-hour with an AM/PM suffix and no seconds
 * (`9:15 PM`), the date is `Month day, year` (`June 15, 2026`), the weekday is
 * the day alone (`Monday`), and the full form is `Monday, June 15, 2026`.
 */
export function localClock(question: string, now: Date = new Date()): string {
    const facet = clockFacet(question);
    const pad = (n: number) => String(n).padStart(2, "0");
    const hours = now.getHours();
    const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const meridiem = hours < 12 ? "AM" : "PM";
    const weekday = WEEKDAYS[now.getDay()];
    const month = MONTHS[now.getMonth()];
    const date = `${month} ${now.getDate()}, ${now.getFullYear()}`;
    switch (facet) {
        case "time":
            return `${hour12}:${pad(now.getMinutes())} ${meridiem}`;
        case "date":
            return date;
        case "weekday":
            return weekday;
        case "full":
            return `${weekday}, ${date}`;
    }
}

/** English weekday names for {@link localClock}'s weekday/full facets. */
const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/** English month names for {@link localClock}'s date/full facets. */
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
];
