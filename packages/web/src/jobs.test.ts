/**
 * Jobs-list tests (#90 phase 6b).
 *
 * The dashboard's list is small enough to be pure, so its two decisions are
 * asserted here rather than eyeballed in a browser: which rows are shown and in
 * what order, and what "when" reads like at the boundaries (inside the hour, a
 * later today, tomorrow, next week, a moment already past).
 *
 * Instants are built with the local `Date` constructor: the module renders local
 * time, so a UTC fixture would be asserting something the user never sees.
 */
import { describe, expect, it } from "vitest";
import { describeRunAt, upcomingJobs } from "./jobs";
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
            10,
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
            10,
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
            2,
        );
        expect(rows.map((row) => row.id)).toEqual(["at-1", "at-2"]);
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
            10,
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
        upcomingJobs(input, 10);
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
