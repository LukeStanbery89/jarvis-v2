import { describe, expect, it } from "vitest";
import { presentJob, presentNotification } from "./presentation";
import type { Job } from "./api";
import type { ClientNotification } from "./notifications";

const now = new Date("2026-01-01T12:00:00Z");

function makeJob(partial: Partial<Job> & Pick<Job, "id" | "class" | "label" | "runAt">): Job {
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
        expect(p.primary).toMatch(/in/);
        expect(p.title).toBe("Kettle");
        expect(p.countdown).toBe(true);
    });

    it("timer countdown precision - seconds under an hour", () => {
        const job = makeJob({
            id: "t2",
            class: "timer",
            label: "Egg",
            message: "Egg",
            runAt: new Date(now.getTime() + 30_000).toISOString(),
        });
        const p = presentJob(job, now);
        expect(p.primary).toMatch(/seconds?|30|due now/);
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
        expect(p.primary).toContain("Take meds");
        expect(p.title).toBe("Take meds");
    });
});
