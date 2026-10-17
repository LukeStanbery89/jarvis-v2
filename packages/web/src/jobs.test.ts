/**
 * Jobs-list tests (#90 phases 6b–6c).
 *
 * The pages' lists are small enough to be pure, so their decisions are asserted
 * here rather than eyeballed in a browser: which rows are shown and in what order
 * (a class filter that bounds the list before filtering it would hand the Timers
 * page four timers because a reminder filled the cut), what "when" reads like at
 * the boundaries (inside the hour, later today, tomorrow, next week, a moment
 * already past), and what a snoozed row can honestly say about its moment.
 *
 * Instants are built with the local `Date` constructor: the module renders local
 * time, so a UTC fixture would be asserting something the user never sees.
 */
import { describe, expect, it } from "vitest";
import {
    describeMoment,
    describeRunAt,
    describeSnooze,
    snoozeUntil,
    SNOOZE_PRESETS,
    upcomingJobs,
} from "./jobs";
import type { Job } from "./api";

/** A job with everything the list needs, overridable per test. */
function job(overrides: Partial<Job>): Job {
    return {
        id: "job-1",
        label: "Kettle",
        class: "timer",
        kind: "message",
        state: "pending",
        runAt: new Date(2026, 9, 17, 12, 0).toISOString(),
        attempts: 0,
        createdAt: new Date(2026, 9, 17, 11, 0).toISOString(),
        ...overrides,
    };
}

describe("upcomingJobs", () => {
    it("keeps what is owed and drops what already happened", () => {
        const rows = upcomingJobs(
            [
                job({ id: "a", state: "pending" }),
                job({ id: "b", state: "running" }),
                job({ id: "c", state: "done" }),
                job({ id: "d", state: "failed" }),
                job({ id: "e", state: "cancelled" }),
                job({ id: "f", state: "missed" }),
            ],
            { limit: 10 },
        );
        expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    });

    it("orders by the moment that is coming", () => {
        // The server answers newest-created first, which is not the order a
        // "what is next" list wants.
        const rows = upcomingJobs(
            [
                job({
                    id: "later",
                    runAt: new Date(2026, 9, 17, 18, 0).toISOString(),
                }),
                job({
                    id: "next",
                    runAt: new Date(2026, 9, 17, 12, 30).toISOString(),
                }),
                job({
                    id: "sooner",
                    runAt: new Date(2026, 9, 17, 12, 5).toISOString(),
                }),
            ],
            { limit: 10 },
        );
        expect(rows.map((row) => row.id)).toEqual(["sooner", "next", "later"]);
    });

    it("keeps only the first `limit` rows", () => {
        const rows = upcomingJobs(
            [1, 2, 3, 4].map((hour) =>
                job({
                    id: `at-${hour}`,
                    runAt: new Date(2026, 9, 17, hour + 12, 0).toISOString(),
                }),
            ),
            { limit: 2 },
        );
        expect(rows.map((row) => row.id)).toEqual(["at-1", "at-2"]);
    });

    it("filters by class before bounding the list", () => {
        // The reason the filter is an option of this function rather than a
        // second pass: two reminders are sooner, so a bound applied first would
        // hand the Timers page nothing at all.
        const rows = upcomingJobs(
            [
                job({
                    id: "reminder-1",
                    class: "reminder",
                    runAt: new Date(2026, 9, 17, 12, 1).toISOString(),
                }),
                job({
                    id: "reminder-2",
                    class: "reminder",
                    runAt: new Date(2026, 9, 17, 12, 2).toISOString(),
                }),
                job({
                    id: "timer-1",
                    class: "timer",
                    runAt: new Date(2026, 9, 17, 12, 3).toISOString(),
                }),
                job({
                    id: "timer-2",
                    class: "timer",
                    runAt: new Date(2026, 9, 17, 12, 4).toISOString(),
                }),
            ],
            { limit: 2, jobClass: "timer" },
        );
        expect(rows.map((row) => row.id)).toEqual(["timer-1", "timer-2"]);
    });

    it("sorts an unreadable moment last instead of failing the list", () => {
        const rows = upcomingJobs(
            [
                job({ id: "broken", runAt: "not a date" }),
                job({
                    id: "fine",
                    runAt: new Date(2026, 9, 17, 13, 0).toISOString(),
                }),
            ],
            { limit: 10 },
        );
        expect(rows.map((row) => row.id)).toEqual(["fine", "broken"]);
    });

    it("does not mutate the caller's list", () => {
        const input = [
            job({
                id: "later",
                runAt: new Date(2026, 9, 17, 18, 0).toISOString(),
            }),
            job({
                id: "sooner",
                runAt: new Date(2026, 9, 17, 12, 5).toISOString(),
            }),
        ];
        upcomingJobs(input, { limit: 10 });
        expect(input.map((row) => row.id)).toEqual(["later", "sooner"]);
    });
});

describe("describeRunAt", () => {
    // Saturday 17 October 2026, noon, in the browser's own zone.
    const now = new Date(2026, 9, 17, 12, 0);

    it("reads a moment already past as due now", () => {
        expect(
            describeRunAt(new Date(2026, 9, 17, 11, 59).toISOString(), now),
        ).toBe("due now");
        expect(
            describeRunAt(new Date(2026, 9, 10, 9, 0).toISOString(), now),
        ).toBe("due now");
    });

    it("counts down inside the hour", () => {
        // How someone waiting for a timer talks about it.
        expect(
            describeRunAt(new Date(2026, 9, 17, 12, 30).toISOString(), now),
        ).toBe("in 30 minutes");
        expect(
            describeRunAt(new Date(2026, 9, 17, 12, 1).toISOString(), now),
        ).toBe("in 1 minute");
    });

    it("gives the clock time for later today", () => {
        expect(
            describeRunAt(new Date(2026, 9, 17, 15, 0).toISOString(), now),
        ).toBe("at 3:00 PM");
    });

    it("names tomorrow", () => {
        expect(
            describeRunAt(new Date(2026, 9, 18, 8, 0).toISOString(), now),
        ).toBe("tomorrow at 8:00 AM");
    });

    it("names the weekday beyond tomorrow", () => {
        // Tuesday 20 October 2026.
        expect(
            describeRunAt(new Date(2026, 9, 20, 8, 0).toISOString(), now),
        ).toBe("Tuesday at 8:00 AM");
    });

    it("says so when the moment cannot be read", () => {
        expect(describeRunAt("", now)).toBe("at an unknown time");
    });
});

describe("describeMoment", () => {
    const now = new Date(2026, 9, 17, 12, 0);

    it("names the clock time rather than counting down", () => {
        // The whole reason it exists: "snoozed until in 45 minutes" is not
        // English, and a named moment is what someone checking *when* wants.
        expect(
            describeMoment(new Date(2026, 9, 17, 12, 45).toISOString(), now),
        ).toBe("at 12:45 PM");
    });

    it("names the day when the clock alone would be ambiguous", () => {
        expect(
            describeMoment(new Date(2026, 9, 18, 9, 0).toISOString(), now),
        ).toBe("tomorrow at 9:00 AM");
        expect(
            describeMoment(new Date(2026, 9, 20, 9, 0).toISOString(), now),
        ).toBe("Tuesday at 9:00 AM");
    });
});

describe("a snoozed row's moment (#90 phase 6c)", () => {
    const now = new Date(2026, 9, 17, 12, 0);

    it("joins the notification's link to the job's new moment", () => {
        const jobs = [
            job({
                id: "job-1",
                class: "reminder",
                runAt: new Date(2026, 9, 17, 19, 0).toISOString(),
            }),
        ];
        const until = snoozeUntil("job-1", jobs);
        expect(until).not.toBeNull();
        expect(describeSnooze(until, now)).toBe("snoozed until 7:00 PM");
    });

    it("says only `snoozed` when the job is gone or no link was kept", () => {
        // A pruned job nulls the link (the FK's ON DELETE SET NULL), so the row
        // must be able to state the deferral without naming a moment.
        expect(snoozeUntil(undefined, [])).toBeNull();
        expect(snoozeUntil("job-gone", [])).toBeNull();
        expect(describeSnooze(null, now)).toBe("snoozed");
    });

    it("names the day when the moment is not today", () => {
        // The bug this test exists for: prefixing "until" to a moment that
        // already carries a preposition ("at 7:00 PM") produced "until at".
        const jobs = [
            job({
                id: "job-1",
                class: "reminder",
                runAt: new Date(2026, 9, 18, 8, 0).toISOString(),
            }),
        ];
        expect(describeSnooze(snoozeUntil("job-1", jobs), now)).toBe(
            "snoozed until tomorrow at 8:00 AM",
        );
    });

    it("says only `snoozed` when the job is no longer pending", () => {
        // The successor was cancelled, or it already ran: either way the moment
        // this row claimed is not a moment any more.
        const jobs = [
            job({ id: "job-1", class: "reminder", state: "cancelled" }),
        ];
        expect(snoozeUntil("job-1", jobs)).toBeNull();
    });

    it("offers the three offsets the classification table settled", () => {
        expect(SNOOZE_PRESETS).toEqual([
            { label: "in an hour", minutes: 60 },
            { label: "tomorrow", minutes: 24 * 60 },
            { label: "next week", minutes: 7 * 24 * 60 },
        ]);
    });
});
