/**
 * Clock and span tests (#90 phase 6b).
 *
 * These formatters are hand-rolled so the assertions can be exact: no locale, no
 * timezone database, no `Intl`. Every instant here is built with the local `Date`
 * constructor for the same reason — the module renders local time, so a test
 * written in UTC would be asserting something the app never shows.
 */
import { describe, expect, it } from "vitest";
import { clockText, describeSpan, formatDate, weekdayText } from "./clock";

describe("clockText", () => {
    it("renders a 12-hour clock with a zero-padded minute", () => {
        expect(clockText(new Date(2026, 9, 17, 8, 7))).toBe("8:07 AM");
        expect(clockText(new Date(2026, 9, 17, 14, 30))).toBe("2:30 PM");
    });

    it("calls midnight 12 AM and noon 12 PM", () => {
        // The two cases a naive `hours % 12` gets wrong.
        expect(clockText(new Date(2026, 9, 17, 0, 0))).toBe("12:00 AM");
        expect(clockText(new Date(2026, 9, 17, 12, 0))).toBe("12:00 PM");
    });
});

describe("formatDate", () => {
    it("names the weekday, day and month", () => {
        expect(formatDate(new Date(2026, 9, 17))).toBe("Saturday, 17 October");
    });
});

describe("weekdayText", () => {
    it("names the day alone", () => {
        expect(weekdayText(new Date(2026, 9, 17))).toBe("Saturday");
        expect(weekdayText(new Date(2026, 9, 18))).toBe("Sunday");
    });
});

describe("describeSpan", () => {
    it("uses minutes under an hour", () => {
        expect(describeSpan(60_000)).toBe("1 minute");
        expect(describeSpan(4 * 60_000)).toBe("4 minutes");
    });

    it("uses hours up to a day and a half", () => {
        expect(describeSpan(90 * 60_000)).toBe("1 hour");
        expect(describeSpan(20 * 60 * 60_000)).toBe("20 hours");
    });

    it("uses days beyond that", () => {
        expect(describeSpan(48 * 60 * 60_000)).toBe("2 days");
    });

    it("ignores the sign, because the caller supplies the preposition", () => {
        // "in 3 minutes" and "3 minutes ago" are the same span.
        expect(describeSpan(-3 * 60_000)).toBe("3 minutes");
        expect(describeSpan(3 * 60_000)).toBe("3 minutes");
    });

    it("rounds down, so it never claims more time than has passed", () => {
        expect(describeSpan(59_000)).toBe("0 minutes");
        expect(describeSpan(119_000)).toBe("1 minute");
    });
});
