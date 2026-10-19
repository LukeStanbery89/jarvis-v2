/**
 * Tests for the scheduling tools (#90 phase 3).
 *
 * The subject is what the model may ask for, and what it is told: the class is
 * the tool's choice (never an argument), an impossible task is refused while
 * the user is still in the conversation, and every refusal leaves no row behind.
 *
 * The store is the real in-memory ledger, because these tools *are* a write
 * path — a fake would let a CHECK violation or a wrong payload shape pass. The
 * tool instances offered to `scheduleTask` are a real zero-argument tool plus a
 * stub carrying the `homeAssistant` name and an arg schema, so the allowlist and
 * the schema check are both exercised.
 */
import { describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
    createJobsTools,
    describeJob,
    formatJobLine,
    formatLocal,
    formatRelative,
    MAX_DURATION_MINUTES,
    MIN_DURATION_SECONDS,
} from "../src/llm/tools/jobs";
import { getCurrentTime } from "../src/llm/tools/time";
import { isSchedulableTool } from "../src/scheduler/tools";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import type { StructuredToolInterface } from "@langchain/core/tools";

/** Thursday 2026-01-01 19:05 local. */
const NOW = new Date(2026, 0, 1, 19, 5, 0, 0);

/** A stub with homeAssistant's name and an argument schema, for validation. */
const HOME_ASSISTANT_STUB = tool(async () => "ok", {
    name: "homeAssistant",
    description: "test stub",
    schema: z.object({
        action: z.string(),
        entity_id: z.string(),
    }),
});

/** The tools `scheduleTask` may pick from in these tests. */
const SCHEDULABLE: StructuredToolInterface[] = [
    getCurrentTime,
    HOME_ASSISTANT_STUB,
];

interface Harness {
    store: AppDatabase;
    userId: number;
    /** Invokes one tool as the signed-in owner and returns its text. */
    call: (name: string, args: Record<string, unknown>) => Promise<string>;
    /** Invokes one tool as a guest (no `userId` in the runtime). */
    asGuest: (name: string, args: Record<string, unknown>) => Promise<string>;
    /** The tool instance, for schema assertions. */
    tool: (name: string) => StructuredToolInterface;
    jobs: () => ReturnType<AppDatabase["listJobs"]>;
}

/** Builds the tools over a fresh in-memory ledger with a fixed clock and ids. */
function harness(
    options: {
        maxPerUser?: number;
        maxHorizonMs?: number;
        at?: Date;
    } = {},
): Harness {
    const store = createInMemoryAppDatabase();
    const userId = store.createUser("luke", "hash", "owner").id;
    const at = options.at ?? NOW;
    let idSeq = 0;
    const instances = createJobsTools({
        ledger: store,
        maxPerUser: options.maxPerUser ?? 50,
        maxHorizonMs: options.maxHorizonMs ?? 366 * 86_400_000,
        tools: SCHEDULABLE,
        now: () => at,
        newId: () => `job-${(idSeq += 1)}`,
    });
    const byName = new Map(
        instances.map((instance) => [instance.name, instance]),
    );
    const toolFor = (name: string): StructuredToolInterface => {
        const found = byName.get(name);
        if (found === undefined) {
            throw new Error(`no tool named ${name}`);
        }
        return found;
    };
    const call = async (
        name: string,
        args: Record<string, unknown>,
        runtime: Record<string, unknown> = {
            configurable: { sessionId: "s1", clientIp: "10.0.0.1", userId },
        },
    ): Promise<string> => (await toolFor(name).invoke(args, runtime)) as string;
    return {
        store,
        userId,
        call: (name, args) => call(name, args),
        asGuest: (name, args) =>
            call(name, args, {
                configurable: { sessionId: "s1", clientIp: "10.0.0.1" },
            }),
        tool: toolFor,
        jobs: () => store.listJobs(userId),
    };
}

/** The local fields of a stored job's moment, so tests stay timezone-proof. */
function localFields(job: {
    runAt: string;
}): [number, number, number, number, number] {
    const at = new Date(job.runAt);
    return [
        at.getFullYear(),
        at.getMonth() + 1,
        at.getDate(),
        at.getHours(),
        at.getMinutes(),
    ];
}

describe("jobs tools: the class comes from the tool", () => {
    it("stores the class each tool owns, never one the model supplied", async () => {
        const h = harness();

        await h.call("setTimer", { label: "Pasta", minutes: 10 });
        await h.call("remindMe", { label: "Call Mum", at: "20:00" });
        await h.call("scheduleTask", {
            label: "Lights on",
            tool: "homeAssistant",
            args: { action: "turn_on", entity_id: "light.porch" },
            inMinutes: 5,
        });

        // Newest first: the task, the reminder, the timer.
        expect(h.jobs().map((job) => [job.class, job.kind, job.label])).toEqual(
            [
                ["notification", "tool", "Lights on"],
                ["reminder", "message", "Call Mum"],
                ["timer", "message", "Pasta"],
            ],
        );
    });

    it("exposes no way for the model to choose a class or a priority", () => {
        const h = harness();
        for (const name of ["setTimer", "remindMe", "scheduleTask"]) {
            const schema = h.tool(name).schema as {
                shape?: Record<string, unknown>;
            };
            const fields = Object.keys(schema.shape ?? {});
            expect(fields).not.toContain("class");
            expect(fields).not.toContain("priority");
        }
    });

    it("refuses a guest in the same words as the other tools", async () => {
        const h = harness();
        for (const [name, args] of [
            ["setTimer", { label: "Pasta", minutes: 5 }],
            ["remindMe", { label: "Call Mum", inMinutes: 5 }],
            [
                "scheduleTask",
                { label: "Lights", tool: "getCurrentTime", inMinutes: 5 },
            ],
            ["listJobs", {}],
            ["cancelJob", { id: "job-1" }],
        ] as const) {
            expect(await h.asGuest(name, args)).toContain(
                "requires signing in",
            );
        }
        expect(h.jobs()).toEqual([]);
    });
});

describe("jobs tools: setTimer", () => {
    it("stores a message job 'minutes' from now and says when it fires", async () => {
        const h = harness();

        const text = await h.call("setTimer", {
            label: "Pasta",
            message: "Drain it.",
            minutes: 10,
        });

        const [job] = h.jobs();
        expect(job).toMatchObject({
            class: "timer",
            kind: "message",
            label: "Pasta",
            message: "Drain it.",
            state: "pending",
        });
        expect(new Date(job.runAt).getTime()).toBe(NOW.getTime() + 600_000);
        expect(text).toContain('Timer set: "Pasta" (job job-1)');
        expect(text).toContain("in 10 minutes");
        expect(text).toContain("7:15 PM");
    });

    it("uses the headline as the message when no detail is given", async () => {
        const h = harness();

        await h.call("setTimer", { label: "Pasta", minutes: 10 });

        expect(h.jobs()[0].message).toBe("Pasta");
    });

    it("takes any length, down to a second", async () => {
        const h = harness();

        await h.call("setTimer", { label: "Tea", seconds: 10 });
        await h.call("setTimer", { label: "Pasta", minutes: 10 });

        const [pasta, tea] = h.jobs();
        // Ten seconds is an ordinary thing to ask a timer for; the floor is
        // what the clock can express, not what felt sensible.
        expect(new Date(tea.runAt).getTime()).toBe(NOW.getTime() + 10_000);
        expect(new Date(pasta.runAt).getTime()).toBe(NOW.getTime() + 600_000);
    });

    it("refuses a length that is not a positive one, or too long", async () => {
        const h = harness();
        for (const args of [
            { label: "Tea", seconds: 0 },
            { label: "Tea", minutes: 0 },
            { label: "Tea", minutes: -1 },
            { label: "Tea", minutes: MAX_DURATION_MINUTES + 1 },
        ]) {
            const text = await h.call("setTimer", args);
            const tooShort = `at least ${MIN_DURATION_SECONDS} second`;
            expect(
                text.includes(tooShort) || text.includes("longer than"),
            ).toBe(true);
        }
        expect(h.jobs()).toEqual([]);
    });

    it("refuses both units at once, or neither", async () => {
        const h = harness();

        expect(
            await h.call("setTimer", { label: "Tea", minutes: 1, seconds: 30 }),
        ).toContain("not both");
        expect(await h.call("setTimer", { label: "Tea" })).toContain(
            "give `minutes`",
        );
        expect(h.jobs()).toEqual([]);
    });
});

describe("jobs tools: remindMe", () => {
    it("resolves a clock time the way the resolver does", async () => {
        const h = harness();

        const text = await h.call("remindMe", {
            label: "Call Mum",
            at: "20:00",
        });

        const [job] = h.jobs();
        expect(job).toMatchObject({ class: "reminder", kind: "message" });
        expect(localFields(job)).toEqual([2026, 1, 1, 20, 0]);
        expect(text).toContain("Reminder scheduled");
        expect(text).toContain("today at 8:00 PM");
    });

    it("takes tomorrow when tonight's time has gone", async () => {
        const h = harness();

        await h.call("remindMe", { label: "Call Mum", at: "08:00" });

        expect(localFields(h.jobs()[0])).toEqual([2026, 1, 2, 8, 0]);
    });

    it("takes a named day", async () => {
        const h = harness();

        await h.call("remindMe", {
            label: "Call Mum",
            at: "08:00",
            onDate: "tomorrow",
        });

        expect(localFields(h.jobs()[0])).toEqual([2026, 1, 2, 8, 0]);
    });

    it("refuses a time it cannot resolve, with the reason to relay", async () => {
        const h = harness();

        expect(await h.call("remindMe", { label: "Call Mum" })).toContain(
            "no time was given",
        );
        expect(
            await h.call("remindMe", { label: "Call Mum", at: "tomorrow" }),
        ).toContain("24-hour clock time");
        expect(h.jobs()).toEqual([]);
    });

    it("predicts quiet hours without moving the job", async () => {
        const h = harness({ at: new Date(2026, 0, 1, 23, 30) });
        h.store.setPrefs(h.userId, [
            {
                key: "notify.quietHours",
                value: { start: "22:00", end: "07:00" },
            },
        ]);

        const text = await h.call("remindMe", {
            label: "Call Mum",
            at: "05:00",
        });

        // The tool says what will happen — it does not pre-defer. The runner
        // owns that decision and reads the window live when the job is due.
        expect(text).toContain("falls inside quiet hours (10:00 PM–7:00 AM)");
        expect(text).toContain("wait until 7:00 AM");
        expect(localFields(h.jobs()[0])).toEqual([2026, 1, 2, 5, 0]);
    });

    it("says quiet hours will hold a scheduled task's announcement", async () => {
        const h = harness({ at: new Date(2026, 0, 1, 23, 30) });
        h.store.setPrefs(h.userId, [
            {
                key: "notify.quietHours",
                value: { start: "22:00", end: "07:00" },
            },
        ]);

        const text = await h.call("scheduleTask", {
            label: "Lights on",
            tool: "homeAssistant",
            args: { action: "turn_on", entity_id: "light.porch" },
            at: "05:00",
        });

        expect(text).toContain("inside quiet hours");
        expect(text).toContain("wait until 7:00 AM instead of interrupting");
    });

    it("says a switched-off account will not be pushed", async () => {
        const h = harness();
        h.store.setPrefs(h.userId, [{ key: "notify.enabled", value: false }]);

        const text = await h.call("remindMe", {
            label: "Call Mum",
            inMinutes: 5,
        });

        expect(text).toContain("recorded but not pushed");
    });
});

describe("jobs tools: scheduleTask", () => {
    it("stores a tool job with the arguments it will run", async () => {
        const h = harness();

        const text = await h.call("scheduleTask", {
            label: "Lights on",
            tool: "homeAssistant",
            args: { action: "turn_on", entity_id: "light.porch" },
            inMinutes: 25,
        });

        const [job] = h.jobs();
        expect(job).toMatchObject({
            class: "notification",
            kind: "tool",
            toolName: "homeAssistant",
            toolArgs: { action: "turn_on", entity_id: "light.porch" },
        });
        expect(text).toContain("(runs homeAssistant)");
        expect(text).toContain("in 25 minutes");
    });

    it("refuses a tool the allowlist keeps out of a stored call", async () => {
        const h = harness();
        for (const name of [
            "sendNotification",
            "analyzeImage",
            "setTimer",
            "listJobs",
        ]) {
            const text = await h.call("scheduleTask", {
                label: "Sneaky",
                tool: name,
                inMinutes: 5,
            });
            expect(text).toContain(`'${name}' cannot be scheduled`);
        }
        expect(h.jobs()).toEqual([]);
    });

    it("refuses a schedulable tool this server does not have", async () => {
        const h = harness();

        // Allowlisted, but no search provider is configured here — a job that
        // could only fail at its due moment must fail now instead.
        const text = await h.call("scheduleTask", {
            label: "Search",
            tool: "webSearch",
            inMinutes: 5,
        });

        expect(text).toContain("the 'webSearch' tool is not available");
        expect(h.jobs()).toEqual([]);
    });

    it("refuses arguments the tool would reject at the due moment", async () => {
        const h = harness();

        const text = await h.call("scheduleTask", {
            label: "Lights on",
            tool: "homeAssistant",
            args: { action: "turn_on" },
            inMinutes: 25,
        });

        expect(text).toContain("needs different arguments");
        expect(text).toContain("entity_id");
        expect(h.jobs()).toEqual([]);
    });
});

describe("jobs tools: the bounds", () => {
    it("refuses past the scheduling horizon", async () => {
        const h = harness({ maxHorizonMs: 2 * 86_400_000 });

        const text = await h.call("remindMe", {
            label: "Far away",
            inMinutes: 3 * 24 * 60,
        });

        expect(text).toContain("more than 2 days ahead");
        expect(h.jobs()).toEqual([]);
    });

    it("refuses at the per-user cap, and says how to make room", async () => {
        const h = harness({ maxPerUser: 2 });
        await h.call("remindMe", { label: "One", inMinutes: 5 });
        await h.call("remindMe", { label: "Two", inMinutes: 10 });

        const text = await h.call("remindMe", {
            label: "Three",
            inMinutes: 15,
        });

        expect(text).toContain("already has 2 jobs scheduled");
        expect(text).toContain("cancel one");
        expect(h.jobs()).toHaveLength(2);
    });

    it("refuses text the announcement could not carry", async () => {
        const h = harness();

        expect(
            await h.call("remindMe", { label: "x".repeat(201), inMinutes: 5 }),
        ).toContain("`label` must be at most 200 characters");
        expect(
            await h.call("remindMe", {
                label: "Fine",
                message: "y".repeat(2001),
                inMinutes: 5,
            }),
        ).toContain("`message` must be at most 2000 characters");
        expect(h.jobs()).toEqual([]);
    });
});

describe("jobs tools: listJobs and cancelJob", () => {
    it("says when nothing is scheduled", async () => {
        expect(await harness().call("listJobs", {})).toBe(
            "No jobs are scheduled.",
        );
    });

    it("lists the jobs still owed, newest first, with ids and times", async () => {
        const h = harness();
        await h.call("remindMe", { label: "Call Mum", at: "20:00" });
        await h.call("setTimer", { label: "Pasta", minutes: 10 });

        const text = await h.call("listJobs", {});

        expect(text).toMatch(/^2 scheduled jobs:/);
        expect(text).toContain(
            '- job-2 (timer) "Pasta" — today at 7:15 PM, in 10 minutes',
        );
        expect(text).toContain(
            '- job-1 (reminder) "Call Mum" — today at 8:00 PM, in 55 minutes',
        );
    });

    it("cancels a pending job by its exact id", async () => {
        const h = harness();
        await h.call("remindMe", { label: "Call Mum", at: "20:00" });

        const text = await h.call("cancelJob", { id: "job-1" });

        expect(text).toContain('Cancelled "Call Mum" (job-1)');
        expect(text).toContain("today at 8:00 PM");
        expect(h.store.getJob(h.userId, "job-1")?.state).toBe("cancelled");
        // A cancelled job is settled, so it leaves the listing behind.
        expect(await h.call("listJobs", {})).toBe("No jobs are scheduled.");
    });

    it("treats an unknown id — and another user's — as missing", async () => {
        const h = harness();
        const other = h.store.createUser("someone", "hash", "user").id;
        h.store.createJob(other, {
            id: "not-yours",
            label: "Theirs",
            kind: "message",
            message: "Theirs",
            runAt: "2026-01-02T09:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
        });

        for (const id of ["job-404", "not-yours"]) {
            expect(await h.call("cancelJob", { id })).toContain(
                `There is no job with the id "${id}"`,
            );
        }
        expect(h.store.getJob(other, "not-yours")?.state).toBe("pending");
    });

    it("says a finished job cannot be cancelled", async () => {
        const h = harness();
        await h.call("remindMe", { label: "Call Mum", inMinutes: 5 });
        await h.call("cancelJob", { id: "job-1" });

        expect(await h.call("cancelJob", { id: "job-1" })).toContain(
            "is already cancelled",
        );
    });
});

describe("jobs tools: snoozeReminder", () => {
    it("moves a reminder that has not fired yet, without an attempt", async () => {
        const h = harness();
        await h.call("remindMe", { label: "Call Mum", at: "20:00" });

        const text = await h.call("snoozeReminder", {
            id: "job-1",
            minutes: 60,
        });

        const [job] = h.jobs();
        expect(h.jobs()).toHaveLength(1);
        expect(job.id).toBe("job-1");
        expect(new Date(job.runAt).getTime()).toBe(NOW.getTime() + 60 * 60_000);
        expect(job.attempts).toBe(0);
        expect(text).toContain('Snoozed "Call Mum" (job-1) to');
        expect(text).toContain("in 1 hour");
    });

    it("re-sets a reminder that already ran, with the same text", async () => {
        const h = harness();
        await h.call("remindMe", {
            label: "Call Mum",
            message: "About the tickets.",
            at: "20:00",
        });
        h.store.claimJob("job-1");
        h.store.settleJob(
            "job-1",
            "done",
            {},
            new Date(NOW.getTime() + 1000).toISOString(),
        );

        const text = await h.call("snoozeReminder", {
            id: "job-1",
            minutes: 30,
        });

        const all = h.store.listJobs(h.userId, { includeSettled: true });
        const fresh = all.find((job) => job.state === "pending");
        expect(all).toHaveLength(2);
        expect(fresh).toMatchObject({
            class: "reminder",
            kind: "message",
            label: "Call Mum",
            message: "About the tickets.",
        });
        expect(fresh?.id).not.toBe("job-1");
        expect(new Date(fresh?.runAt ?? 0).getTime()).toBe(
            NOW.getTime() + 30 * 60_000,
        );
        expect(text).toContain("was due");
        expect(text).toContain("set another reminder");
    });

    it("refuses a job that is running, cancelled, or not a reminder", async () => {
        const h = harness();
        await h.call("remindMe", { label: "Running", at: "20:00" });
        h.store.claimJob("job-1");
        expect(
            await h.call("snoozeReminder", { id: "job-1", minutes: 10 }),
        ).toContain("is running right now");

        await h.call("remindMe", { label: "Gone", at: "21:00" });
        await h.call("cancelJob", { id: "job-2" });
        expect(
            await h.call("snoozeReminder", { id: "job-2", minutes: 10 }),
        ).toContain("was cancelled");

        await h.call("setTimer", { label: "Pasta", minutes: 5 });
        expect(
            await h.call("snoozeReminder", { id: "job-3", minutes: 10 }),
        ).toContain("only a reminder can be snoozed");
        await h.call("scheduleTask", {
            label: "Lights",
            tool: "getCurrentTime",
            args: { question: "What time is it?" },
            inMinutes: 5,
        });
        expect(
            await h.call("snoozeReminder", { id: "job-4", minutes: 10 }),
        ).toContain("only a reminder can be snoozed");
    });

    it("treats an unknown id — and another user's — as missing", async () => {
        const h = harness();
        const other = h.store.createUser("someone", "hash", "user").id;
        h.store.createJob(other, {
            id: "not-yours",
            label: "Theirs",
            class: "reminder",
            kind: "message",
            message: "Theirs",
            runAt: "2026-01-02T09:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
        });

        for (const id of ["job-404", "not-yours"]) {
            expect(
                await h.call("snoozeReminder", { id, minutes: 10 }),
            ).toContain(`There is no job with the id "${id}"`);
        }
    });

    it("snoozes as far as a week, and refuses anything outside that", async () => {
        const h = harness();
        await h.call("remindMe", { label: "Call Mum", at: "20:00" });

        // The menu's furthest preset is "next week"; the policy allows it, and
        // the tool is the same door (`create.ts`'s snooze).
        expect(
            await h.call("snoozeReminder", {
                id: "job-1",
                minutes: 7 * 24 * 60,
            }),
        ).toContain("Snoozed");

        expect(
            await h.call("snoozeReminder", { id: "job-1", minutes: 0 }),
        ).toContain("must be between");
        expect(
            await h.call("snoozeReminder", {
                id: "job-1",
                minutes: 7 * 24 * 60 + 1,
            }),
        ).toContain("must be between");
    });

    it("predicts quiet hours for the new moment", async () => {
        const h = harness({ at: new Date(2026, 0, 1, 23, 30) });
        h.store.setPrefs(h.userId, [
            {
                key: "notify.quietHours",
                value: { start: "22:00", end: "07:00" },
            },
        ]);
        await h.call("remindMe", { label: "Call Mum", at: "23:45" });

        const text = await h.call("snoozeReminder", {
            id: "job-1",
            minutes: 60,
        });

        expect(text).toContain("wait until 7:00 AM");
    });

    it("keeps every scheduling tool out of the schedulable allowlist", () => {
        for (const name of [
            "setTimer",
            "remindMe",
            "scheduleTask",
            "listJobs",
            "cancelJob",
            "snoozeReminder",
        ]) {
            expect(isSchedulableTool(name)).toBe(false);
        }
    });
});

describe("jobs tools: formatting", () => {
    it("says today, tomorrow, and the weekday for further days", () => {
        expect(formatLocal(new Date(2026, 0, 1, 20, 0), NOW)).toBe(
            "today at 8:00 PM",
        );
        expect(formatLocal(new Date(2026, 0, 2, 8, 0), NOW)).toBe(
            "tomorrow at 8:00 AM",
        );
        expect(formatLocal(new Date(2026, 0, 9, 8, 0), NOW)).toBe(
            "Friday 2026-01-09 at 8:00 AM",
        );
    });

    it("rounds a distance to the unit a person would use", () => {
        expect(formatRelative(new Date(NOW.getTime() + 30_000), NOW)).toBe(
            "in under a minute",
        );
        expect(formatRelative(new Date(NOW.getTime() + 600_000), NOW)).toBe(
            "in 10 minutes",
        );
        expect(
            formatRelative(new Date(NOW.getTime() + 3 * 3_600_000), NOW),
        ).toBe("in 3 hours");
        expect(
            formatRelative(new Date(NOW.getTime() + 3 * 86_400_000), NOW),
        ).toBe("in 3 days");
        expect(formatRelative(new Date(NOW.getTime() - 120_000), NOW)).toBe(
            "2 minutes ago",
        );
    });

    it("describes a job with its id, moment, and payload", () => {
        const h = harness();
        return (async () => {
            await h.call("scheduleTask", {
                label: "Lights on",
                tool: "homeAssistant",
                args: { action: "turn_on", entity_id: "light.porch" },
                inMinutes: 25,
            });
            const [job] = h.jobs();
            expect(describeJob(job, NOW)).toBe(
                '"Lights on" (job job-1) — today at 7:30 PM, in 25 minutes (runs homeAssistant)',
            );
            expect(formatJobLine(job, NOW)).toBe(
                '- job-1 (notification) "Lights on" — today at 7:30 PM, in 25 minutes',
            );
        })();
    });
});

describe("scheduling a repeating job (#90 phase 8d)", () => {
    it("says the cadence back, and anchors the rule where the words pointed", async () => {
        const h = harness();

        const text = await h.call("remindMe", {
            label: "Standup",
            at: "09:00",
            repeat: { every: "week", weekdays: ["mo", "tu", "sa"] },
        });

        // The echo is the point: a model that mis-stated the days reads them
        // back before the user has to wait for the first one.
        expect(text).toMatch(/every Monday, Tuesday and Saturday at 09:00/);
        const job = h.jobs()[0];
        const rule = job?.repeat as {
            every: string;
            interval: number;
            start: string;
        };
        expect(rule).toMatchObject({
            every: "week",
            interval: 1,
            weekdays: ["mo", "tu", "sa"],
        });
        // The anchor is the instant the words resolved to, at the clock they
        // named...
        const anchor = new Date(rule.start);
        expect([anchor.getHours(), anchor.getMinutes()]).toEqual([9, 0]);
        // ...and the job is due at the rule's *next* occurrence, which is a day
        // in the set rather than the anchor itself once that has passed.
        const due = new Date(String(job?.runAt));
        expect([due.getHours(), due.getMinutes()]).toEqual([9, 0]);
        expect([1, 2, 6]).toContain(due.getDay());
        expect(due.getTime()).toBeGreaterThan(anchor.getTime());
    });

    it("carries the count it was given", async () => {
        const h = harness();

        const text = await h.call("scheduleTask", {
            label: "Water the plants",
            tool: "getCurrentTime",
            args: { question: "what time is it" },
            at: "10:00",
            repeat: { every: "minute", interval: 30, ends: { after: 12 } },
        });

        expect(text).toMatch(/every 30 minutes/);
        expect(h.jobs()[0]?.repeat).toMatchObject({
            every: "minute",
            interval: 30,
            ends: { after: 12 },
        });
    });

    it("refuses what this server will not keep, in the model's words", async () => {
        const h = harness();

        // A reminder that fires every five minutes announces every firing.
        const tooFast = await h.call("remindMe", {
            label: "Nag",
            inMinutes: 60,
            repeat: { every: "minute", interval: 5 },
        });
        expect(tooFast).toMatch(/every 5 minutes is too often/);

        // Days of the week belong to a week or a month, which the rule says.
        const mixed = await h.call("remindMe", {
            label: "Misread",
            at: "09:00",
            repeat: { every: "day", weekdays: ["mo"] },
        });
        expect(mixed).toMatch(/applies to a week or month rule/);
    });

    it("lists a repeating job with its cadence", async () => {
        const h = harness();
        await h.call("remindMe", {
            label: "Standup",
            at: "09:00",
            repeat: { every: "day" },
        });

        const text = await h.call("listJobs", {});

        expect(text).toMatch(/repeating every day at 09:00/);
    });
});
