/**
 * Creation-policy tests (#90 phase 5).
 *
 * The tools' own suite (`jobs.tool.test.ts`) pins what a creation *says* in the
 * model's voice, and it passes unchanged over this module — which is the proof
 * that the policy moved rather than changed. These tests cover what the tools
 * cannot reach: the REST surface's edit, and the moments a page can ask for
 * that the natural-language resolver never produces (an instant in the past, a
 * "timer" a week out), and the snooze bounds the model's tool only passes
 * through.
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
    /** The device credential a timer must be scoped to (#194). */
    deviceId: number;
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
    const deviceId = store.createDevice(
        userId,
        "test-device",
        "device-hash",
        "test0001",
    ).id;
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
            originDeviceId: deviceId,
            runAt: new Date(NOW.getTime() + (overrides.minutes ?? 10) * 60_000),
            at: NOW,
        });
    return { store, userId, deviceId, creator, createTimer };
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
            originDeviceId: h.deviceId,
            runAt: new Date(NOW.getTime() - 60_000),
            at: NOW,
        });

        expect(outcome).toMatchObject({ ok: false, code: "in-the-past" });
        expect(h.store.listJobs(h.userId)).toEqual([]);
    });

    it("requires a device for a timer, and stores the one that asked (#194)", () => {
        const h = harness();
        const noDevice = h.creator.create(h.userId, {
            label: "Kettle",
            class: "timer",
            payload: { kind: "message", message: "Kettle" },
            runAt: new Date(NOW.getTime() + 60_000),
            at: NOW,
        });
        expect(noDevice).toMatchObject({
            ok: false,
            code: "timer-needs-device",
        });

        const created = h.createTimer();
        if (!created.ok) {
            throw new Error("the timer should have been created");
        }
        expect(created.job.originDeviceId).toBe(h.deviceId);
    });

    it("refuses a timer set beyond its day, whatever the horizon allows", () => {
        const h = harness();
        // A day-long countdown is a reminder, and the class pierces quiet
        // hours — so the ceiling is the timer's alone.
        const tooLong = h.creator.create(h.userId, {
            label: "Kettle",
            class: "timer",
            payload: { kind: "message", message: "Kettle" },
            originDeviceId: h.deviceId,
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

    it("allows a snooze as far out as the menu's furthest preset", () => {
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

        // "next week" is one of the three offsets the classification table
        // settled, and it used to be refused: the bound was the *timer's* day
        // ceiling, which is a different question (how long a countdown may be).
        const week = h.creator.snooze(h.userId, reminder.job.id, 7 * 24 * 60);
        expect(week).toMatchObject({ ok: true, action: "moved" });
        if (week.ok) {
            expect(week.job.runAt).toBe(
                new Date(NOW.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
            );
        }

        // The new bound is still a bound.
        expect(
            h.creator.snooze(h.userId, reminder.job.id, 7 * 24 * 60 + 1),
        ).toMatchObject({ ok: false, code: "invalid-minutes" });
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

    it("settles the announcement a snooze answered — in both of its shapes", () => {
        const h = harness();
        const reminder = h.creator.create(h.userId, {
            label: "AC filter",
            class: "reminder",
            payload: { kind: "message", message: "change the AC filter" },
            runAt: new Date(NOW.getTime() + 3_600_000),
            at: NOW,
        });
        if (!reminder.ok) {
            throw new Error("the reminder should have been created");
        }
        /** The row the runner would have announced this job with. */
        const announce = (id: string, at: string): void => {
            h.store.createNotification(h.userId, {
                id,
                kind: "job.finished",
                class: "reminder",
                priority: "normal",
                title: "AC filter",
                createdAt: at,
                jobId: reminder.job.id,
            });
        };

        announce("first", "2026-01-01T20:05:00.000Z");
        expect(h.store.countUnreadNotifications(h.userId)).toBe(1);

        const moved = h.creator.snooze(h.userId, reminder.job.id, 15);
        // Moving the job *and* settling its announcement is one call, which is
        // what keeps the floating toast from sitting on screen after a snooze
        // that worked (#90 phase 6c).
        expect(moved).toMatchObject({ ok: true, action: "moved" });
        expect(h.store.getNotification(h.userId, "first")?.state).toBe(
            "snoozed",
        );
        expect(h.store.countUnreadNotifications(h.userId)).toBe(0);

        // A reminder that already had its moment is re-created: the row the user
        // acted on belongs to the job they acted on, and the successor will
        // announce its own moment when it comes.
        h.store.claimJob(reminder.job.id);
        h.store.settleJob(
            reminder.job.id,
            "done",
            {},
            new Date(NOW.getTime() + 61_000).toISOString(),
        );
        announce("second", "2026-01-01T20:06:00.000Z");

        const again = h.creator.snooze(h.userId, reminder.job.id, 15);
        expect(again).toMatchObject({ ok: true, action: "recreated" });
        expect(h.store.getNotification(h.userId, "second")?.state).toBe(
            "snoozed",
        );
        expect(
            h.store.listNotificationsForJob(
                h.userId,
                again.ok ? again.job.id : "none",
            ),
        ).toEqual([]);
    });

    it("leaves the announcement where it was when the snooze is refused", () => {
        const h = harness();
        const timer = h.createTimer();
        if (!timer.ok) {
            throw new Error("the timer should have been created");
        }
        h.store.createNotification(h.userId, {
            id: "announce",
            kind: "job.finished",
            class: "timer",
            priority: "normal",
            title: "Kettle",
            createdAt: "2026-01-01T19:06:00.000Z",
            jobId: timer.job.id,
        });

        // A timer is not snoozable. The refusal must settle nothing: a row
        // claiming a deferral nobody made would be worse than an unsettled one.
        expect(h.creator.snooze(h.userId, timer.job.id, 10)).toMatchObject({
            ok: false,
            code: "not-a-reminder",
        });
        expect(h.store.getNotification(h.userId, "announce")?.state).toBe(
            "pending",
        );
        expect(h.store.countUnreadNotifications(h.userId)).toBe(1);
    });
});

describe("recurrence (#90 phase 8d)", () => {
    /** A daily rule anchored at the fixed clock: 19:05 every day. */
    const daily = { every: "day", interval: 1, start: NOW.toISOString() };

    /** Tomorrow at the fixed clock — what that rule fires next. */
    const tomorrowAt1905 = new Date(2026, 0, 2, 19, 5).toISOString();

    /** A tool job ten minutes out — the payload a firing spends on. */
    function createTool(h: Harness, repeat: unknown) {
        return h.creator.create(h.userId, {
            label: "Porch",
            class: "notification",
            payload: {
                kind: "tool",
                toolName: "homeAssistant",
                toolArgs: { action: "turn_on", entity_id: "light.porch" },
            },
            runAt: new Date(NOW.getTime() + 10 * 60_000),
            repeat,
            at: NOW,
        });
    }

    /** A message job ten minutes out, optionally repeating. */
    function createMessage(
        h: Harness,
        repeat: unknown,
        cls: "notification" | "reminder" | "timer" = "reminder",
    ) {
        return h.creator.create(h.userId, {
            label: "Standup",
            class: cls,
            payload: { kind: "message", message: "Standup" },
            originDeviceId: h.deviceId,
            runAt: new Date(NOW.getTime() + 10 * 60_000),
            repeat,
            at: NOW,
        });
    }

    it("stores a rule and derives the job's moment from it", () => {
        const h = harness();
        const outcome = createMessage(h, daily);

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
            return;
        }
        expect(outcome.job.repeat).toEqual(daily);
        // Not the requested moment: a rule *is* the schedule, so the job is due
        // at its next occurrence — tomorrow at the same clock time.
        expect(outcome.job.runAt).toBe(tomorrowAt1905);
    });

    it("refuses a repeating timer, with the alternative to offer", () => {
        const h = harness();
        const outcome = createMessage(h, daily, "timer");

        expect(outcome).toMatchObject({ ok: false, code: "invalid-repeat" });
        if (!outcome.ok) {
            expect(outcome.reason).toMatch(/a timer is a countdown/);
        }
    });

    it("lets a message job repeat every minute, and prices a spending one", () => {
        const h = harness();
        // A series' announcement supersedes its predecessor (#90 phase 9a), so a
        // minute-cadence reminder is one row in the list rather than 1,440 — the
        // notification-rate argument for a floor is gone, and the cadence is the
        // user's own call.
        const everyMinute = createMessage(h, {
            every: "minute",
            interval: 1,
            start: NOW.toISOString(),
        });
        expect(everyMinute).toMatchObject({ ok: true });

        // A `tool` or `prompt` firing spends — a device write or a model call —
        // so fifteen minutes is the floor there, and the refusal says why.
        const spends = createTool(h, {
            every: "minute",
            interval: 5,
            start: NOW.toISOString(),
        });
        expect(spends).toMatchObject({ ok: false, code: "invalid-repeat" });
        if (!spends.ok) {
            expect(spends.reason).toMatch(
                /a task runs a tool on every firing, so it needs at least 15 minutes/,
            );
        }
    });

    it("refuses a day that can never exist, in the parser's words", () => {
        const h = harness();
        const outcome = createMessage(h, {
            every: "month",
            interval: 1,
            start: NOW.toISOString(),
            weekOrdinals: ["7mo"],
        });

        expect(outcome).toMatchObject({ ok: false, code: "invalid-repeat" });
        if (!outcome.ok) {
            expect(outcome.reason).toMatch(/ordinal from 1 to 5/);
        }
    });

    it("sets, keeps and clears a rule through an edit", () => {
        const h = harness();
        const created = createMessage(h, undefined);
        expect(created.ok).toBe(true);
        if (!created.ok) {
            return;
        }
        const id = created.job.id;

        // Setting one re-anchors the series at the edit and decides the moment.
        const set = h.creator.edit(h.userId, id, { repeat: daily });
        expect(set.ok).toBe(true);
        expect(set.ok ? set.job.repeat : null).toEqual(daily);
        expect(set.ok ? set.job.runAt : null).toBe(tomorrowAt1905);

        // An edit that does not mention the rule leaves it alone.
        const renamed = h.creator.edit(h.userId, id, { label: "Renamed" });
        expect(renamed.ok ? renamed.job.repeat : null).toEqual(daily);

        // Clearing one leaves the job due where it stands.
        const stopped = h.creator.edit(h.userId, id, { repeat: null });
        expect(stopped.ok).toBe(true);
        expect(stopped.ok ? stopped.job.repeat : "unset").toBeNull();
        expect(stopped.ok ? stopped.job.runAt : null).toBe(tomorrowAt1905);
    });
});

describe("the prompt payload and the gate (#90 phase 8g)", () => {
    /** A gate over the front door, as a door's create request would carry it. */
    const doorGate = {
        tool: "homeAssistant",
        args: { action: "get", entity_id: "binary_sensor.front_door" },
        when: "changed",
    };

    /** A prompt job five minutes out, optionally repeating and gated. */
    function createPrompt(
        h: Harness,
        request: { repeat?: unknown; gate?: unknown } = {},
    ) {
        return h.creator.create(h.userId, {
            label: "Morning brief",
            class: "notification",
            payload: { kind: "prompt", prompt: "Summarise my day." },
            runAt: new Date(NOW.getTime() + 5 * 60_000),
            ...(request.repeat !== undefined ? { repeat: request.repeat } : {}),
            ...(request.gate !== undefined ? { gate: request.gate } : {}),
            at: NOW,
        });
    }

    /** A five-minute cadence: below the ungated floor, above the gated one. */
    const minutely = {
        every: "minute",
        interval: 5,
        start: NOW.toISOString(),
    };

    it("stores a prompt payload, and says what it will run", () => {
        const h = harness();
        const outcome = createPrompt(h);

        expect(outcome.ok).toBe(true);
        const [job] = h.store.listJobs(h.userId);
        expect(job).toMatchObject({
            kind: "prompt",
            prompt: "Summarise my day.",
            message: null,
        });
    });

    it("refuses a prompt with nothing in it", () => {
        const h = harness();
        const outcome = h.creator.create(h.userId, {
            label: "Nothing",
            class: "notification",
            payload: { kind: "prompt", prompt: "   " },
            runAt: new Date(NOW.getTime() + 60_000),
            at: NOW,
        });

        expect(outcome).toMatchObject({ ok: false, code: "prompt-empty" });
        expect(h.store.listJobs(h.userId)).toEqual([]);
    });

    it("stores a valid gate with the job", () => {
        const h = harness();
        const outcome = createPrompt(h, { gate: doorGate });

        expect(outcome.ok).toBe(true);
        expect(h.store.listJobs(h.userId)[0]?.gate).toEqual(doorGate);
    });

    it("refuses a gate whose tool acts, and a malformed one", () => {
        const h = harness();

        const writes = createPrompt(h, {
            gate: {
                tool: "homeAssistant",
                args: { action: "turn_on", entity_id: "light.porch" },
                when: "changed",
            },
        });
        expect(writes).toMatchObject({ ok: false, code: "invalid-gate" });
        expect(writes.ok ? "" : writes.reason).toMatch(/may only read/);

        const malformed = createPrompt(h, {
            gate: { tool: "homeAssistant", args: {}, when: "rising" },
        });
        expect(malformed).toMatchObject({ ok: false, code: "invalid-gate" });
        expect(malformed.ok ? "" : malformed.reason).toMatch(
            /"when" must be one/,
        );

        expect(h.store.listJobs(h.userId)).toEqual([]);
    });

    it("allows a minutely cadence only when a gate can decline a firing", () => {
        const h = harness();

        const ungated = createPrompt(h, { repeat: minutely });
        expect(ungated).toMatchObject({ ok: false, code: "invalid-repeat" });
        // The refusal names the way out rather than only the rule.
        expect(ungated.ok ? "" : ungated.reason).toMatch(
            /needs at least 15 minutes between firings, or a gate that can decline one/,
        );

        const gated = createPrompt(h, { repeat: minutely, gate: doorGate });
        expect(gated.ok).toBe(true);
        expect(gated.ok ? gated.job.repeat : null).toMatchObject({
            every: "minute",
            interval: 5,
        });
    });

    it("keeps a gated job's relaxed floor when its rule is edited", () => {
        const h = harness();
        const created = createPrompt(h, { repeat: minutely, gate: doorGate });
        expect(created.ok).toBe(true);
        if (!created.ok) {
            return;
        }

        // The job already runs every five minutes because it is gated. An edit
        // that restates the same rule must not turn that into a refusal.
        const edited = h.creator.edit(h.userId, created.job.id, {
            repeat: {
                ...minutely,
                start: new Date(NOW.getTime() + 60_000).toISOString(),
            },
        });
        expect(edited.ok).toBe(true);
        expect(edited.ok ? edited.job.repeat : null).toMatchObject({
            every: "minute",
            interval: 5,
        });
    });
});
