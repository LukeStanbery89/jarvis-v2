/**
 * Rendered-surface tests for the unified presentation module (#156).
 *
 * The suite is node-only and has no DOM, so each named surface is rendered to
 * static markup — the shape `JobsPages.test.ts` established. That is enough to
 * catch the failure this PR was reviewed for: a surface that renders the row
 * with none of the app's own classes (so the pane loses its edge and its
 * buttons lose their styling), or one that bypasses the presentation module
 * altogether. The `/timers` and `/reminders` surfaces are covered by
 * `JobsPages.test.ts`; here are the dashboard, the notifications page
 * (scheduled **and** records), the toast and the ring.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard } from "./Dashboard";
import { NotificationsPage } from "./NotificationsPage";
import { ToastStack } from "./Toast";
import { TimerRing } from "./TimerRing";
import type { JobsState } from "../../hooks/useJobs";
import type { NotificationsState } from "../../hooks/useNotifications";
import type { ClientNotification } from "../../notifications";
import type { Job } from "../../api";

/** A job with everything the cards read, overridable per test. */
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

/** The jobs state the surfaces read, standing in for the shell's. */
function jobsState(jobs: Job[]): JobsState {
    return {
        jobs,
        settled: [],
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

/** One notification record, overridable per test. */
function record(
    overrides: Partial<ClientNotification> = {},
): ClientNotification {
    return {
        id: "note-1",
        kind: "reminder.announced",
        class: "reminder",
        priority: "normal",
        state: "delivered",
        title: "Take meds",
        body: "Take meds now",
        createdAt: new Date(2026, 9, 21, 9, 0).toISOString(),
        jobId: "job-1",
        ...overrides,
    };
}

/** The notification state the surfaces read. */
function notificationsState(
    notifications: ClientNotification[],
    lastTest: NotificationsState["lastTest"] = null,
): NotificationsState {
    return {
        notifications,
        unread: notifications.length,
        loading: false,
        loaded: true,
        error: null,
        ring: null,
        banner: null,
        lastTest,
        markRead: () => undefined,
        dismiss: () => undefined,
        markSnoozed: () => undefined,
        refresh: () => undefined,
        sendTest: () => undefined,
    } as unknown as NotificationsState;
}

describe("the dashboard renders the individual job widgets", () => {
    it("draws the same job pane the Timers and Reminders pages use", () => {
        const html = renderToStaticMarkup(
            createElement(Dashboard, {
                username: "luke",
                jobs: jobsState([job({ class: "timer", label: "Kettle" })]),
                notifications: notificationsState([]),
                token: "device-token",
                unread: 0,
            }),
        );

        expect(html).toContain("job-item job-timer");
        expect(html).toContain("job-countdown");
        expect(html).toContain("Kettle");
        expect(html).toContain("row-actions");
        // The old compact one-line row is gone; the dashboard is the panes.
        expect(html).not.toContain("dashboard-class");
        expect(html).not.toContain("dashboard-label");
    });
});

describe("the notifications page renders through the shared cards", () => {
    it("draws the scheduled half as job panes", () => {
        const html = renderToStaticMarkup(
            createElement(NotificationsPage, {
                notifications: notificationsState([]),
                jobs: jobsState([
                    job({
                        id: "sched-1",
                        class: "notification",
                        label: "Weather",
                    }),
                ]),
                token: "device-token",
            }),
        );

        // The list-page chrome (gutters, centred measure) comes from these.
        expect(html).toContain("page page-rows");
        expect(html).toContain("page-head");
        expect(html).toContain("job-item job-notification");
        expect(html).toContain("Weather");
        expect(html).toContain("Scheduled");
    });

    it("draws a record with its chip, body and folded actions", () => {
        const html = renderToStaticMarkup(
            createElement(NotificationsPage, {
                notifications: notificationsState([record()]),
                jobs: jobsState([]),
                token: "device-token",
            }),
        );

        expect(html).toContain("notification-item");
        expect(html).toContain("notification-reminder");
        expect(html).toContain("class-chip");
        expect(html).toContain("Take meds");
        // The body renders as Markdown (a paragraph), not appended raw text.
        expect(html).toContain("Take meds now");
        expect(html).toContain("row-actions");
        // The menu is a popover, so a later card cannot paint over it (#156
        // review).
        expect(html).toContain('popover="auto"');
        expect(html).toContain("Mark read");
        expect(html).toContain("Dismiss");
    });

    it("offers the question surface for an answerable notification (#94, #180)", () => {
        const html = renderToStaticMarkup(
            createElement(NotificationsPage, {
                notifications: notificationsState([
                    record({
                        id: "q1",
                        kind: "agent.request",
                        class: "notification",
                        title: "Which database?",
                        requiresAnswer: true,
                        codingJobId: "c1",
                        jobId: undefined,
                    }),
                ]),
                jobs: jobsState([]),
                token: "device-token",
            }),
        );

        expect(html).toContain("notification-answer");
        // The static render has not run the fetch effect; the browser replaces
        // this with the per-question form once the job's questions land.
        expect(html).toContain("Loading questions…");
        // Reading is not answering: the row must not offer a settle that would
        // retire the question without resuming the job.
        expect(html).not.toContain("Mark read");
    });

    it("keeps the free-text box for an answerable notification with no job link (#94)", () => {
        const html = renderToStaticMarkup(
            createElement(NotificationsPage, {
                notifications: notificationsState([
                    record({
                        id: "q2",
                        kind: "agent.request",
                        class: "notification",
                        title: "Which database?",
                        requiresAnswer: true,
                        jobId: undefined,
                    }),
                ]),
                jobs: jobsState([]),
                token: "device-token",
            }),
        );

        expect(html).toContain("notification-answer");
        expect(html).toContain("Answer this question");
        expect(html).toContain("Send answer");
        expect(html).not.toContain("Mark read");
    });

    it("shows the answer once the record is answered (#94)", () => {
        const html = renderToStaticMarkup(
            createElement(NotificationsPage, {
                notifications: notificationsState([
                    record({
                        id: "q1",
                        kind: "agent.request",
                        class: "notification",
                        state: "answered",
                        requiresAnswer: true,
                        codingJobId: "c1",
                        answer: "Postgres",
                        jobId: undefined,
                    }),
                ]),
                jobs: jobsState([]),
                token: "device-token",
            }),
        );

        expect(html).toContain("You answered: Postgres");
        expect(html).not.toContain("Send answer");
    });

    it("renders a settled record without the settle actions", () => {
        const html = renderToStaticMarkup(
            createElement(NotificationsPage, {
                notifications: notificationsState([record({ state: "read" })]),
                jobs: jobsState([]),
                token: "device-token",
            }),
        );

        expect(html).toContain("Take meds");
        expect(html).not.toContain("Mark read");
    });
});

describe("the toast renders the class chip and the primary fact", () => {
    it("leads with the chip and the message, body under it", () => {
        const html = renderToStaticMarkup(
            createElement(ToastStack, {
                toasts: [record()],
                onMarkRead: () => undefined,
                onDismiss: () => undefined,
                onSnooze: () => undefined,
            }),
        );

        expect(html).toContain("notification-banner");
        expect(html).toContain("class-chip");
        expect(html).toContain("Take meds");
        expect(html).toContain("Take meds now");
    });

    it("sends an answerable notification to its answer box (#94)", () => {
        const html = renderToStaticMarkup(
            createElement(ToastStack, {
                toasts: [
                    record({
                        id: "q1",
                        kind: "agent.request",
                        class: "notification",
                        requiresAnswer: true,
                        codingJobId: "c1",
                        jobId: undefined,
                    }),
                ],
                onMarkRead: () => undefined,
                onDismiss: () => undefined,
                onSnooze: () => undefined,
            }),
        );

        // Reading a question does not retire it; the card leads to the answer
        // box rather than offering a settle that would leave the job parked.
        expect(html).toContain("Answer");
        expect(html).not.toContain("Mark read");
    });
});

describe("the ring renders the class chip and the primary fact", () => {
    it("leads with the chip and the timer's headline", () => {
        const html = renderToStaticMarkup(
            createElement(TimerRing, {
                timer: record({
                    class: "timer",
                    kind: "job.finished",
                    title: "Kettle",
                    body: undefined,
                }),
                onStop: () => undefined,
            }),
        );

        expect(html).toContain("timer-ring");
        expect(html).toContain("class-chip");
        expect(html).toContain("Kettle");
    });
});
