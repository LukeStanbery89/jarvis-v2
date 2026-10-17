/**
 * Tests for the wall-clock resolver (#90 phase 3).
 *
 * Every instant is built from LOCAL fields and asserted on LOCAL fields, so the
 * suite means the same thing in every timezone — the resolver's contract is the
 * server's local clock, not a UTC offset. The fixture moment is deliberately a
 * known weekday (Thursday 2026-01-01 19:05) so weekday cases read as sentences.
 */
import { describe, expect, it } from "vitest";
import { resolveWhen, type WhenInput } from "../src/scheduler/time";

/** A local instant, e.g. `at(2026, 1, 1, 19, 5)`. */
function at(
    year: number,
    month: number,
    day: number,
    hours: number,
    minutes: number,
    seconds = 0,
): Date {
    return new Date(year, month - 1, day, hours, minutes, seconds, 0);
}

/** `[year, month, day, hours, minutes]` of a resolved instant. */
function fields(date: Date): [number, number, number, number, number] {
    return [
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
    ];
}

/** Thursday 2026-01-01 19:05 local — the "now" for most cases. */
const NOW = at(2026, 1, 1, 19, 5);

/** The instant a successful resolve produced, failing loudly otherwise. */
function resolved(input: WhenInput, now: Date = NOW): Date {
    const result = resolveWhen(input, now);
    if (!result.ok) {
        throw new Error(`expected a resolution, got: ${result.reason}`);
    }
    return result.at;
}

/** The reason a refused input produced, failing loudly otherwise. */
function refused(input: WhenInput, now: Date = NOW): string {
    const result = resolveWhen(input, now);
    if (result.ok) {
        throw new Error(`expected a refusal, got ${result.at.toISOString()}`);
    }
    return result.reason;
}

describe("resolveWhen: delays", () => {
    it("adds minutes to now", () => {
        expect(resolved({ inMinutes: 10 }).getTime()).toBe(
            NOW.getTime() + 600_000,
        );
    });

    it("accepts a fractional minute as seconds", () => {
        expect(resolved({ inMinutes: 0.5 }).getTime()).toBe(
            NOW.getTime() + 30_000,
        );
    });

    it("refuses a delay that is not a positive finite number", () => {
        for (const inMinutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(refused({ inMinutes })).toMatch(
                /positive number of minutes/,
            );
        }
    });
});

describe("resolveWhen: clock times", () => {
    it("takes today when the clock time is still ahead", () => {
        expect(fields(resolved({ at: "20:30" }))).toEqual([2026, 1, 1, 20, 30]);
    });

    it("takes tomorrow when today's clock time has passed", () => {
        expect(fields(resolved({ at: "08:00" }))).toEqual([2026, 1, 2, 8, 0]);
    });

    it("keeps a clock time that passed seconds ago — it is still tonight", () => {
        // "Remind me at 7:05" said at 19:05:30: the model's answer and the
        // tool's execution are a moment apart, not a day.
        const now = at(2026, 1, 1, 19, 5, 30);
        expect(fields(resolved({ at: "19:05" }, now))).toEqual([
            2026, 1, 1, 19, 5,
        ]);
    });

    it("accepts a single-digit hour and surrounding space", () => {
        expect(fields(resolved({ at: " 8:05 " }))).toEqual([2026, 1, 2, 8, 5]);
    });

    it("refuses anything that is not a 24-hour clock time", () => {
        for (const at of ["8", "8:5", "25:00", "12:60", "8:00 pm", ""]) {
            expect(refused({ at })).toMatch(/24-hour clock time/);
        }
    });
});

describe("resolveWhen: clock time on a day", () => {
    it("uses tomorrow", () => {
        expect(fields(resolved({ at: "08:00", onDate: "tomorrow" }))).toEqual([
            2026, 1, 2, 8, 0,
        ]);
    });

    it("uses a calendar date", () => {
        expect(fields(resolved({ at: "08:00", onDate: "2026-03-01" }))).toEqual(
            [2026, 3, 1, 8, 0],
        );
    });

    it("refuses a date that has already passed", () => {
        expect(refused({ at: "08:00", onDate: "2025-12-31" })).toMatch(
            /already passed/,
        );
    });

    it("refuses today at a time that has gone", () => {
        // An explicit day is explicit intent: shifting it to tomorrow would
        // silently answer a different request than the one made.
        expect(refused({ at: "08:00", onDate: "today" })).toMatch(
            /already passed/,
        );
    });

    it("refuses an impossible calendar date rather than rolling it over", () => {
        expect(refused({ at: "08:00", onDate: "2026-02-30" })).toMatch(
            /onDate/,
        );
    });

    it("refuses a date shape it does not understand", () => {
        for (const onDate of ["2026/03/01", "march 1", "", "someday"]) {
            expect(refused({ at: "08:00", onDate })).toMatch(/onDate/);
        }
    });
});

describe("resolveWhen: weekdays", () => {
    it("takes the next occurrence of that weekday", () => {
        expect(fields(resolved({ at: "08:00", onDate: "friday" }))).toEqual([
            2026, 1, 2, 8, 0,
        ]);
    });

    it("accepts an unambiguous abbreviation", () => {
        expect(fields(resolved({ at: "08:00", onDate: "fri" }))).toEqual([
            2026, 1, 2, 8, 0,
        ]);
    });

    it("uses today when the clock time is still ahead on that day", () => {
        expect(fields(resolved({ at: "20:00", onDate: "thursday" }))).toEqual([
            2026, 1, 1, 20, 0,
        ]);
    });

    it("rolls a week forward when today's clock time has passed", () => {
        // "Thursday at 6" said Thursday at 7pm means next Thursday, not a
        // refusal — a weekday recurs, unlike a calendar date.
        expect(fields(resolved({ at: "18:00", onDate: "thursday" }))).toEqual([
            2026, 1, 8, 18, 0,
        ]);
    });

    it("refuses a fragment too short to name one day", () => {
        expect(refused({ at: "08:00", onDate: "th" })).toMatch(/onDate/);
    });
});

describe("resolveWhen: shape", () => {
    it("refuses when no time was given", () => {
        expect(refused({})).toMatch(/no time was given/);
    });

    it("refuses a delay together with a clock time or a day", () => {
        expect(refused({ inMinutes: 5, at: "08:00" })).toMatch(/not both/);
        expect(refused({ inMinutes: 5, onDate: "tomorrow" })).toMatch(
            /not both/,
        );
    });

    it("refuses a day with no time of day", () => {
        expect(refused({ onDate: "tomorrow" })).toMatch(/needs a time of day/);
    });
});
