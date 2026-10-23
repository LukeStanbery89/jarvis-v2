/**
 * Rendered-page tests (#90 phases 7, 8e).
 *
 * The suite is node-only and has no DOM, so the components are rendered to
 * static markup here — the shape `SnoozeMenu.test.ts` established. That is
 * enough to catch the class of bug that matters most on these pages: a *render*
 * that throws. The jobs pages are pure readings of the shell's state, so they
 * take fake state happily, and a row that cannot draw a job (a missing field, a
 * helper that was renamed, a rule that will not parse) fails here instead of
 * blanking the page in the browser.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RemindersPage, TimersPage } from "./JobsPages";
import type { JobsState } from "../../hooks/useJobs";
import type { NotificationsState } from "../../hooks/useNotifications";
import type { Job } from "../../api";

/** A job with everything the rows read, overridable per test. */
function job(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-1",
        label: "Standup",
        class: "reminder",
        kind: "message",
        state: "pending",
        runAt: new Date(2026, 9, 21, 9, 0).toISOString(),
        attempts: 0,
        createdAt: new Date(2026, 9, 18, 12, 0).toISOString(),
        ...overrides,
    };
}

/** The jobs state the pages read, standing in for the shell's. */
function jobsState(jobs: Job[], settled: Job[] = []): JobsState {
    return {
        jobs,
        settled,
        loading: false,
        loaded: true,
        error: null,
        refresh: () => undefined,
        cancel: async () => true,
        snooze: async () => true,
        create: async () => ({ ok: false, error: "unused" }),
        update: async () => ({ ok: false, error: "unused" }),
    } as unknown as JobsState;
}

/** The notification state the pages read. */
const notifications = {
    notifications: [],
    unread: 0,
    loading: false,
    loaded: true,
    error: null,
    ring: null,
    banner: null,
    markRead: () => undefined,
    dismiss: () => undefined,
    markSnoozed: () => undefined,
    refresh: () => undefined,
    sendTest: () => undefined,
} as unknown as NotificationsState;

describe("the jobs pages render", () => {
    it("draws an owed row with its cadence, in the protocol's words", () => {
        const html = renderToStaticMarkup(
            createElement(RemindersPage, {
                jobs: jobsState([
                    job({
                        repeat: {
                            every: "week",
                            interval: 1,
                            start: new Date(2026, 9, 19, 9, 0).toISOString(),
                            weekdays: ["mo", "tu", "sa"],
                        },
                    }),
                ]),
                notifications,
                token: "device-token",
            }),
        );

        expect(html).toContain("Standup");
        expect(html).toContain(
            "repeats every Monday, Tuesday and Saturday at 09:00",
        );
    });

    it("draws a one-shot row, and a settled one, without a cadence", () => {
        const html = renderToStaticMarkup(
            createElement(TimersPage, {
                jobs: jobsState([job({ class: "timer", label: "Kettle" })]),
                notifications,
                token: "device-token",
            }),
        );

        expect(html).toContain("Kettle");
        expect(html).not.toContain("repeats");
    });

    it("draws a timer's remaining time as a large hh:mm:ss countdown", () => {
        // #156 review: the timer's primary fact is a clock face, in its own
        // half-width block, not the coarse "in 4 minutes" prose.
        const html = renderToStaticMarkup(
            createElement(TimersPage, {
                jobs: jobsState([job({ class: "timer", label: "Kettle" })]),
                notifications,
                token: "device-token",
            }),
        );

        expect(html).toContain("job-countdown-row");
        expect(html).toContain("job-countdown");
        expect(html).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it("offers an owed row, and a settled one, their own runs", () => {
        // #90 phase 8f: a gated firing that declines announces nothing, so the
        // job row's own history is the only place it exists — for an owed row
        // and, just as much, for one that has already settled.
        const html = renderToStaticMarkup(
            createElement(RemindersPage, {
                jobs: jobsState(
                    [job({ id: "owed" })],
                    [
                        job({
                            id: "settled",
                            state: "done",
                            settledAt: new Date(
                                2026,
                                9,
                                20,
                                9,
                                0,
                            ).toISOString(),
                        }),
                    ],
                ),
                notifications,
                token: "device-token",
            }),
        );

        // One disclosure per row, and the settled half renders too.
        expect(html.match(/<summary>Runs<\/summary>/g)).toHaveLength(2);
    });

    it("says when a row may never fire, and names the check on hover", () => {
        // #90 phases 8f/8g: a gated job is a different promise from one that
        // will definitely run, so the row says so — the tool the check reads is
        // one hover away, and the runs show what it saw.
        const html = renderToStaticMarkup(
            createElement(RemindersPage, {
                jobs: jobsState([
                    job({
                        gate: {
                            tool: "homeAssistant",
                            args: { action: "get" },
                            when: "changed",
                        },
                    }),
                ]),
                notifications,
                token: "device-token",
            }),
        );

        expect(html).toContain("checks first");
        expect(html).toContain("only runs when homeAssistant changes");
    });

    it("draws a row whose stored rule cannot be read, without throwing", () => {
        const html = renderToStaticMarkup(
            createElement(RemindersPage, {
                jobs: jobsState([job({ repeat: "not a rule" as never })]),
                notifications,
                token: "device-token",
            }),
        );

        // The row still says what the job is; the cadence is simply absent.
        expect(html).toContain("Standup");
        expect(html).not.toContain("repeats");
    });
});
