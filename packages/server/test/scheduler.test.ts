/**
 * Scheduler tests (#90 phase 1): the loop and the runner.
 *
 * The model is stubbed at the agent seam and the tools are fakes, so these are
 * about the *bookkeeping* a scheduled run must not get wrong:
 *
 * - a run that happened leaves a run row, a settled job, and one announcement —
 *   including when it failed, because a silent failure is the class this whole
 *   area exists to remove;
 * - a job fires once, however many ticks look at it;
 * - a job whose moment passed while the server was down is `missed` (not
 *   attempted, not left claiming to be in progress), and so is a run a dead
 *   process left behind;
 * - and a job's runs are **not** conversations: the thread is `job:<id>`, and
 *   the chat-session ledger never hears about it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase, CreateJobInput } from "@lukestanbery/jarvis-auth";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { createNotificationHub } from "../src/notify/hub";
import type { HubSocket } from "../src/notify/hub";
import { createInAppChannel } from "../src/notify/channels/inApp";
import { createNotificationService } from "../src/notify/service";
import type { NotificationService } from "../src/notify/service";
import { createJobRunner, jobThreadId } from "../src/scheduler/runner";
import type { JobAgentRunner, JobRunner } from "../src/scheduler/runner";
import { createScheduler } from "../src/scheduler/loop";
import type { Scheduler } from "../src/scheduler/loop";
import type { AgentEvent } from "../src/agent";

/** A socket double that records the frames the hub pushed to it. */
function fakeSocket(): HubSocket & { frames: ServerFrame[] } {
    const frames: ServerFrame[] = [];
    return {
        readyState: 1,
        frames,
        send(data: string) {
            frames.push(JSON.parse(data) as ServerFrame);
        },
    };
}

/** The notification frames one socket has received, newest first. */
function pushed(socket: ReturnType<typeof fakeSocket>): {
    kind: string;
    title: string;
    body?: string;
}[] {
    return socket.frames
        .map((frame) => ("notification" in frame ? frame.notification : null))
        .filter((n) => n !== null)
        .map((n) => ({ kind: n.kind, title: n.title, body: n.body }));
}

/** An agent seam that answers with `reply`, recording how it was called. */
function fakeAgent(reply: string): {
    agent: JobAgentRunner;
    calls: { prompt: string; sessionId: string; userId?: number }[];
} {
    const calls: { prompt: string; sessionId: string; userId?: number }[] = [];
    const agent: JobAgentRunner = async function* (prompt, sessionId, options) {
        calls.push({
            prompt,
            sessionId,
            ...(options?.userId !== undefined
                ? { userId: options.userId }
                : {}),
        });
        yield { type: "token", text: reply } satisfies AgentEvent;
    };
    return { agent, calls };
}

/** An agent seam that fails, the way a model that is not running does. */
function failingAgent(message: string): JobAgentRunner {
    const agent: JobAgentRunner = async function* () {
        // A generator's body only runs on the first `next()`, which is where
        // the failure has to land: consuming the stream is the run.
        await Promise.resolve();
        throw new Error(message);
    };
    return agent;
}

/** An agent seam that hangs until its signal aborts — the timeout case. */
function hangingAgent(): JobAgentRunner {
    const agent: JobAgentRunner = async function* (_prompt, _session, options) {
        await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
            );
        });
        yield { type: "token", text: "" } satisfies AgentEvent;
    };
    return agent;
}

/** A tool that records its arguments and runtime, and returns `result`. */
function recordingTool(
    name: string,
    result: string,
): {
    instance: StructuredToolInterface;
    calls: { args: unknown; runtime: ToolRuntime }[];
} {
    const calls: { args: unknown; runtime: ToolRuntime }[] = [];
    const instance = tool(
        async (args, runtime: ToolRuntime) => {
            calls.push({ args, runtime });
            return result;
        },
        {
            name,
            description: `fake ${name}`,
            schema: z.object({ value: z.string().optional() }),
        },
    );
    return { instance, calls };
}

/** The pieces one test needs, wired the way `index.ts` wires them. */
function harness(options: {
    at: Date;
    actor?: JobAgentRunner;
    tools?: StructuredToolInterface[];
    turnTimeoutMs?: number;
    maxLatenessMs?: number;
    maxPerUser?: number;
    maxPerTick?: number;
}): {
    store: AppDatabase;
    userId: number;
    scheduler: Scheduler;
    runner: JobRunner;
    socket: ReturnType<typeof fakeSocket>;
} {
    const store = createInMemoryAppDatabase();
    const userId = store.createUser("luke", "hash", "owner").id;
    const hub = createNotificationHub();
    const socket = fakeSocket();
    hub.add(userId, socket);
    const notifications = createNotificationService({
        store,
        hub,
        channels: [createInAppChannel(hub)],
        maxPerUser: 50,
        deliveriesPerWindow: 20,
        now: () => options.at,
    });
    let runSeq = 0;
    const runner = createJobRunner({
        ledger: store,
        notifications,
        tools: options.tools ?? [],
        turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
        maxPerUser: options.maxPerUser ?? 50,
        maxLatenessMs: options.maxLatenessMs ?? 60 * 60 * 1000,
        now: () => options.at,
        ...(options.actor ? { agent: options.actor } : {}),
        newId: () => `run-${(runSeq += 1)}`,
    });
    const scheduler = createScheduler({
        ledger: store,
        runner,
        tickMs: 1_000,
        maxConcurrent: options.maxPerTick ?? 1,
        now: () => options.at,
    });
    return { store, userId, scheduler, runner, socket };
}

/** A due prompt job, with everything a test might want to vary. */
function promptJob(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
    return {
        label: "Change the AC filter",
        kind: "prompt",
        prompt: "Remind me to change the AC filter.",
        runAt: "2026-10-20T09:00:00.000Z",
        ...overrides,
    };
}

/** A due tool job. */
function toolJob(name: string, args: unknown = {}): CreateJobInput {
    return {
        label: "Kitchen light",
        kind: "tool",
        toolName: name,
        toolArgs: args,
        runAt: "2026-10-20T09:00:00.000Z",
    };
}

/** The instant every test's clock sits at: one second after the jobs' due time. */
const AT = new Date("2026-10-20T09:00:01.000Z");

describe("scheduler: a prompt job", () => {
    it("runs the turn, records the reply, and announces it", async () => {
        const { agent, calls } = fakeAgent("The filter is in the cupboard.");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.considered).toBe(1);
        expect(summary.outcomes).toEqual([
            { kind: "done", output: "The filter is in the cupboard." },
        ]);
        // The turn ran as the job's owner, on the job's own thread.
        expect(calls).toEqual([
            {
                prompt: "Remind me to change the AC filter.",
                sessionId: "job:j1",
                userId: h.userId,
            },
        ]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "done",
            attempts: 1,
            settledAt: AT.toISOString(),
        });
        expect(h.store.listJobRuns("j1")).toMatchObject([
            {
                state: "ok",
                output: "The filter is in the cupboard.",
                finishedAt: AT.toISOString(),
            },
        ]);
        expect(pushed(h.socket)).toEqual([
            {
                kind: "job.finished",
                title: "Change the AC filter",
                body: "The filter is in the cupboard.",
            },
        ]);
    });

    it("keeps a job's runs out of the chat-thread ledger", async () => {
        const { agent } = fakeAgent("done");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        // A job owns its thread (so its runs share memory), but that thread is
        // not a conversation: the ledger — and therefore every sidebar — has
        // never heard of it.
        expect(h.store.getSessionByThread(jobThreadId("j1"))).toBeNull();
        expect(h.store.listOwnedSessions(h.userId)).toEqual([]);
    });

    it("records a failure with its reason and does not retry it", async () => {
        const h = harness({
            at: AT,
            actor: failingAgent("the model is not reachable"),
        });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "failed", error: "the model is not reachable" },
        ]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "failed",
            attempts: 1,
            lastError: "the model is not reachable",
        });
        expect(h.store.listJobRuns("j1")).toMatchObject([
            {
                state: "failed",
                output: null,
                error: "the model is not reachable",
            },
        ]);
        expect(pushed(h.socket)[0].kind).toBe("job.failed");

        // No retries by design: the failure is the record, and the user
        // re-asks. The next tick finds nothing to do.
        const again = await h.scheduler.tick();
        expect(again.considered).toBe(0);
        expect(h.store.getJob(h.userId, "j1")?.attempts).toBe(1);
    });

    it("stops a hung turn at the turn timeout and says why", async () => {
        const h = harness({ at: AT, actor: hangingAgent(), turnTimeoutMs: 5 });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toMatchObject([{ kind: "failed" }]);
        expect(h.store.getJob(h.userId, "j1")?.lastError).toMatch(
            /still going after 0s and was stopped|still going after 1s/,
        );
    });
});

describe("scheduler: a tool job", () => {
    it("invokes the tool with the graph's runtime and never touches the model", async () => {
        const recorder = recordingTool("homeAssistant", "Turned the light on.");
        const { agent, calls } = fakeAgent("should not be used");
        const h = harness({ at: AT, actor: agent, tools: [recorder.instance] });
        h.store.createJob(h.userId, {
            ...toolJob("homeAssistant", { value: "turn it on" }),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "done", output: "Turned the light on." },
        ]);
        expect(calls).toEqual([]);
        expect(recorder.calls).toHaveLength(1);
        expect(recorder.calls[0].args).toEqual({ value: "turn it on" });
        // The same runtime a graph turn stamps, so the gates inside the tool
        // (quotas, ownership) see exactly what they would in chat.
        expect(recorder.calls[0].runtime.configurable).toMatchObject({
            sessionId: "job:j1",
            userId: h.userId,
        });
        expect(h.store.listJobRuns("j1")[0].output).toBe(
            "Turned the light on.",
        );
        // The announcement is part of the contract for a tool job too, not only
        // for a prompt one — this is the pair the manual smoke test observed.
        expect(pushed(h.socket)).toEqual([
            {
                kind: "job.finished",
                title: "Kitchen light",
                body: "Turned the light on.",
            },
        ]);
    });

    it("refuses to schedule the announcement tool itself", async () => {
        const recorder = recordingTool("sendNotification", "should not run");
        const h = harness({ at: AT, tools: [recorder.instance] });
        h.store.createJob(h.userId, {
            ...toolJob("sendNotification", { value: "hello" }),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        // The runner announces every run, so scheduling the notification tool
        // would announce twice for one job — which the first end-to-end smoke
        // test caught. A job that wants to say something says it as its own
        // text (phase 2's message payload).
        expect(recorder.calls).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "failed",
            lastError: "'sendNotification' cannot be scheduled",
        });
        expect(pushed(h.socket)).toHaveLength(1);
    });

    it("fails a tool outside the allowlist instead of calling it", async () => {
        const recorder = recordingTool("analyzeImage", "should not run");
        const h = harness({ at: AT, tools: [recorder.instance] });
        h.store.createJob(h.userId, {
            ...toolJob("analyzeImage"),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        expect(recorder.calls).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "failed",
            lastError: "'analyzeImage' cannot be scheduled",
        });
        expect(pushed(h.socket)[0]).toMatchObject({
            kind: "job.failed",
            body: "'analyzeImage' cannot be scheduled",
        });
    });

    it("fails a job whose tool this server does not have", async () => {
        const h = harness({ at: AT, tools: [] });
        h.store.createJob(h.userId, {
            ...toolJob("homeAssistant"),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        // The configuration changed between scheduling and firing — the case
        // the fire-time check exists for.
        expect(h.store.getJob(h.userId, "j1")?.lastError).toBe(
            "the 'homeAssistant' tool is not available on this server",
        );
    });
});

describe("scheduler: a message job", () => {
    /** Quiet hours covering the harness's fixed clock, in its local time. */
    function quietAt(at: Date): { start: string; end: string } {
        const pad = (n: number) => String(n).padStart(2, "0");
        const clock = (offsetMinutes: number) => {
            const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
            return `${pad(shifted.getHours())}:${pad(shifted.getMinutes())}`;
        };
        return { start: clock(-60), end: clock(60) };
    }

    it("delivers the job's own text with no model and no tool", async () => {
        const { agent, calls } = fakeAgent("should not be used");
        const recorder = recordingTool("getCurrentTime", "should not be used");
        const h = harness({
            at: AT,
            actor: agent,
            tools: [recorder.instance],
        });
        h.store.createJob(h.userId, {
            id: "j1",
            label: "Kettle",
            kind: "message",
            message: "Take the kettle off the heat.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "done", output: "Take the kettle off the heat." },
        ]);
        expect(calls).toEqual([]);
        expect(recorder.calls).toEqual([]);
        expect(h.store.listJobRuns("j1")[0].output).toBe(
            "Take the kettle off the heat.",
        );
        expect(pushed(h.socket)).toEqual([
            {
                kind: "job.finished",
                title: "Kettle",
                body: "Take the kettle off the heat.",
            },
        ]);
    });

    it("lets a timer through quiet hours and holds a notification", async () => {
        const h = harness({ at: AT });
        h.store.setPrefs(h.userId, [
            { key: "notify.quietHours", value: quietAt(AT) },
        ]);
        h.store.createJob(h.userId, {
            id: "timer",
            label: "Kettle",
            class: "timer",
            kind: "message",
            message: "Take the kettle off.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        h.store.createJob(h.userId, {
            id: "info",
            label: "Filter",
            kind: "message",
            message: "The filter is in the cupboard.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:01.000Z",
        });

        await h.scheduler.tick();
        await h.scheduler.tick();

        // Both ran and recorded their text; the difference is only whether the
        // announcement was allowed to interrupt. The held one is in the user's
        // list (pending), which is why being quiet loses nothing.
        expect(h.store.listJobRuns("timer")[0].state).toBe("ok");
        expect(h.store.listJobRuns("info")[0].state).toBe("ok");
        expect(pushed(h.socket)).toEqual([
            {
                kind: "job.finished",
                title: "Kettle",
                body: "Take the kettle off.",
            },
        ]);
        const stored = h.store.listNotifications(h.userId);
        expect(stored).toHaveLength(2);
        expect(stored.map((n) => [n.title, n.class, n.state]).sort()).toEqual([
            ["Filter", "notification", "pending"],
            ["Kettle", "timer", "delivered"],
        ]);
    });
});

describe("scheduler: the running loop", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("recovers interrupted work before it starts ticking", async () => {
        const { agent } = fakeAgent("ok");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        h.store.claimJob("j1");
        h.store.startJobRun({
            id: "run-old",
            jobId: "j1",
            startedAt: "2026-10-20T08:00:00.000Z",
        });

        vi.useFakeTimers();
        // No tick has run yet, so the failed row proves recovery is the first
        // thing `start` does rather than something the first interval catches.
        await h.scheduler.start();
        try {
            expect(h.store.getJob(h.userId, "j1")).toMatchObject({
                state: "failed",
                lastError:
                    "the server restarted while this run was in progress",
            });
        } finally {
            h.scheduler.stop();
        }
    });

    it("ticks on the interval, and stops when asked", async () => {
        const { agent, calls } = fakeAgent("ok");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        vi.useFakeTimers();
        await h.scheduler.start();
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            expect(calls).toHaveLength(1);
            expect(h.store.getJob(h.userId, "j1")?.state).toBe("done");

            h.scheduler.stop();
            h.store.createJob(h.userId, {
                ...promptJob(),
                id: "j2",
                createdAt: "2026-10-15T18:00:01.000Z",
            });
            await vi.advanceTimersByTimeAsync(10_000);
            // Stopped means stopped: the second job is still owed.
            expect(calls).toHaveLength(1);
            expect(h.store.getJob(h.userId, "j2")?.state).toBe("pending");
        } finally {
            h.scheduler.stop();
        }
    });

    it("keeps ticking after a tick throws", async () => {
        let scans = 0;
        const ledger = {
            listRunningJobs: () => [],
            listDueJobs: () => {
                scans += 1;
                if (scans === 1) {
                    throw new Error("database is locked");
                }
                return [];
            },
        } as never;
        const runner: JobRunner = {
            run: async () => ({ kind: "done", output: "" }),
            recover: async () => ({ kind: "failed", error: "" }),
        };
        const scheduler = createScheduler({
            ledger,
            runner,
            tickMs: 1_000,
            maxConcurrent: 1,
        });

        vi.useFakeTimers();
        await scheduler.start();
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            // The first tick rejected; the interval kept going rather than
            // dying with it. A scheduler that stops after one bad tick is the
            // "nothing happened" failure this loop exists to avoid.
            expect(scans).toBe(2);
        } finally {
            scheduler.stop();
        }
    });
});

describe("scheduler: timing", () => {
    it("leaves work that is not due yet alone", async () => {
        const { agent, calls } = fakeAgent("too early");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob({ runAt: "2026-10-20T10:00:00.000Z" }),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.considered).toBe(0);
        expect(calls).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")?.state).toBe("pending");
    });

    it("runs a job that is late but still within the window", async () => {
        const { agent, calls } = fakeAgent("better late than never");
        const h = harness({
            at: AT,
            actor: agent,
            maxLatenessMs: 60 * 60 * 1000,
        });
        h.store.createJob(h.userId, {
            ...promptJob({ runAt: "2026-10-20T08:15:00.000Z" }),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "done", output: "better late than never" },
        ]);
        expect(calls).toHaveLength(1);
    });

    it("marks a job missed rather than attempting it long after its moment", async () => {
        const { agent, calls } = fakeAgent("should not run");
        const h = harness({
            at: AT,
            actor: agent,
            maxLatenessMs: 60 * 60 * 1000,
        });
        h.store.createJob(h.userId, {
            ...promptJob({ runAt: "2026-10-20T06:00:00.000Z" }),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([{ kind: "missed" }]);
        expect(calls).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "missed",
        });
        // Never attempted: no claim was taken, so no run row pretends it was.
        expect(h.store.listJobRuns("j1")).toEqual([]);
        expect(pushed(h.socket)[0]).toMatchObject({
            kind: "job.missed",
            title: "Change the AC filter",
        });
        expect(pushed(h.socket)[0].body).toMatch(/missed by 3h/);
    });

    it("fires a job once, however many ticks look at it", async () => {
        const { agent, calls } = fakeAgent("once");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();
        await h.scheduler.tick();

        expect(calls).toHaveLength(1);
        expect(h.store.getJob(h.userId, "j1")?.attempts).toBe(1);
    });

    it("refuses an overlapping tick rather than queueing it", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const slow: JobRunner = {
            run: async () => {
                await gate;
                return { kind: "done", output: "" };
            },
            recover: async () => ({ kind: "failed", error: "" }),
        };
        const scheduler = createScheduler({
            ledger: { listDueJobs: () => [] } as never,
            runner: slow,
            tickMs: 1_000,
            maxConcurrent: 1,
        });

        const first = scheduler.tick();
        const second = await scheduler.tick();

        expect(second).toEqual({
            considered: 0,
            outcomes: [],
            skippedTick: true,
        });
        release();
        expect((await first).skippedTick).toBe(false);
    });

    it("takes on at most what one tick allows, and finds the rest next time", async () => {
        const { agent, calls } = fakeAgent("ok");
        const h = harness({ at: AT, actor: agent, maxPerTick: 1 });
        for (let i = 0; i < 3; i += 1) {
            h.store.createJob(h.userId, {
                ...promptJob({ label: `job ${i}` }),
                id: `j${i}`,
                createdAt: `2026-10-15T1${i}:00:00.000Z`,
            });
        }

        const first = await h.scheduler.tick();
        expect(first.considered).toBe(3);
        expect(first.outcomes).toHaveLength(1);
        expect(calls).toHaveLength(1);

        await h.scheduler.tick();
        expect(calls).toHaveLength(2);
    });
});

describe("scheduler: recovery and retention", () => {
    it("fails a run a dead process left in flight, and says so once", async () => {
        const h = harness({ at: AT });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        // Exactly what a process that died mid-run leaves behind: claimed,
        // run started, never finished.
        h.store.claimJob("j1");
        h.store.startJobRun({
            id: "run-old",
            jobId: "j1",
            startedAt: "2026-10-20T08:00:00.000Z",
        });

        expect(await h.scheduler.recover()).toBe(1);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "failed",
            lastError: "the server restarted while this run was in progress",
        });
        expect(h.store.listJobRuns("j1")[0]).toMatchObject({
            state: "failed",
            error: "the server restarted while this run was in progress",
            finishedAt: AT.toISOString(),
        });
        expect(pushed(h.socket)).toHaveLength(1);

        // Idempotent: a second boot pass finds nothing left running.
        expect(await h.scheduler.recover()).toBe(0);
        expect(pushed(h.socket)).toHaveLength(1);
    });

    it("prunes a user's settled jobs after a run", async () => {
        const { agent } = fakeAgent("ok");
        const h = harness({ at: AT, actor: agent, maxPerUser: 1 });
        h.store.createJob(h.userId, {
            ...promptJob({ label: "old and settled" }),
            id: "old",
            createdAt: "2026-10-14T18:00:00.000Z",
        });
        h.store.settleJob("old", "done", {}, "2026-10-14T18:00:05.000Z");
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        expect(
            h.store
                .listJobs(h.userId, { includeSettled: true })
                .map((job) => job.id),
        ).toEqual(["j1"]);
    });
});

describe("scheduler: announcements are best-effort", () => {
    it("does not turn a completed run into a failure when the announcement fails", async () => {
        const store = createInMemoryAppDatabase();
        const userId = store.createUser("luke", "hash", "owner").id;
        const broken = {
            notify: async () => {
                throw new Error("notification store is unavailable");
            },
        } as unknown as NotificationService;
        const { agent } = fakeAgent("the reply");
        let seq = 0;
        const runner = createJobRunner({
            ledger: store,
            notifications: broken,
            tools: [],
            turnTimeoutMs: 5_000,
            maxPerUser: 50,
            maxLatenessMs: 60 * 60 * 1000,
            now: () => AT,
            agent,
            newId: () => `run-${(seq += 1)}`,
        });
        store.createJob(userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const outcome = await runner.run(store.getJob(userId, "j1")!);

        // The run row is the durable half: the reply is recorded, the job is
        // done, and the announcement's failure is somebody else's log line.
        expect(outcome).toEqual({ kind: "done", output: "the reply" });
        expect(store.listJobRuns("j1")[0].output).toBe("the reply");
        expect(store.getJob(userId, "j1")?.state).toBe("done");
    });
});
