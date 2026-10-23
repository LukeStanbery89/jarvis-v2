import { describe, expect, it } from "vitest";
import { presentJob, presentNotification } from "./presentation";
import type { Job } from "./api";
import type { ClientNotification } from "./notifications";

const now = new Date("2026-01-01T12:00:00Z");

function makeJob(
    partial: Partial<Job> & Pick<Job, "id" | "class" | "label" | "runAt">,
): Job {
    return {
        message: partial.label,
        state: "pending",
        attempts: 0,
        createdAt: now.toISOString(),
        ...partial,
    } as Job;
}

describe("presentJob", () => {
    it("timer: time remaining is primary", () => {
        const job = makeJob({
            id: "t1",
            class: "timer",
            label: "Kettle",
            message: "Kettle",
            runAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        });
        const p = presentJob(job, now);
        expect(p.kind).toBe("Timer");
        // A timer's primary fact is a clock face (#156 review), not the coarse
        // prose a moment gets.
        expect(p.primary).toBe("00:05:00");
        expect(p.title).toBe("Kettle");
        expect(p.countdown).toBe(true);
    });

    it("timer countdown is hh:mm:ss, even under a minute", () => {
        const job = makeJob({
            id: "t2",
            class: "timer",
            label: "Egg",
            message: "Egg",
            runAt: new Date(now.getTime() + 30_000).toISOString(),
        });
        const p = presentJob(job, now);
        expect(p.primary).toBe("00:00:30");
        expect(p.countdown).toBe(true);
    });

    it("reminder: moment is primary", () => {
        const job = makeJob({
            id: "r1",
            class: "reminder",
            label: "Call mom",
            message: "Call mom",
            runAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
        });
        const p = presentJob(job, now);
        expect(p.kind).toBe("Reminder");
        expect(p.primary).toMatch(/at|tomorrow|in/);
        expect(p.title).toBe("Call mom");
        expect(p.countdown).toBe(false);
    });

    it("keeps a job's detail out of the title", () => {
        const job = makeJob({
            id: "r2",
            class: "reminder",
            label: "Call mom",
            message: "and ask about the holidays",
            runAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
        });
        const p = presentJob(job, now);
        expect(p.title).toBe("Call mom");
        expect(p.body).toBe("and ask about the holidays");
    });

    it("states a repeating job's cadence as a detail", () => {
        const job = makeJob({
            id: "r3",
            class: "reminder",
            label: "Standup",
            message: "Standup",
            runAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
            repeat: {
                every: "day",
                interval: 1,
                start: now.toISOString(),
            } as Job["repeat"],
        });
        const p = presentJob(job, now);
        expect(p.details.some((d) => d.startsWith("repeats"))).toBe(true);
    });

    it("notification scheduled: moment primary", () => {
        const job = makeJob({
            id: "n1",
            class: "notification",
            label: "Weather",
            message: "Weather",
            runAt: new Date(now.getTime() + 60_000).toISOString(),
        });
        const p = presentJob(job, now);
        expect(p.kind).toBe("Notification");
        expect(p.primary).toBeTruthy();
        expect(p.title).toBe("Weather");
    });
});

describe("presentNotification", () => {
    it("notification record: message is primary", () => {
        const n: ClientNotification = {
            id: "n1",
            class: "reminder",
            kind: "reminder.announced",
            priority: "normal",
            state: "delivered",
            title: "Take meds",
            body: "Take meds now",
            createdAt: now.toISOString(),
        } as ClientNotification;
        const p = presentNotification(n, now);
        expect(p.kind).toBeTruthy();
        expect(p.primary).toBe("Take meds");
        expect(p.title).toBe("Take meds");
        // The body is carried separately so a surface renders it as Markdown
        // (links and all) rather than as raw text appended to the title.
        expect(p.body).toBe("Take meds now");
    });

    it("drops a body that only restates the title", () => {
        const n: ClientNotification = {
            id: "n2",
            class: "reminder",
            kind: "reminder.announced",
            priority: "normal",
            state: "delivered",
            title: "Take meds",
            body: "remind me to take meds",
            createdAt: now.toISOString(),
        } as ClientNotification;
        const p = presentNotification(n, now);
        expect(p.body).toBeNull();
    });

    it("names the answer it waits for as a detail, not the message", () => {
        const n: ClientNotification = {
            id: "n3",
            class: "notification",
            kind: "agent.request",
            priority: "normal",
            state: "delivered",
            title: "Which filter?",
            requiresAnswer: true,
            createdAt: now.toISOString(),
        } as ClientNotification;
        const p = presentNotification(n, now);
        expect(p.primary).toBe("Which filter?");
        expect(p.details).toContain("waiting for your answer");
    });
});
