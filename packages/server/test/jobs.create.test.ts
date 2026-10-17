/**
 * Creation-policy tests (#90 phase 5).
 *
 * The tools' own suite (`jobs.tool.test.ts`) pins what a creation *says* in the
 * model's voice, and it passes unchanged over this module — which is the proof
 * that the policy moved rather than changed. These tests cover what the tools
 * cannot reach: the REST surface's edit, and the moments a page can ask for
 * that the natural-language resolver never produces (an instant in the past, a
 * "timer" a week out).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { createJobCreator } from "../src/scheduler/create";
import type { JobCreator } from "../src/scheduler/create";

/** Thursday 2026-01-01 19:05 local. */
const NOW = new Date(2026, 0, 1, 19, 5, 0, 0);

interface Harness {
    store: AppDatabase;
    userId: number;
    creator: JobCreator;
    /** A message timer `minutes` from the fixed clock. */
    createTimer: (overrides?: {
        label?: string;
        minutes?: number;
        message?: string;
    }) => ReturnType<JobCreator["create"]>;
}

/** Builds the policy over a fresh in-memory ledger, with a fixed clock and ids. */
function harness(
    options: { maxPerUser?: number; maxHorizonMs?: number } = {},
): Harness {
    const store = createInMemoryAppDatabase();
    const userId = store.createUser("luke", "hash", "owner").id;
    let idSeq = 0;
    const creator = createJobCreator({
        ledger: store,
        maxPerUser: options.maxPerUser ?? 50,
        maxHorizonMs: options.maxHorizonMs ?? 366 * 86_400_000,
        now: () => NOW,
        newId: () => `job-${(idSeq += 1)}`,
    });
    const createTimer: Harness["createTimer"] = (overrides = {}) =>
        creator.create(userId, {
            label: overrides.label ?? "Kettle",
            class: "timer",
            payload: {
                kind: "message",
                message: overrides.message ?? overrides.label ?? "Kettle",
            },
            runAt: new Date(NOW.getTime() + (overrides.minutes ?? 10) * 60_000),
            at: NOW,
        });
    return { store, userId, creator, createTimer };
}

describe("the creation policy", () => {
    it("refuses a moment that has already passed", () => {
        const h = harness();
        // The model's resolver never produces this — it refuses a past time
        // before it resolves one — but a page's date picker can.
        const outcome = h.creator.create(h.userId, {
            label: "Kettle",
            class: "timer",
            payload: { kind: "message", message: "Kettle" },
            runAt: new Date(NOW.getTime() - 60_000),
            at: NOW,
        });

        expect(outcome).toMatchObject({ ok: false, code: "in-the-past" });
        expect(h.store.listJobs(h.userId)).toEqual([]);
    });

    it("refuses a timer set beyond its day, whatever the horizon allows", () => {
        const h = harness();
        // A day-long countdown is a reminder, and the class pierces quiet
        // hours — so the ceiling is the timer's alone.
        const tooLong = h.creator.create(h.userId, {
            label: "Kettle",
            class: "timer",
            payload: { kind: "message", message: "Kettle" },
            runAt: new Date(NOW.getTime() + 26 * 3_600_000),
            at: NOW,
        });
        const aDay = h.createTimer({ minutes: 1440 });

        expect(tooLong).toMatchObject({ ok: false, code: "timer-too-long" });
        expect(aDay.ok).toBe(true);
    });

    it("edits a pending job's label, message and moment in one call", () => {
        const h = harness();
        const created = h.createTimer();
        if (!created.ok) {
            throw new Error("the timer should have been created");
        }

        const edited = h.creator.edit(h.userId, created.job.id, {
            label: "Tea",
            message: "The tea is ready.",
            runAt: new Date(NOW.getTime() + 60 * 60_000),
        });

        expect(edited.ok && edited.job).toMatchObject({
            label: "Tea",
            message: "The tea is ready.",
            state: "pending",
        });
        expect(new Date(created.job.runAt).getTime()).toBe(
            NOW.getTime() + 600_000,
        );
        // The class is not editable, so the job is still the timer it was.
        expect(h.store.getJob(h.userId, created.job.id)?.class).toBe("timer");
    });

    it("refuses an edit that would move a job into the past, or past a bound", () => {
        const h = harness({ maxHorizonMs: 2 * 86_400_000 });
        const created = h.createTimer();
        if (!created.ok) {
            throw new Error("the timer should have been created");
        }

        expect(
            h.creator.edit(h.userId, created.job.id, {
                runAt: new Date(NOW.getTime() - 1),
            }),
        ).toMatchObject({ ok: false, code: "in-the-past" });
        expect(
            h.creator.edit(h.userId, created.job.id, {
                runAt: new Date(NOW.getTime() + 3 * 86_400_000),
            }),
        ).toMatchObject({ ok: false, code: "beyond-horizon" });
        // The refused edits changed nothing: still ten minutes out.
        expect(h.store.getJob(h.userId, created.job.id)?.runAt).toBe(
            created.job.runAt,
        );
    });

    it("refuses a message edit on a job that has no message", () => {
        const h = harness();
        const created = h.creator.create(h.userId, {
            label: "Porch lights",
            class: "notification",
            payload: {
                kind: "tool",
                toolName: "homeAssistant",
                toolArgs: { action: "turn_on", entity_id: "light.porch" },
            },
            runAt: new Date(NOW.getTime() + 600_000),
            at: NOW,
        });
        if (!created.ok) {
            throw new Error("the task should have been created");
        }

        expect(
            h.creator.edit(h.userId, created.job.id, { message: "hello" }),
        ).toMatchObject({ ok: false, code: "not-a-message" });
        // The label, though, is the user's to change.
        expect(
            h.creator.edit(h.userId, created.job.id, { label: "Porch" }).ok,
        ).toBe(true);
    });

    it("refuses an edit to another account's job, and to one already running", () => {
        const h = harness();
        const pepper = h.store.createUser("pepper", "hash", "user");
        const created = h.createTimer();
        if (!created.ok) {
            throw new Error("the timer should have been created");
        }

        expect(
            h.creator.edit(pepper.id, created.job.id, { label: "not mine" }),
        ).toMatchObject({ ok: false, code: "missing" });
        h.store.claimJob(created.job.id);
        expect(
            h.creator.edit(h.userId, created.job.id, { label: "too late" }),
        ).toMatchObject({ ok: false, code: "not-pending" });
        expect(h.store.getJob(h.userId, created.job.id)?.label).toBe("Kettle");
    });

    it("forwards a snooze's refusal codes instead of choosing its own words", () => {
        const h = harness();
        const timer = h.createTimer();
        if (!timer.ok) {
            throw new Error("the timer should have been created");
        }

        // A timer is not snoozeable, and the code says which rule refused it.
        expect(h.creator.snooze(h.userId, timer.job.id, 10)).toMatchObject({
            ok: false,
            code: "not-a-reminder",
        });
        expect(h.creator.snooze(h.userId, "missing", 10)).toMatchObject({
            ok: false,
            code: "missing",
        });
        expect(h.creator.snooze(h.userId, timer.job.id, 0.1)).toMatchObject({
            ok: false,
            code: "not-a-reminder",
        });
    });

    it("tells a snooze's caller which of the two things happened", () => {
        const h = harness();
        const reminder = h.creator.create(h.userId, {
            label: "Call Mum",
            class: "reminder",
            payload: { kind: "message", message: "Call Mum" },
            runAt: new Date(NOW.getTime() + 3_600_000),
            at: NOW,
        });
        if (!reminder.ok) {
            throw new Error("the reminder should have been created");
        }

        const moved = h.creator.snooze(h.userId, reminder.job.id, 15);
        expect(moved).toMatchObject({ ok: true, action: "moved" });
        if (moved.ok) {
            expect(moved.job.runAt).toBe(
                new Date(NOW.getTime() + 15 * 60_000).toISOString(),
            );
            // A move is not an attempt, and there is no second job.
            expect(moved.job.attempts).toBe(0);
            expect(h.store.listJobs(h.userId)).toHaveLength(1);
        }

        // Once it has had its moment, a snooze is a fresh reminder carrying the
        // same payload — a second row, and the id the user will see.
        h.store.claimJob(reminder.job.id);
        h.store.settleJob(
            reminder.job.id,
            "done",
            {},
            new Date(NOW.getTime() + 61_000).toISOString(),
        );
        const again = h.creator.snooze(h.userId, reminder.job.id, 15);
        expect(again).toMatchObject({ ok: true, action: "recreated" });
        if (again.ok) {
            expect(again.job.id).not.toBe(reminder.job.id);
            expect(again.job.message).toBe("Call Mum");
            expect(again.job.class).toBe("reminder");
            expect(again.previousRunAt?.toISOString()).toBe(
                moved.ok ? moved.job.runAt : undefined,
            );
        }
    });
});
