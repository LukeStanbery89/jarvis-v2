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
    checkJobInput,
    defaultMoment,
    describeMoment,
    describeQuiet,
    describeRunAt,
    describeSnooze,
    editPatchFor,
    instantFromDuration,
    jobBody,
    momentInputValue,
    parseMomentInput,
    recentJobs,
    snoozeUntil,
    splitJobs,
    DURATION_PRESETS,
    HORIZON_DAYS,
    MAX_TIMER_MINUTES,
    MOMENT_CHIPS,
    SNOOZE_PRESETS,
    upcomingJobs,
} from "./jobs";
import {
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
} from "@lukestanbery/jarvis-protocol";
import type { JobDraft } from "./jobs";
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

describe("splitJobs", () => {
    it("divides one read into what is owed and what is history", () => {
        const rows = [
            job({ id: "a", state: "pending" }),
            job({ id: "b", state: "done" }),
            job({ id: "c", state: "running" }),
            job({ id: "d", state: "failed" }),
            job({ id: "e", state: "cancelled" }),
            job({ id: "f", state: "missed" }),
        ];
        const { owed, settled } = splitJobs(rows);
        expect(owed.map((entry) => entry.id)).toEqual(["a", "c"]);
        expect(settled.map((entry) => entry.id)).toEqual(["b", "d", "e", "f"]);
    });

    it("keeps the server's order in both halves", () => {
        // Newest-created first as it arrives; the owed list is sorted for display
        // by `upcomingJobs` and a history list wants its own order anyway (when it
        // settled, not when it was made), so this function must not invent one.
        const rows = [
            job({ id: "new", state: "done" }),
            job({ id: "mid", state: "pending" }),
            job({ id: "old", state: "done" }),
        ];
        const { owed, settled } = splitJobs(rows);
        expect(owed.map((entry) => entry.id)).toEqual(["mid"]);
        expect(settled.map((entry) => entry.id)).toEqual(["new", "old"]);
    });

    it("answers two empty lists for an empty read", () => {
        expect(splitJobs([])).toEqual({ owed: [], settled: [] });
    });
});

describe("instantFromDuration", () => {
    const now = new Date(2026, 9, 18, 12, 0, 0);

    it("adds seconds, minutes and hours", () => {
        expect(
            instantFromDuration(now, {
                amount: 30,
                unit: "seconds",
            })?.getTime(),
        ).toBe(now.getTime() + 30_000);
        expect(
            instantFromDuration(now, {
                amount: 10,
                unit: "minutes",
            })?.getTime(),
        ).toBe(now.getTime() + 600_000);
        expect(
            instantFromDuration(now, { amount: 2, unit: "hours" })?.getTime(),
        ).toBe(now.getTime() + 7_200_000);
    });

    it("refuses a length that is not one", () => {
        // Zero and negative are what an emptied or hand-edited number field
        // produces; the form turns a null into "give it a length".
        expect(
            instantFromDuration(now, { amount: 0, unit: "minutes" }),
        ).toBeNull();
        expect(
            instantFromDuration(now, { amount: -5, unit: "minutes" }),
        ).toBeNull();
        expect(
            instantFromDuration(now, { amount: NaN, unit: "minutes" }),
        ).toBeNull();
    });
});

describe("the moment input (datetime-local)", () => {
    it("round-trips an instant to the minute, in local time", () => {
        const at = new Date(2026, 9, 19, 9, 30, 0);
        const value = momentInputValue(at);
        expect(value).toBe("2026-10-19T09:30");
        expect(parseMomentInput(value)?.getTime()).toBe(at.getTime());
    });

    it("pads single digits, so the value is always the control's shape", () => {
        expect(momentInputValue(new Date(2026, 0, 5, 7, 4, 0))).toBe(
            "2026-01-05T07:04",
        );
    });

    it("reads the parts, not a string, so the wall clock survives a DST day", () => {
        // Both are local-time assertions, so they hold in every zone — including
        // the ones where a March or November date carries a shift. A
        // `new Date("2026-03-08T09:00")` parse would be the thing to distrust.
        expect(parseMomentInput("2026-03-08T09:00")?.getHours()).toBe(9);
        expect(parseMomentInput("2026-11-01T09:00")?.getHours()).toBe(9);
    });

    it("takes seconds when the value carries them", () => {
        expect(parseMomentInput("2026-10-19T09:00:30")?.getSeconds()).toBe(30);
    });

    it("refuses a day the calendar would correct", () => {
        // 2026-02-30 is not a date; `new Date(2026, 1, 30)` would quietly make it
        // March 2, which would store a job for a day the user never chose.
        expect(parseMomentInput("2026-02-30T09:00")).toBeNull();
        expect(parseMomentInput("2026-13-01T09:00")).toBeNull();
        expect(parseMomentInput("2026-10-19T25:00")).toBeNull();
        expect(parseMomentInput("")).toBeNull();
        expect(parseMomentInput("tomorrow")).toBeNull();
    });
});

describe("the form's defaults and chips", () => {
    it("starts a new reminder on tomorrow morning", () => {
        const at = defaultMoment(new Date(2026, 9, 18, 23, 30, 0));
        expect(at.getDate()).toBe(19);
        expect(at.getHours()).toBe(9);
        expect(at.getMinutes()).toBe(0);
        // Even when it is already morning: "tomorrow 9 AM" means tomorrow.
        expect(defaultMoment(new Date(2026, 9, 18, 8, 0, 0)).getDate()).toBe(
            19,
        );
    });

    it("offers four lengths worth one click", () => {
        expect(DURATION_PRESETS.map((preset) => preset.minutes)).toEqual([
            5, 10, 25, 60,
        ]);
    });

    it("offers an hour from now and tomorrow morning", () => {
        const now = new Date(2026, 9, 18, 12, 0, 0);
        expect(MOMENT_CHIPS.map((chip) => chip.label)).toEqual([
            "in an hour",
            "tomorrow 9 AM",
        ]);
        expect(MOMENT_CHIPS[0]?.at(now).getTime()).toBe(
            now.getTime() + 3_600_000,
        );
        expect(MOMENT_CHIPS[1]?.at(now).getTime()).toBe(
            defaultMoment(now).getTime(),
        );
    });
});

describe("checkJobInput", () => {
    const now = new Date(2026, 9, 18, 12, 0, 0);
    const minute = (ahead: number): Date =>
        new Date(now.getTime() + ahead * 60_000);

    /** A valid draft, overridable per test. */
    function draft(overrides: Partial<JobDraft>): JobDraft {
        return {
            label: "Kettle",
            message: "",
            runAt: minute(10),
            jobClass: "timer",
            ...overrides,
        };
    }

    it("passes a draft the server would accept", () => {
        expect(checkJobInput(draft({}), now)).toBeNull();
        expect(
            checkJobInput(
                draft({ jobClass: "reminder", runAt: minute(60 * 24 * 30) }),
                now,
            ),
        ).toBeNull();
    });

    it("asks for a name, and bounds it the way the server does", () => {
        expect(checkJobInput(draft({ label: "   " }), now)).toMatch(
            /give it a name/,
        );
        expect(
            checkJobInput(
                draft({ label: "k".repeat(MAX_NOTIFICATION_TITLE_LENGTH + 1) }),
                now,
            ),
        ).toMatch(/at most/);
    });

    it("bounds the detail, which a name-length check would miss", () => {
        expect(
            checkJobInput(
                draft({
                    message: "d".repeat(MAX_NOTIFICATION_BODY_LENGTH + 1),
                }),
                now,
            ),
        ).toMatch(/detail is at most/);
    });

    it("says a timer needs a length and a reminder needs a moment", () => {
        expect(checkJobInput(draft({ runAt: null }), now)).toMatch(
            /give it a length/,
        );
        expect(
            checkJobInput(draft({ jobClass: "reminder", runAt: null }), now),
        ).toMatch(/date and time/);
    });

    it("refuses a moment that has passed, and one beyond each ceiling", () => {
        expect(checkJobInput(draft({ runAt: minute(-1) }), now)).toMatch(
            /already passed/,
        );
        // The timer's day ceiling and the horizon are the server's bounds; the
        // form knows them so it can say so before a round trip.
        expect(
            checkJobInput(draft({ runAt: minute(MAX_TIMER_MINUTES + 1) }), now),
        ).toMatch(/longer than a day is a reminder/);
        // The same length is fine for a reminder: the ceiling is the timer's.
        expect(
            checkJobInput(
                draft({ jobClass: "reminder", runAt: minute(1500) }),
                now,
            ),
        ).toBeNull();
        expect(
            checkJobInput(
                draft({
                    jobClass: "reminder",
                    runAt: minute((HORIZON_DAYS + 1) * 1440),
                }),
                now,
            ),
        ).toMatch(/more than 366 days/);
    });
});

describe("jobBody", () => {
    it("drops a detail that is the label again", () => {
        // The first timer made by hand would have read "Kettle Kettle": the
        // create route defaults a missing detail to the label.
        expect(jobBody(job({ label: "Kettle", message: "Kettle" }))).toBeNull();
        expect(
            jobBody(
                job({ label: "Do a test", message: "remind me to Do a test" }),
            ),
        ).toBeNull();
    });

    it("keeps a detail that says something else", () => {
        expect(
            jobBody(
                job({
                    label: "AC filter",
                    message: "change it in the hall cupboard",
                }),
            ),
        ).toBe("change it in the hall cupboard");
    });

    it("answers nothing when the job has no detail at all", () => {
        expect(jobBody(job({ label: "Kettle" }))).toBeNull();
    });
});

describe("editPatchFor", () => {
    /** A stored job, overridable per test. */
    function stored(overrides: Partial<Job>): Job {
        return job({
            label: "Kettle",
            message: "Kettle",
            runAt: new Date(2026, 9, 18, 12, 34, 56).toISOString(),
            ...overrides,
        });
    }

    it("sends nothing when nothing moved", () => {
        const target = stored({});
        const patch = editPatchFor(target, {
            label: target.label,
            message: "",
            runAt: parseMomentInput(momentInputValue(new Date(target.runAt))),
            jobClass: "timer",
        });
        expect(patch).toBeNull();
    });

    it("sends only the field that changed", () => {
        const target = stored({});
        const patch = editPatchFor(target, {
            label: "Tea",
            message: "",
            runAt: parseMomentInput(momentInputValue(new Date(target.runAt))),
            jobClass: "timer",
        });
        // The detail rides along, and has to: a blank field *is* the label, so a
        // rename that left the stored message behind would read "Tea Kettle".
        expect(patch).toEqual({ label: "Tea", message: "Tea" });
    });

    it("leaves a real detail alone when only the label moves", () => {
        const target = stored({ message: "pour it before it goes cold" });
        const patch = editPatchFor(target, {
            label: "Tea",
            message: target.message ?? "",
            runAt: null,
            jobClass: "timer",
        });
        expect(patch).toEqual({ label: "Tea" });
    });

    it("leaves a moment's seconds alone when the label is all that moved", () => {
        // The control is minute-granular: sending the instant back would round
        // 12:34:56 down to 12:34 six seconds early. The minute reading is what
        // decides whether the user touched it.
        const target = stored({});
        const patch = editPatchFor(target, {
            label: "Tea",
            message: "",
            runAt: new Date(2026, 9, 18, 12, 34, 0),
            jobClass: "timer",
        });
        expect(patch).toEqual({ label: "Tea", message: "Tea" });
    });

    it("sends the moment when the user really moved it", () => {
        const target = stored({});
        const moved = new Date(2026, 9, 18, 13, 0, 0);
        const patch = editPatchFor(target, {
            label: target.label,
            message: "",
            runAt: moved,
            jobClass: "timer",
        });
        expect(patch).toEqual({ runAt: moved.toISOString() });
    });

    it("treats a cleared detail as the label, and a redundant one as nothing", () => {
        // Clearing the field cannot send "" (the server refuses an empty
        // message), and the stored value is already the creation default here —
        // which the rows drop anyway (`jobBody`).
        const target = stored({});
        expect(
            editPatchFor(target, {
                label: "Kettle",
                message: "   ",
                runAt: null,
                jobClass: "timer",
            }),
        ).toBeNull();

        const detailed = stored({ message: "pour it before it goes cold" });
        expect(
            editPatchFor(detailed, {
                label: "Kettle",
                message: "",
                runAt: null,
                jobClass: "timer",
            }),
        ).toEqual({ message: "Kettle" });
    });
});

describe("recentJobs", () => {
    const settledAt = (hour: number): string =>
        new Date(2026, 9, 18, hour, 0, 0).toISOString();

    it("keeps one class, newest settled first", () => {
        const rows = [
            job({ id: "old", state: "done", settledAt: settledAt(9) }),
            job({
                id: "other-class",
                class: "reminder",
                state: "done",
                settledAt: settledAt(12),
            }),
            job({ id: "new", state: "failed", settledAt: settledAt(11) }),
        ];
        const recent = recentJobs(rows, { limit: 8, jobClass: "timer" });
        expect(recent.map((entry) => entry.id)).toEqual(["new", "old"]);
    });

    it("falls back to when it was made for a row with no settled stamp", () => {
        // A row can arrive without `settledAt` (a hand-edited database, or a
        // state the ledger stamped before the column existed): it sorts by its
        // creation rather than vanishing or landing first.
        const rows = [
            job({ id: "stamped", state: "done", settledAt: settledAt(10) }),
            job({
                id: "unstamped",
                state: "cancelled",
                createdAt: new Date(2026, 9, 18, 11, 0, 0).toISOString(),
            }),
        ];
        const recent = recentJobs(rows, { limit: 8, jobClass: "timer" });
        expect(recent.map((entry) => entry.id)).toEqual([
            "unstamped",
            "stamped",
        ]);
    });

    it("bounds the list and never shows a row that is still owed", () => {
        const rows = [
            job({ id: "a", state: "done", settledAt: settledAt(8) }),
            job({ id: "b", state: "done", settledAt: settledAt(9) }),
            job({ id: "c", state: "done", settledAt: settledAt(10) }),
            job({ id: "pending", state: "pending" }),
        ];
        expect(
            recentJobs(rows, { limit: 2, jobClass: "timer" }).map(
                (entry) => entry.id,
            ),
        ).toEqual(["c", "b"]);
    });
});

describe("describeQuiet", () => {
    const until = new Date(2026, 9, 19, 7, 0, 0).toISOString();

    it("says nothing when quiet hours will not touch it", () => {
        expect(describeQuiet({ state: "clear" }, "timer")).toBeNull();
    });

    it("warns that a timer will not ring when notifications are off", () => {
        // The master switch silences the announcement, and a timer's ring rides
        // on that announcement — so "won't ring" is the honest disappointment.
        expect(describeQuiet({ state: "disabled" }, "timer")).toBe(
            "notifications are off, so this timer will not ring.",
        );
        expect(describeQuiet({ state: "disabled" }, "reminder")).toBe(
            "notifications are off, so this will be recorded but not pushed.",
        );
    });

    it("names the moment a held reminder comes back on", () => {
        // The server's forecast carries the instant and the window as the user
        // set it; the client only renders them.
        expect(
            describeQuiet(
                { state: "held", until, window: "10:00 PM–7:00 AM" },
                "reminder",
            ),
        ).toBe(
            "it falls inside quiet hours (quiet hours 10:00 PM–7:00 AM), so it will wait until 7:00 AM.",
        );
    });

    it("stays quiet about a forecast it cannot read", () => {
        expect(describeQuiet({ state: "held" }, "reminder")).toBeNull();
        expect(
            describeQuiet({ state: "held", until: "not a time" }, "reminder"),
        ).toBeNull();
    });
});
