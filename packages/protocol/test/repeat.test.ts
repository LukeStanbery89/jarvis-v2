/**
 * Recurrence-rule tests (#90 phase 8a).
 *
 * The rule engine is pure, so every decision it makes is asserted here rather
 * than discovered by a reminder not arriving: what "every 15 minutes" aligns to
 * and what an hour offline does to it, what a daily series does across a DST
 * change, what the 31st means in February, what "the 5th Monday" means in a
 * four-Monday month, and which rules are refused outright.
 *
 * Instants are built against a **synthetic US-Eastern zone** rather than the
 * machine's: the DST cases depend on a transition existing at a known time, and
 * a suite that only passes in America/Chicago is not a test. The zone mirrors
 * 2026's real rules — spring forward 8 March, fall back 1 November — so the
 * fixtures read like ordinary calendar facts.
 */
import { describe, expect, it } from "vitest";
import {
    describeRepeat,
    MAX_REPEAT_INTERVAL,
    nextOccurrence,
    parseJobRepeat,
    repeatExhausted,
    REPEAT_FREQUENCIES,
    WEEKDAYS,
} from "../src/repeat";
import type { JobRepeat, Zone } from "../src/repeat";

const HOUR_MS = 3_600_000;

/** 2026-03-08 07:00Z — 02:00 EST becomes 03:00 EDT. */
const SPRING_FORWARD = Date.UTC(2026, 2, 8, 7, 0);
/** 2026-11-01 06:00Z — 02:00 EDT becomes 01:00 EST. */
const FALL_BACK = Date.UTC(2026, 10, 1, 6, 0);

/** US Eastern, 2026 rules. */
const eastern: Zone = {
    offsetAt(utcMs: number): number {
        if (utcMs < SPRING_FORWARD) {
            return -5 * HOUR_MS;
        }
        return utcMs < FALL_BACK ? -4 * HOUR_MS : -5 * HOUR_MS;
    },
};

/** A wall clock in standard time (January, early March, November, December). */
function est(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
): Date {
    return new Date(Date.UTC(year, month, day, hour + 5, minute));
}

/** A wall clock in summer time (mid-March through October). */
function edt(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
): Date {
    return new Date(Date.UTC(year, month, day, hour + 4, minute));
}

/** The wall clock a zone reads at an instant, as `HH:MM`. */
function reads(zone: Zone, at: Date): string {
    const wall = new Date(at.getTime() + zone.offsetAt(at.getTime()));
    return `${String(wall.getUTCHours()).padStart(2, "0")}:${String(
        wall.getUTCMinutes(),
    ).padStart(2, "0")}`;
}

/** Parses a rule and fails loudly if the fixture is malformed. */
function rule(
    repeat: Partial<JobRepeat> & { every: JobRepeat["every"] },
): JobRepeat {
    const parsed = parseJobRepeat({ interval: 1, ...repeat });
    if (!parsed.ok) {
        throw new Error(`fixture rule is invalid: ${parsed.reason}`);
    }
    return parsed.repeat;
}

/** The next occurrence as an instant, failing on `ended`/`never`. */
function next(repeat: JobRepeat, now: Date): Date {
    const result = nextOccurrence(repeat, now, eastern);
    if (!result.ok) {
        throw new Error(`expected an occurrence, got ${result.reason}`);
    }
    return result.at;
}

describe("an interval frequency", () => {
    it("aligns every occurrence to the anchor, not to the last firing", () => {
        const every15 = rule({
            every: "minute",
            interval: 15,
            start: est(2026, 0, 5, 9, 7).toISOString(),
        });
        // :07/:22/:37/:52 — a run that took 20 minutes does not shift the grid.
        expect(next(every15, est(2026, 0, 5, 9, 20)).toISOString()).toBe(
            est(2026, 0, 5, 9, 22).toISOString(),
        );
        expect(next(every15, est(2026, 0, 5, 9, 52)).toISOString()).toBe(
            est(2026, 0, 5, 10, 7).toISOString(),
        );
    });

    it("resumes on the grid after an outage instead of firing a burst", () => {
        const every5 = rule({
            every: "minute",
            interval: 5,
            start: est(2026, 0, 5, 9, 0).toISOString(),
        });
        // An hour dark: twelve slots passed, and the next one is next, not now.
        expect(next(every5, est(2026, 0, 5, 10, 2)).toISOString()).toBe(
            est(2026, 0, 5, 10, 5).toISOString(),
        );
    });

    it("is strictly after now, and never before the anchor", () => {
        const everyHour = rule({
            every: "hour",
            interval: 2,
            start: est(2026, 0, 5, 8, 0).toISOString(),
        });
        expect(next(everyHour, est(2026, 0, 5, 11, 0)).toISOString()).toBe(
            est(2026, 0, 5, 12, 0).toISOString(),
        );
        expect(next(everyHour, est(2026, 0, 5, 7, 30)).toISOString()).toBe(
            est(2026, 0, 5, 8, 0).toISOString(),
        );
    });

    it("treats an hour as an hour, not as a time of day", () => {
        const daily = rule({
            every: "hour",
            interval: 24,
            start: est(2026, 2, 7, 12, 0).toISOString(),
        });
        // Across the spring-forward the interval stays exactly 24 hours, so the
        // local clock drifts to 13:00 — which is what "every 24 hours" asked for.
        const at = next(daily, est(2026, 2, 8, 10, 0));
        expect(at.getTime() - est(2026, 2, 7, 12, 0).getTime()).toBe(
            24 * HOUR_MS,
        );
        expect(reads(eastern, at)).toBe("13:00");
    });
});

describe("a daily frequency", () => {
    it("returns to its own clock time after a run moved", () => {
        const daily = rule({
            every: "day",
            start: est(2026, 0, 5, 9, 0).toISOString(),
        });
        // The rule has no `run_at` at all, so a snooze to 10:00 today cannot
        // move tomorrow — 09:00 is where the series lives.
        expect(next(daily, est(2026, 0, 5, 10, 0)).toISOString()).toBe(
            est(2026, 0, 6, 9, 0).toISOString(),
        );
    });

    it("keeps its wall clock across a DST change", () => {
        const daily = rule({
            every: "day",
            start: est(2026, 2, 6, 9, 0).toISOString(),
        });
        const at = next(daily, edt(2026, 2, 8, 10, 0));
        expect(reads(eastern, at)).toBe("09:00");
        expect(at.toISOString()).toBe(edt(2026, 2, 9, 9, 0).toISOString());
    });

    it("resolves a clock time the spring-forward swallowed to the moment it jumped to", () => {
        const daily = rule({
            every: "day",
            start: est(2026, 2, 7, 2, 30).toISOString(),
        });
        // 02:30 does not exist on 8 March 2026; 03:30 is when the clock reads
        // half past the hour it skipped.
        const at = next(daily, est(2026, 2, 7, 3, 0));
        expect(at.toISOString()).toBe("2026-03-08T07:30:00.000Z");
        expect(reads(eastern, at)).toBe("03:30");
    });

    it("fires once through the repeated hour, then the second instance", () => {
        const daily = rule({
            every: "day",
            start: edt(2026, 9, 31, 1, 30).toISOString(),
        });
        // 01:30 happens twice on 1 November: 05:30Z (EDT) and 06:30Z (EST).
        const beforeBoth = new Date(Date.UTC(2026, 10, 1, 4, 30));
        expect(next(daily, beforeBoth).toISOString()).toBe(
            "2026-11-01T05:30:00.000Z",
        );
        // Between them — the clock still reads 01:45 — the earlier one is not
        // "strictly after", and the real answer is the second 01:30.
        const between = new Date(Date.UTC(2026, 10, 1, 5, 45));
        expect(next(daily, between).toISOString()).toBe(
            "2026-11-01T06:30:00.000Z",
        );
    });

    it("steps every N days", () => {
        const every3 = rule({
            every: "day",
            interval: 3,
            start: est(2026, 0, 5, 9, 0).toISOString(),
        });
        expect(next(every3, est(2026, 0, 6, 9, 0)).toISOString()).toBe(
            est(2026, 0, 8, 9, 0).toISOString(),
        );
    });
});

describe("a weekly frequency", () => {
    // Monday 5 January 2026 — the anchor week's Monday.
    const monday = est(2026, 0, 5, 9, 0);

    it("walks the named days in calendar order within a week", () => {
        const monTueSat = rule({
            every: "week",
            start: monday.toISOString(),
            weekdays: ["mo", "tu", "sa"],
        });
        expect(next(monTueSat, est(2026, 0, 5, 10, 0)).toISOString()).toBe(
            est(2026, 0, 6, 9, 0).toISOString(),
        );
        expect(next(monTueSat, est(2026, 0, 8, 10, 0)).toISOString()).toBe(
            est(2026, 0, 10, 9, 0).toISOString(),
        );
        // Saturday is the last of the week; the next is Monday, a week's turn.
        expect(next(monTueSat, est(2026, 0, 10, 10, 0)).toISOString()).toBe(
            est(2026, 0, 12, 9, 0).toISOString(),
        );
    });

    it("skips the weeks between when the interval says so", () => {
        const fortnightly = rule({
            every: "week",
            interval: 2,
            start: monday.toISOString(),
            weekdays: ["mo"],
        });
        // 12 January is an off week: the series is 5, 19, 2 February.
        expect(next(fortnightly, est(2026, 0, 12, 12, 0)).toISOString()).toBe(
            est(2026, 0, 19, 9, 0).toISOString(),
        );
    });

    it("does weekdays", () => {
        const weekdays = rule({
            every: "week",
            start: monday.toISOString(),
            weekdays: ["mo", "tu", "we", "th", "fr"],
        });
        // A Saturday gets Monday; a Friday gets the following Monday.
        expect(next(weekdays, est(2026, 0, 10, 12, 0)).toISOString()).toBe(
            est(2026, 0, 12, 9, 0).toISOString(),
        );
        expect(next(weekdays, est(2026, 0, 16, 12, 0)).toISOString()).toBe(
            est(2026, 0, 19, 9, 0).toISOString(),
        );
    });
});

describe("a monthly frequency", () => {
    it("fires on a day of the month", () => {
        const first = rule({
            every: "month",
            start: est(2026, 0, 1, 9, 0).toISOString(),
            monthDays: [1],
        });
        expect(next(first, est(2026, 0, 1, 10, 0)).toISOString()).toBe(
            est(2026, 1, 1, 9, 0).toISOString(),
        );
    });

    it("clamps a day the month does not have to its last day", () => {
        const thirtyFirst = rule({
            every: "month",
            start: est(2026, 0, 31, 9, 0).toISOString(),
            monthDays: [31],
        });
        // February 2026 has 28 days, so "the 31st" is the 28th — and March
        // returns to the 31st, because the rule did not change.
        expect(next(thirtyFirst, est(2026, 0, 31, 10, 0)).toISOString()).toBe(
            est(2026, 1, 28, 9, 0).toISOString(),
        );
        expect(next(thirtyFirst, est(2026, 1, 28, 10, 0)).toISOString()).toBe(
            edt(2026, 2, 31, 9, 0).toISOString(),
        );
    });

    it("takes a negative day as counting back from the end", () => {
        const last = rule({
            every: "month",
            start: est(2026, 0, 31, 9, 0).toISOString(),
            monthDays: [-1],
        });
        expect(next(last, est(2026, 0, 31, 10, 0)).toISOString()).toBe(
            est(2026, 1, 28, 9, 0).toISOString(),
        );
        // April's last day is the 30th, not the 31st.
        expect(next(last, edt(2026, 2, 31, 10, 0)).toISOString()).toBe(
            edt(2026, 3, 30, 9, 0).toISOString(),
        );
    });

    it("fires on an ordinal weekday", () => {
        // Tuesday 13 January 2026 is the month's second Tuesday.
        const secondTuesday = rule({
            every: "month",
            start: est(2026, 0, 13, 9, 0).toISOString(),
            weekOrdinals: ["2tu"],
        });
        expect(next(secondTuesday, est(2026, 0, 13, 10, 0)).toISOString()).toBe(
            est(2026, 1, 10, 9, 0).toISOString(),
        );

        // The last Friday of January 2026 is the 30th (the 31st is a Saturday).
        const lastFriday = rule({
            every: "month",
            start: est(2026, 0, 30, 9, 0).toISOString(),
            weekOrdinals: ["-1fr"],
        });
        expect(next(lastFriday, est(2026, 0, 30, 10, 0)).toISOString()).toBe(
            est(2026, 1, 27, 9, 0).toISOString(),
        );
    });

    it("skips the months a seldom-occurring ordinal is absent from", () => {
        const fifthMonday = rule({
            every: "month",
            start: est(2026, 0, 26, 9, 0).toISOString(),
            weekOrdinals: ["5mo"],
        });
        // January 2026 holds four Mondays and February cannot hold five, so the
        // next is Monday 30 March — the tier that stays literal and says when.
        expect(next(fifthMonday, est(2026, 0, 26, 10, 0)).toISOString()).toBe(
            edt(2026, 2, 30, 9, 0).toISOString(),
        );
    });

    it("takes weekday and month-day sets as a union", () => {
        const mondaysAndFirst = rule({
            every: "month",
            start: est(2026, 0, 1, 9, 0).toISOString(),
            weekdays: ["mo"],
            monthDays: [1],
        });
        // January 2026: the 1st is a Thursday, and the Mondays are 5/12/19/26.
        expect(
            next(mondaysAndFirst, est(2025, 11, 20, 12, 0)).toISOString(),
        ).toBe(est(2026, 0, 1, 9, 0).toISOString());
        expect(
            next(mondaysAndFirst, est(2026, 0, 2, 12, 0)).toISOString(),
        ).toBe(est(2026, 0, 5, 9, 0).toISOString());
        expect(
            next(mondaysAndFirst, est(2026, 0, 26, 12, 0)).toISOString(),
        ).toBe(est(2026, 1, 1, 9, 0).toISOString());
    });

    it("steps months from the anchor month, not from the last firing", () => {
        const quarterly = rule({
            every: "month",
            interval: 3,
            start: est(2026, 0, 15, 9, 0).toISOString(),
            monthDays: [15],
        });
        expect(next(quarterly, est(2026, 0, 15, 10, 0)).toISOString()).toBe(
            edt(2026, 3, 15, 9, 0).toISOString(),
        );
        expect(next(quarterly, edt(2026, 3, 15, 10, 0)).toISOString()).toBe(
            edt(2026, 6, 15, 9, 0).toISOString(),
        );
    });
});

describe("ends", () => {
    it("stops at a wall-clock end", () => {
        const daily = rule({
            every: "day",
            start: est(2026, 0, 5, 9, 0).toISOString(),
            ends: { until: est(2026, 0, 8, 9, 0).toISOString() },
        });
        expect(next(daily, est(2026, 0, 7, 10, 0)).toISOString()).toBe(
            est(2026, 0, 8, 9, 0).toISOString(),
        );
        const ended = nextOccurrence(daily, est(2026, 0, 8, 10, 0), eastern);
        expect(ended).toEqual({ ok: false, reason: "ended" });
    });

    it("counts firings rather than calendar windows", () => {
        const after3 = rule({
            every: "day",
            start: est(2026, 0, 5, 9, 0).toISOString(),
            ends: { after: 3 },
        });
        expect(repeatExhausted(after3, 0)).toBe(false);
        expect(repeatExhausted(after3, 2)).toBe(false);
        expect(repeatExhausted(after3, 3)).toBe(true);
        // No `ends` at all means "until cancelled".
        expect(
            repeatExhausted(
                rule({
                    every: "day",
                    start: est(2026, 0, 5, 9, 0).toISOString(),
                }),
                500,
            ),
        ).toBe(false);
    });
});

describe("describeRepeat (#90 phase 8d)", () => {
    // Built in local time, so the phrase's clock is the fixture's own.
    const at9 = new Date(2026, 0, 5, 9, 0).toISOString();

    it("says an interval", () => {
        expect(
            describeRepeat(rule({ every: "minute", interval: 15, start: at9 })),
        ).toBe("every 15 minutes");
        expect(
            describeRepeat(rule({ every: "hour", interval: 2, start: at9 })),
        ).toBe("every 2 hours");
        expect(describeRepeat(rule({ every: "day", start: at9 }))).toBe(
            "every day at 09:00",
        );
        expect(
            describeRepeat(rule({ every: "day", interval: 3, start: at9 })),
        ).toBe("every 3 days at 09:00");
    });

    it("says a weekly set, and calls Monday to Friday a weekday", () => {
        expect(
            describeRepeat(
                rule({
                    every: "week",
                    start: at9,
                    weekdays: ["mo", "tu", "sa"],
                }),
            ),
        ).toBe("every Monday, Tuesday and Saturday at 09:00");
        expect(
            describeRepeat(
                rule({
                    every: "week",
                    start: at9,
                    weekdays: ["mo", "tu", "we", "th", "fr"],
                }),
            ),
        ).toBe("every weekday at 09:00");
        expect(
            describeRepeat(
                rule({
                    every: "week",
                    interval: 2,
                    start: at9,
                    weekdays: ["mo"],
                }),
            ),
        ).toBe("every 2 weeks on Monday at 09:00");
    });

    it("says a monthly day, ordinal, end or cadence", () => {
        expect(
            describeRepeat(
                rule({ every: "month", start: at9, monthDays: [1] }),
            ),
        ).toBe("on the 1st of every month at 09:00");
        expect(
            describeRepeat(
                rule({ every: "month", start: at9, monthDays: [1, 15] }),
            ),
        ).toBe("on the 1st and 15th of every month at 09:00");
        expect(
            describeRepeat(
                rule({ every: "month", start: at9, monthDays: [-1] }),
            ),
        ).toBe("on the last day of every month at 09:00");
        expect(
            describeRepeat(
                rule({ every: "month", start: at9, weekOrdinals: ["2tu"] }),
            ),
        ).toBe("on the second Tuesday of every month at 09:00");
        expect(
            describeRepeat(
                rule({ every: "month", start: at9, weekOrdinals: ["-1fr"] }),
            ),
        ).toBe("on the last Friday of every month at 09:00");
        expect(
            describeRepeat(
                rule({
                    every: "month",
                    interval: 3,
                    start: at9,
                    monthDays: [15],
                }),
            ),
        ).toBe("every 3 months on the 15th at 09:00");
    });

    it("reads a union as both halves, and a weekday-only month as itself", () => {
        expect(
            describeRepeat(
                rule({
                    every: "month",
                    start: at9,
                    weekdays: ["mo"],
                    monthDays: [1],
                }),
            ),
        ).toBe("on the 1st and every Monday of every month at 09:00");
        expect(
            describeRepeat(
                rule({ every: "month", start: at9, weekdays: ["mo"] }),
            ),
        ).toBe("every Monday of every month at 09:00");
    });
});

describe("parseJobRepeat", () => {
    it("accepts the whole vocabulary and normalizes what changes nothing", () => {
        const parsed = parseJobRepeat({
            every: "week",
            interval: 2,
            start: est(2026, 0, 5, 9, 0).toISOString(),
            weekdays: ["sa", "mo", "mo"],
        });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(parsed.repeat.weekdays).toEqual(["mo", "sa"]);
        // Idempotent: parsing a normalized rule yields the same rule.
        expect(parseJobRepeat(parsed.repeat)).toEqual(parsed);
    });

    it("refuses days that can never exist, naming what it can do instead", () => {
        const start = est(2026, 0, 5, 9, 0).toISOString();
        const impossible: unknown[] = [
            { every: "month", interval: 1, start, monthDays: [32] },
            { every: "month", interval: 1, start, monthDays: [-32] },
            { every: "month", interval: 1, start, monthDays: [0] },
            { every: "month", interval: 1, start, weekOrdinals: ["6mo"] },
            { every: "month", interval: 1, start, weekOrdinals: ["0mo"] },
            { every: "month", interval: 1, start, weekOrdinals: ["2xx"] },
            { every: "month", interval: 1, start, weekOrdinals: ["5"] },
        ];
        for (const candidate of impossible) {
            const parsed = parseJobRepeat(candidate);
            expect(parsed.ok, JSON.stringify(candidate)).toBe(false);
        }
    });

    it("refuses mixes that would need a reading it does not have", () => {
        const start = est(2026, 0, 5, 9, 0).toISOString();
        const refusals: unknown[] = [
            // Days belong to a calendar frequency.
            { every: "minute", interval: 5, start, weekdays: ["mo"] },
            { every: "hour", interval: 2, start, monthDays: [1] },
            // A month day needs month stepping, which "week" does not have.
            { every: "week", interval: 1, start, monthDays: [1] },
            { every: "week", interval: 1, start, weekOrdinals: ["2tu"] },
            { every: "day", interval: 1, start, weekdays: ["mo"] },
        ];
        for (const candidate of refusals) {
            const parsed = parseJobRepeat(candidate);
            expect(parsed.ok, JSON.stringify(candidate)).toBe(false);
            if (!parsed.ok) {
                expect(parsed.reason.length).toBeGreaterThan(0);
            }
        }
    });

    it("refuses shapes that are not rules at all", () => {
        const start = est(2026, 0, 5, 9, 0).toISOString();
        const bad: unknown[] = [
            null,
            "every day",
            [],
            { every: "fortnight", interval: 1, start },
            { every: "day", interval: 0, start },
            { every: "day", interval: 1.5, start },
            { every: "day", interval: MAX_REPEAT_INTERVAL + 1, start },
            { every: "day", interval: 1, start: "tomorrow" },
            { every: "day", interval: 1, start, weekdays: [] },
            { every: "day", interval: 1, start, extra: true },
            { every: "day", interval: 1, start, ends: {} },
            {
                every: "day",
                interval: 1,
                start,
                ends: { after: 2, until: start },
            },
            { every: "day", interval: 1, start, ends: { after: 0 } },
            { every: "day", interval: 1, start, ends: { until: start } },
            { every: "day", interval: 1, start, ends: { until: "not a time" } },
        ];
        for (const candidate of bad) {
            const parsed = parseJobRepeat(candidate);
            expect(parsed.ok, JSON.stringify(candidate)).toBe(false);
        }
    });

    it("exposes the tuples it validates against", () => {
        expect(REPEAT_FREQUENCIES).toContain("month");
        expect(WEEKDAYS).toEqual(["su", "mo", "tu", "we", "th", "fr", "sa"]);
    });
});
