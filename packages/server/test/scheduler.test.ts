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
import { gateKey, parseJobGate } from "@lukestanbery/jarvis-protocol";
import type { JobGate, ServerFrame } from "@lukestanbery/jarvis-protocol";
import { createNotificationHub } from "../src/notify/hub";
import type { HubSocket } from "../src/notify/hub";
import { createInAppChannel } from "../src/notify/channels/inApp";
import { createNotificationService } from "../src/notify/service";
import type { NotificationService } from "../src/notify/service";
import { createJobRunner, jobThreadId } from "../src/scheduler/runner";
import { createJobsTools } from "../src/llm/tools/jobs";
import type { JobAgentRunner, JobRunner } from "../src/scheduler/runner";
import { createScheduler } from "../src/scheduler/loop";
import { logger } from "../src/logger";
import {
    parseQuietHours,
    quietHoursEnd,
    type QuietHours,
} from "../src/notify/prefs";
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
    calls: {
        prompt: string;
        sessionId: string;
        userId?: number;
        deviceId?: number;
    }[];
} {
    const calls: {
        prompt: string;
        sessionId: string;
        userId?: number;
        deviceId?: number;
    }[] = [];
    const agent: JobAgentRunner = async function* (prompt, sessionId, options) {
        calls.push({
            prompt,
            sessionId,
            ...(options?.userId !== undefined
                ? { userId: options.userId }
                : {}),
            ...(options?.deviceId !== undefined
                ? { deviceId: options.deviceId }
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

/**
 * A stand-in for `homeAssistant`: the one tool a gate may read (#90 phase 8f).
 *
 * `read` is called per invocation rather than captured, so a test can move the
 * house between firings — which is the only way to see the difference between the
 * two answers a gate exists to compare. The schema mirrors the real tool's
 * discriminating argument, because the gate's action is checked against it.
 */
function homeAssistantDouble(read: () => string): {
    instance: StructuredToolInterface;
    calls: unknown[];
} {
    const calls: unknown[] = [];
    const instance = tool(
        async (args) => {
            calls.push(args);
            return read();
        },
        {
            name: "homeAssistant",
            description: "fake home assistant",
            schema: z.object({
                action: z.string(),
                entity_id: z.string().optional(),
            }),
        },
    );
    return { instance, calls };
}

/** A gate over the front door: the plan's own example. */
function doorGate(): JobGate {
    return {
        tool: "homeAssistant",
        args: { action: "get", entity_id: "binary_sensor.front_door" },
        when: "changed",
    };
}

/** A gate's identity, computed the way the runner computes it. */
function keyOf(gate: JobGate): string {
    const parsed = parseJobGate(gate);
    if (!parsed.ok) {
        throw new Error(`test fixture is not a valid gate: ${parsed.reason}`);
    }
    return gateKey(parsed.gate);
}

/**
 * Puts one finished firing into a job's history, and returns the job to due.
 *
 * A gate's comparison reads the *newest run*, so a test that wants a baseline
 * without firing the job first has to write one — through the same ledger calls
 * the runner makes, and then `rearmJob` (the recovery path), which is the one way
 * a claimed row goes back to `pending`.
 */
function seedPreviousRun(
    store: AppDatabase,
    jobId: string,
    run: {
        state: "skipped" | "ok";
        output?: string;
        gateOutput?: string;
        gateKey?: string;
    },
    at: Date,
): void {
    const runId = `seed-${jobId}`;
    store.claimJob(jobId);
    store.startJobRun({ id: runId, jobId, startedAt: at.toISOString() });
    store.finishJobRun(
        runId,
        run.state,
        {
            output: run.output,
            gateOutput: run.gateOutput,
            gateKey: run.gateKey,
        },
        at.toISOString(),
    );
    store.rearmJob(jobId, at.toISOString());
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
    modelRunsPerDay?: number;
    runsToKeep?: number;
}): {
    store: AppDatabase;
    userId: number;
    deviceId: number;
    scheduler: Scheduler;
    runner: JobRunner;
    socket: ReturnType<typeof fakeSocket>;
} {
    const store = createInMemoryAppDatabase();
    const userId = store.createUser("luke", "hash", "owner").id;
    const deviceId = store.createDevice(
        userId,
        "test-device",
        "device-hash",
        "test0001",
    ).id;
    const hub = createNotificationHub();
    const socket = fakeSocket();
    hub.add(userId, socket, deviceId);
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
        modelRunsPerDay: options.modelRunsPerDay ?? 200,
        ...(options.runsToKeep !== undefined
            ? { runsToKeep: options.runsToKeep }
            : {}),
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
    return { store, userId, deviceId, scheduler, runner, socket };
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

/**
 * A daily rule anchored at `at` — "the same clock time, every day".
 *
 * Anchored at the test's own instant so the wall clock is whatever the machine's
 * zone makes it: the assertion is "one local day later", not "09:00Z", which is
 * a different time in every zone. Seconds are ignored because a rule's clock is
 * a wall clock to the minute.
 */
function dailyFrom(at: Date): {
    every: "day";
    interval: number;
    start: string;
} {
    return { every: "day", interval: 1, start: at.toISOString() };
}

/** The local day the runner's model-run budget counts against. */
function localDayOf(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The instant one local day after `at`, at `at`'s clock: where that rule fires next. */
function nextLocalDay(at: Date): string {
    return new Date(
        at.getFullYear(),
        at.getMonth(),
        at.getDate() + 1,
        at.getHours(),
        at.getMinutes(),
    ).toISOString();
}

/** `"HH:MM"` for a local instant, which is how a window is written. */
function clockOf(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A parsed window from a fixture, failing loudly rather than typing it away. */
function windowOf(value: unknown): QuietHours {
    const window = parseQuietHours(value);
    if (window === null) {
        throw new Error("test fixture is not a valid quiet-hours window");
    }
    return window;
}

/**
 * A quiet-hours window covering `at`, in the server's local time (which is what
 * quiet hours are evaluated against). Two hours wide, so the instant sits
 * comfortably inside it.
 */
function quietAt(at: Date): { start: string; end: string } {
    const pad = (n: number) => String(n).padStart(2, "0");
    const clock = (offsetMinutes: number) => {
        const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
        return `${pad(shifted.getHours())}:${pad(shifted.getMinutes())}`;
    };
    return { start: clock(-60), end: clock(60) };
}

describe("scheduler: a prompt job", () => {
    it("passes the job's origin device into its turn (#194)", async () => {
        const { agent, calls } = fakeAgent("Done.");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "scoped-prompt",
            originDeviceId: h.deviceId,
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        expect(calls[0]?.deviceId).toBe(h.deviceId);
    });

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
        // The announcement names the job it came from (#90 phase 5): it is what
        // lets a reminder's banner offer snooze rather than only dismiss.
        expect(h.store.listNotifications(h.userId)[0]?.jobId).toBe("j1");
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

    it("does not repeat the headline when the text is only the headline", async () => {
        // The scheduling tools default a reminder's message to its label, so a
        // job created as just "Call Mum" has nothing to add to the banner.
        const h = harness({ at: AT });
        h.store.createJob(h.userId, {
            id: "j1",
            label: "Call Mum",
            kind: "message",
            message: "Call Mum",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        expect(pushed(h.socket)).toEqual([
            { kind: "job.finished", title: "Call Mum" },
        ]);
        // The full text is still recorded — the run row is the durable half.
        expect(h.store.listJobRuns("j1")[0].output).toBe("Call Mum");
    });

    it("addresses a timer announcement at the device that created it (#194)", async () => {
        const h = harness({ at: AT });
        h.store.createJob(h.userId, {
            id: "device-timer",
            label: "Kettle",
            class: "timer",
            kind: "message",
            message: "Take the kettle off.",
            originDeviceId: h.deviceId,
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        await h.scheduler.tick();

        const [notification] = h.store.listNotifications(h.userId);
        expect(notification.targetDeviceId).toBe(h.deviceId);
        expect(pushed(h.socket)).toHaveLength(1);
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
        // A timer whose row predates device scoping keeps the account-wide
        // behavior rather than being guessed onto a device (#194).
        expect(
            stored.find((n) => n.title === "Kettle")?.targetDeviceId,
        ).toBeNull();
    });
});

describe("scheduler: a job created by the scheduling tools", () => {
    it("runs with the class its tool chose", async () => {
        const at = new Date(AT);
        const h = harness({ at });
        const remindMe = createJobsTools({
            ledger: h.store,
            maxPerUser: 5,
            maxHorizonMs: 366 * 86_400_000,
            tools: [],
            now: () => at,
            newId: () => "job1",
        }).find((instance) => instance.name === "remindMe");
        if (remindMe === undefined) {
            throw new Error("remindMe is not registered");
        }

        const text = (await remindMe.invoke(
            { label: "Call Mum", inMinutes: 1 },
            { configurable: { userId: h.userId } },
        )) as string;
        expect(text).toContain("Reminder scheduled");

        // The queue the tool wrote to is the one the loop drains.
        at.setTime(at.getTime() + 60_000);
        await h.scheduler.tick();

        const stored = h.store.listNotifications(h.userId);
        expect(stored.map((n) => [n.title, n.class])).toEqual([
            ["Call Mum", "reminder"],
        ]);
        // A job with no detail beyond its headline arrives as one line.
        expect(pushed(h.socket)).toEqual([
            { kind: "job.finished", title: "Call Mum" },
        ]);
    });
});

describe("scheduler: what the log says", () => {
    it("says at info when an announcement was recorded but not pushed", async () => {
        const info = vi
            .spyOn(logger, "info")
            .mockImplementation(() => undefined);
        try {
            const h = harness({ at: AT });
            h.store.setPrefs(h.userId, [
                { key: "notify.quietHours", value: quietAt(AT) },
            ]);
            h.store.createJob(h.userId, {
                id: "j1",
                label: "Filter",
                kind: "message",
                message: "Change the filter.",
                runAt: "2026-10-20T09:00:00.000Z",
                createdAt: "2026-10-15T18:00:00.000Z",
            });

            await h.scheduler.tick();

            const lines = info.mock.calls
                .map((call) => String(call[0]))
                .join("\n");
            // The reason, in prose, at the level the server actually runs at:
            // without this, "it ran but nothing appeared" was a question only a
            // debug rerun — or the user — could answer.
            expect(lines).toMatch(/recorded only \(quiet-hours\)/);
            expect(lines).toMatch(/quiet hours hold a notification/);
        } finally {
            info.mockRestore();
        }
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

describe("scheduler: a reminder defers out of quiet hours", () => {
    it("moves itself to the window's end instead of firing", async () => {
        // A clock this test owns, so it can move to the window's end later
        // without touching the module-level AT every other test shares.
        const at = new Date(AT);
        const h = harness({ at });
        h.store.setPrefs(h.userId, [
            { key: "notify.quietHours", value: quietAt(at) },
        ]);
        h.store.createJob(h.userId, {
            id: "r1",
            label: "Filter",
            class: "reminder",
            kind: "message",
            message: "Change the filter.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const first = await h.scheduler.tick();

        expect(first.outcomes).toHaveLength(1);
        expect(first.outcomes[0].kind).toBe("deferred");
        const runAt = h.store.getJob(h.userId, "r1")?.runAt ?? "";
        // Nothing ran and nothing was said: no attempt, no run row, no
        // notification — the job is simply owed at a later moment.
        expect(h.store.getJob(h.userId, "r1")).toMatchObject({
            state: "pending",
            attempts: 0,
        });
        expect(runAt).not.toBe("2026-10-20T09:00:00.000Z");
        expect(h.store.listJobRuns("r1")).toEqual([]);
        expect(pushed(h.socket)).toEqual([]);

        // When that moment arrives the window is over, so the reminder is
        // delivered — the whole point of deferring rather than holding it.
        at.setTime(new Date(runAt).getTime() + 1_000);
        const second = await h.scheduler.tick();

        expect(second.outcomes).toEqual([
            { kind: "done", output: "Change the filter." },
        ]);
        expect(h.store.getJob(h.userId, "r1")?.state).toBe("done");
        expect(pushed(h.socket)).toEqual([
            {
                kind: "job.finished",
                title: "Filter",
                body: "Change the filter.",
            },
        ]);
    });

    /** A reminder job due at the shared fixture moment. */
    function reminder(h: ReturnType<typeof harness>, id = "r1") {
        h.store.createJob(h.userId, {
            id,
            label: "Filter",
            class: "reminder",
            kind: "message",
            message: "Change the filter.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
    }

    it("uses the window as it is when the job is evaluated, not as it was when created", async () => {
        const at = new Date(AT);
        const h = harness({ at });
        h.store.setPrefs(h.userId, [
            { key: "notify.quietHours", value: quietAt(at) },
        ]);
        reminder(h);
        // The user moves the window to end later, before the job is evaluated.
        const moved = quietAt(new Date(at.getTime() + 30 * 60_000));
        h.store.setPrefs(h.userId, [
            { key: "notify.quietHours", value: moved },
        ]);

        await h.scheduler.tick();

        // The new window decides, and the deferred moment is the *new* end.
        const runAt = h.store.getJob(h.userId, "r1")?.runAt ?? "";
        expect(runAt).toBe(quietHoursEnd(windowOf(moved), at).toISOString());
        expect(runAt).not.toBe(
            quietHoursEnd(windowOf(quietAt(at)), at).toISOString(),
        );
    });

    it("defers again when the window is extended past the deferred moment", async () => {
        const at = new Date(AT);
        const h = harness({ at });
        h.store.setPrefs(h.userId, [
            { key: "notify.quietHours", value: quietAt(at) },
        ]);
        reminder(h);
        await h.scheduler.tick();
        const first = h.store.getJob(h.userId, "r1")?.runAt ?? "";

        // The window is extended so it now covers the moment the job moved to.
        const window = {
            start: clockOf(new Date(at.getTime() - 60 * 60_000)),
            end: clockOf(new Date(new Date(first).getTime() + 30 * 60_000)),
        };
        h.store.setPrefs(h.userId, [
            { key: "notify.quietHours", value: window },
        ]);

        at.setTime(new Date(first).getTime());
        const second = await h.scheduler.tick();

        expect(second.outcomes).toEqual([
            {
                kind: "deferred",
                until: quietHoursEnd(windowOf(window), at).toISOString(),
            },
        ]);
        // Later than it was, still owed, still unsaid.
        expect(
            new Date(h.store.getJob(h.userId, "r1")?.runAt ?? 0).getTime(),
        ).toBeGreaterThan(new Date(first).getTime());
        expect(pushed(h.socket)).toEqual([]);
    });

    it("does not come back early when quiet hours are removed", async () => {
        const at = new Date(AT);
        const h = harness({ at });
        h.store.setPrefs(h.userId, [
            { key: "notify.quietHours", value: quietAt(at) },
        ]);
        reminder(h);
        await h.scheduler.tick();
        const deferredTo = h.store.getJob(h.userId, "r1")?.runAt ?? "";

        // Quiet hours off: the deferral already happened, and the original
        // moment is not retained, so there is nothing to bring forward.
        h.store.setPrefs(h.userId, [{ key: "notify.quietHours", value: null }]);
        await h.scheduler.tick();
        expect(h.store.getJob(h.userId, "r1")).toMatchObject({
            state: "pending",
            runAt: deferredTo,
        });
        expect(pushed(h.socket)).toEqual([]);

        // It runs where it was moved to.
        at.setTime(new Date(deferredTo).getTime() + 1_000);
        const summary = await h.scheduler.tick();
        expect(summary.outcomes).toEqual([
            { kind: "done", output: "Change the filter." },
        ]);
    });

    it("runs at its own moment when notifications are switched off", async () => {
        const at = new Date(AT);
        const h = harness({ at });
        h.store.setPrefs(h.userId, [
            { key: "notify.enabled", value: false },
            { key: "notify.quietHours", value: quietAt(at) },
        ]);
        reminder(h);

        const summary = await h.scheduler.tick();

        // Nothing to defer *for*: the announcement would be recorded either way,
        // so the record is produced at the moment asked for, not hours late.
        expect(summary.outcomes).toEqual([
            { kind: "done", output: "Change the filter." },
        ]);
        const stored = h.store.listNotifications(h.userId);
        expect(stored).toHaveLength(1);
        expect(stored[0].state).toBe("pending");
    });

    it("runs immediately when quiet hours are not in force", async () => {
        const at = new Date(AT);
        const h = harness({ at });
        // The same reminder with no window configured: the class alone delays
        // nothing, so this is the control for the test above.
        h.store.createJob(h.userId, {
            id: "r1",
            label: "Filter",
            class: "reminder",
            kind: "message",
            message: "Change the filter.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "done", output: "Change the filter." },
        ]);
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
            modelRunsPerDay: 200,
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

describe("scheduler: a repeating job (#90 phase 8c)", () => {
    it("re-arms on success, at its own clock", async () => {
        const { agent } = fakeAgent("Morning summary");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "done", output: "Morning summary" },
        ]);
        // Owed again, not settled: the firing ended, the series did not.
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            runAt: nextLocalDay(AT),
            settledAt: null,
            attempts: 1,
        });
        expect(h.store.listJobRuns("j1")).toMatchObject([
            { state: "ok", output: "Morning summary" },
        ]);
        // One announcement per firing, and this firing was one.
        expect(pushed(h.socket)).toHaveLength(1);
    });

    it("keeps one live announcement, however many times it fires", async () => {
        // #90 phase 9a: a series' firing replaces the announcement before it,
        // so a minutely reminder is one row that keeps saying the newest thing
        // rather than a thousand rows of the same sentence. That is what lets a
        // message series repeat at any cadence.
        const { agent } = fakeAgent("Drink water");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
        });

        await h.scheduler.tick();
        h.store.rescheduleJob("j1", AT.toISOString());
        await h.scheduler.tick();

        // One live row (the store's list already hides the superseded one), and
        // it is the newest firing's.
        expect(h.store.listNotifications(h.userId)).toMatchObject([
            { jobId: "j1", kind: "job.finished", body: "Drink water" },
        ]);
        // Superseding is about the announcement, never the ledger: both firings
        // are still in the run history.
        expect(h.store.listJobRuns("j1")).toHaveLength(2);
    });

    it("re-arms on failure too, because the next occurrence is the retry", async () => {
        const { agent } = fakeAgent("unused");
        const h = harness({ at: AT, actor: agent, tools: [] });
        h.store.createJob(h.userId, {
            ...toolJob("explode"),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
        });

        expect((await h.scheduler.tick()).outcomes).toMatchObject([
            { kind: "failed" },
        ]);
        // Failed, and owed again: a series' next occurrence *is* its retry.
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            runAt: nextLocalDay(AT),
        });
        expect(h.store.getJob(h.userId, "j1")?.lastError).toMatch(/explode/);
        expect(pushed(h.socket)[0]).toMatchObject({ kind: "job.failed" });
    });

    it("a plain message series records no per-firing history", async () => {
        // #90 phase 9b: a run row for this firing would hold the job's own text,
        // identical every time — a minutely reminder would write 1,440 of them a
        // day. The job row is the record (`attempts` counts the firings), and the
        // announcement is the whole of what the user sees.
        const h = harness({ at: AT });
        h.store.createJob(h.userId, {
            id: "j1",
            label: "Drink water",
            kind: "message",
            message: "Drink water.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
        });

        await h.scheduler.tick();
        h.store.rescheduleJob("j1", AT.toISOString());
        await h.scheduler.tick();

        expect(h.store.listJobRuns("j1")).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            attempts: 2,
        });
        // What it *does* leave behind is the announcement — one live row, since
        // a series supersedes itself (#90 phase 9a). The socket saw two frames,
        // which is the reminder arriving twice; the list holds one row.
        expect(h.store.listNotifications(h.userId)).toHaveLength(1);
        expect(pushed(h.socket)).toHaveLength(2);
    });

    it("keeps rows where a firing carries something", async () => {
        // The exception is precisely "plain". A one-shot's single row is its
        // record; a gated firing's row is the next firing's baseline, and when it
        // declines it is the only trace that the check happened at all.
        const once = harness({ at: AT });
        once.store.createJob(once.userId, {
            id: "once",
            label: "Call Mum",
            kind: "message",
            message: "Call Mum.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        await once.scheduler.tick();
        expect(once.store.listJobRuns("once")).toHaveLength(1);

        const door = homeAssistantDouble(() => "front door: closed");
        const h = harness({ at: AT, tools: [door.instance] });
        h.store.createJob(h.userId, {
            id: "gated",
            label: "Front door",
            kind: "message",
            message: "It opened.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
            gate: doorGate(),
        });

        await h.scheduler.tick();
        h.store.rescheduleJob("gated", AT.toISOString());
        await h.scheduler.tick();

        // Ran once, then declined — both recorded, newest first.
        expect(h.store.listJobRuns("gated")).toMatchObject([
            { state: "skipped", gateOutput: "front door: closed" },
            { state: "ok" },
        ]);
    });

    it("ends after the number of firings it was given", async () => {
        const { agent } = fakeAgent("Last one");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: { ...dailyFrom(AT), ends: { after: 1 } },
        });

        expect((await h.scheduler.tick()).outcomes).toEqual([
            { kind: "done", output: "Last one" },
        ]);
        // The one firing it was asked for has happened, so the row is history.
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "done",
            settledAt: AT.toISOString(),
        });
    });

    it("ends at the moment it was given", async () => {
        const { agent } = fakeAgent("Too late");
        const h = harness({ at: AT, actor: agent });
        const until = new Date(AT.getTime() + 60 * 60 * 1000);
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            // Tomorrow's firing would be past the end, so there is no next one.
            repeat: {
                ...dailyFrom(AT),
                ends: { until: until.toISOString() },
            },
        });

        expect((await h.scheduler.tick()).outcomes).toEqual([
            { kind: "done", output: "Too late" },
        ]);
        expect(h.store.getJob(h.userId, "j1")?.state).toBe("done");
    });

    it("moves a missed slot forward in silence instead of ending the series", async () => {
        const { agent, calls } = fakeAgent("should not run");
        const h = harness({
            at: AT,
            actor: agent,
            maxLatenessMs: 60 * 60 * 1000,
        });
        // The rule is anchored at the job's own moment, so its next occurrence
        // is one local day on at *that* clock — not at the tick's.
        const due = new Date("2026-10-20T06:00:00.000Z");
        h.store.createJob(h.userId, {
            ...promptJob({ runAt: due.toISOString() }),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(due),
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "deferred", until: nextLocalDay(due) },
        ]);
        // Nothing was attempted and nothing was promised for the new moment, so
        // there is no run row and nothing to say.
        expect(calls).toEqual([]);
        expect(h.store.listJobRuns("j1")).toEqual([]);
        expect(pushed(h.socket)).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            runAt: nextLocalDay(due),
        });
    });

    it("does not count a skipped slot against the firing budget", async () => {
        const { agent } = fakeAgent("Morning summary");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            ...promptJob({ runAt: "2026-10-20T06:00:00.000Z" }),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: {
                ...dailyFrom(new Date("2026-10-20T06:00:00.000Z")),
                ends: { after: 1 },
            },
        });

        // A slot nobody saw is not a firing, so the one it was asked for is
        // still owed.
        await h.scheduler.tick();
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            attempts: 0,
        });
    });

    it("spends the day's model budget only on a run that reached the model", async () => {
        const { agent } = fakeAgent("Summary");
        const h = harness({ at: AT, actor: agent });
        h.store.createJob(h.userId, {
            id: "j1",
            label: "Kettle",
            kind: "message",
            message: "Kettle",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        // The budget is spent to the last run.
        for (let i = 0; i < 200; i++) {
            h.store.recordModelRun(h.userId, localDayOf(AT));
        }

        // A message job calls no model, so it is untouched by the budget...
        expect((await h.scheduler.tick()).outcomes).toEqual([
            { kind: "done", output: "Kettle" },
        ]);
        expect(h.store.countModelRuns(h.userId, localDayOf(AT))).toBe(200);
    });

    it("marks a one-shot missed when the day's budget is spent", async () => {
        const { agent, calls } = fakeAgent("should not run");
        const h = harness({ at: AT, actor: agent, modelRunsPerDay: 1 });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        h.store.recordModelRun(h.userId, localDayOf(AT));

        expect((await h.scheduler.tick()).outcomes).toEqual([
            { kind: "missed" },
        ]);
        expect(calls).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "missed",
        });
        expect(pushed(h.socket)[0]).toMatchObject({ kind: "job.missed" });
        expect(pushed(h.socket)[0].body).toMatch(
            /budget of 1 model-calling runs/,
        );
    });

    it("moves a series past a spent budget, and says so", async () => {
        const { agent, calls } = fakeAgent("should not run");
        const h = harness({ at: AT, actor: agent, modelRunsPerDay: 1 });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
        });
        h.store.recordModelRun(h.userId, localDayOf(AT));

        expect((await h.scheduler.tick()).outcomes).toEqual([
            { kind: "deferred", until: nextLocalDay(AT) },
        ]);
        expect(calls).toEqual([]);
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            runAt: nextLocalDay(AT),
        });
        // The occurrence is lost, not the series — and the user is told once a
        // day rather than once a firing.
        expect(pushed(h.socket)).toHaveLength(1);
        expect(pushed(h.socket)[0].kind).toBe("job.missed");
    });

    it("continues a series whose firing a restart interrupted", async () => {
        const h = harness({ at: AT });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
        });
        h.store.claimJob("j1");
        h.store.startJobRun({
            id: "run-old",
            jobId: "j1",
            startedAt: "2026-10-20T08:00:00.000Z",
        });

        expect(await h.scheduler.recover()).toBe(1);

        // The attempt failed — the process making it died — but the schedule did
        // not, so the job is owed again rather than over.
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            runAt: nextLocalDay(AT),
        });
        expect(h.store.listJobRuns("j1")[0]).toMatchObject({
            state: "failed",
            error: "the server restarted while this run was in progress",
        });
        // Nothing to say: the next firing will speak.
        expect(pushed(h.socket)).toEqual([]);
    });

    it("trims a series' runs", async () => {
        const { agent } = fakeAgent("Morning summary");
        const h = harness({ at: AT, actor: agent, runsToKeep: 2 });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
        });
        for (const hour of ["06", "07", "08"]) {
            h.store.startJobRun({
                id: `old-${hour}`,
                jobId: "j1",
                startedAt: `2026-10-20T${hour}:00:00.000Z`,
            });
        }

        await h.scheduler.tick();

        expect(h.store.listJobRuns("j1")).toHaveLength(2);
    });
});

describe("scheduler: a gated job (#90 phase 8f)", () => {
    it("reads the check before running, and records what it read", async () => {
        const { agent, calls } = fakeAgent("It is closed.");
        const door = homeAssistantDouble(() => "front door: closed");
        const h = harness({ at: AT, actor: agent, tools: [door.instance] });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
            gate: doorGate(),
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "done", output: "It is closed." },
        ]);
        // The check ran exactly once, with the arguments the gate named.
        expect(door.calls).toEqual([
            { action: "get", entity_id: "binary_sensor.front_door" },
        ]);
        // The payload ran, so this firing announces like any other...
        expect(pushed(h.socket)).toHaveLength(1);
        expect(calls).toHaveLength(1);
        // ...and the run records the answer, because the *next* firing compares
        // against it: a payload run that recorded nothing would reset the
        // baseline, and every other firing would run.
        expect(h.store.listJobRuns("j1")).toMatchObject([
            {
                state: "ok",
                output: "It is closed.",
                gateOutput: "front door: closed",
                gateKey: keyOf(doorGate()),
            },
        ]);
    });

    it("declines, silently, while the check's answer is the same", async () => {
        const { agent, calls } = fakeAgent("It is closed.");
        let answer = "front door: closed";
        const door = homeAssistantDouble(() => answer);
        const h = harness({ at: AT, actor: agent, tools: [door.instance] });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
            gate: doorGate(),
        });

        await h.scheduler.tick();
        // The series is owed again at its next occurrence; bring that occurrence
        // back to the clock, which is the only way to watch a second firing.
        h.store.rescheduleJob("j1", AT.toISOString());

        const second = await h.scheduler.tick();

        expect(second.outcomes).toEqual([
            { kind: "declined", reason: "the check found nothing changed" },
        ]);
        // Nothing ran and nothing was said: the user asked to hear about this job
        // when something changed, and nothing had.
        expect(calls).toHaveLength(1);
        expect(pushed(h.socket)).toHaveLength(1);
        // The declined firing is a *run row* — which is what keeps a job that
        // declines hundreds of times a day legible in its own history.
        expect(h.store.listJobRuns("j1")).toMatchObject([
            {
                state: "skipped",
                output: null,
                gateOutput: "front door: closed",
                gateKey: keyOf(doorGate()),
            },
            { state: "ok" },
        ]);
        // Claimed, so it counts toward `ends.after` — and the series is owed again.
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            runAt: nextLocalDay(AT),
            attempts: 2,
        });
        // A decline spends no model run: the budget counts payloads, not checks.
        expect(h.store.countModelRuns(h.userId, localDayOf(AT))).toBe(1);

        // The house changes, so the next firing runs — and announces what it did.
        answer = "front door: open";
        h.store.rescheduleJob("j1", AT.toISOString());
        const third = await h.scheduler.tick();

        expect(third.outcomes).toEqual([
            { kind: "done", output: "It is closed." },
        ]);
        expect(pushed(h.socket)).toHaveLength(2);
        expect(door.calls).toHaveLength(3);
    });

    it("fails the firing when the check cannot be evaluated", async () => {
        const { agent, calls } = fakeAgent("unused");
        const door = homeAssistantDouble(() => "front door: closed");
        const h = harness({ at: AT, actor: agent, tools: [door.instance] });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            gate: {
                tool: "homeAssistant",
                // A write: a gate that turned the light on to see whether it
                // changed is neither deterministic nor free.
                args: { action: "turn_on", entity_id: "light.kitchen" },
                when: "changed",
            },
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toMatchObject([{ kind: "failed" }]);
        // The payload did not run: "only if it changed" is not a request to run
        // regardless, so an unanswerable check stops the firing rather than
        // waving it through.
        expect(calls).toHaveLength(0);
        expect(door.calls).toHaveLength(0);
        expect(h.store.listJobRuns("j1")).toMatchObject([
            { state: "failed", error: expect.stringMatching(/may only read/) },
        ]);
        expect(h.store.getJob(h.userId, "j1")?.lastError).toMatch(
            /may only read/,
        );
        // A one-shot ends failed, and the failure is what tells the user.
        expect(h.store.getJob(h.userId, "j1")?.state).toBe("failed");
        expect(pushed(h.socket)[0]).toMatchObject({ kind: "job.failed" });
    });

    it("fails the firing when the check's tool is gone from this server", async () => {
        const { agent } = fakeAgent("unused");
        // No tools wired at all: the credentials were removed between the
        // conversation that created the job and the moment it came due.
        const h = harness({ at: AT, actor: agent, tools: [] });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            repeat: dailyFrom(AT),
            gate: doorGate(),
        });

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toMatchObject([{ kind: "failed" }]);
        expect(h.store.listJobRuns("j1")).toMatchObject([
            {
                state: "failed",
                error: "the 'homeAssistant' tool is not available on this server",
            },
        ]);
        // A series is not over because one firing could not be checked: the next
        // occurrence is where it tries again.
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "pending",
            runAt: nextLocalDay(AT),
        });
        expect(pushed(h.socket)[0]).toMatchObject({ kind: "job.failed" });
    });

    it("runs the job anyway when the stored gate is unreadable", async () => {
        const { agent, calls } = fakeAgent("Ran unguarded.");
        const door = homeAssistantDouble(() => "front door: closed");
        const warn = vi
            .spyOn(logger, "warn")
            .mockImplementation(() => undefined);
        try {
            const h = harness({ at: AT, actor: agent, tools: [door.instance] });
            h.store.createJob(h.userId, {
                ...promptJob(),
                id: "j1",
                createdAt: "2026-10-15T18:00:00.000Z",
                // A condition the protocol never defined: the row still holds the
                // text, and refusing every firing forever would be the worse
                // answer to a value nobody can mean.
                gate: { tool: "homeAssistant", args: {}, when: "sometimes" },
            });

            const summary = await h.scheduler.tick();

            expect(summary.outcomes).toEqual([
                { kind: "done", output: "Ran unguarded." },
            ]);
            expect(calls).toHaveLength(1);
            expect(door.calls).toHaveLength(0);
            expect(h.store.listJobRuns("j1")[0]?.gateOutput).toBeNull();
            expect(
                warn.mock.calls.map((call) => String(call[0])).join("\n"),
            ).toMatch(/unreadable gate/);
        } finally {
            warn.mockRestore();
        }
    });

    it("treats a changed gate as a new question, not a changed answer", async () => {
        const { agent } = fakeAgent("Ran because the question changed.");
        const door = homeAssistantDouble(() => "front door: closed");
        const h = harness({ at: AT, actor: agent, tools: [door.instance] });
        h.store.createJob(h.userId, {
            ...promptJob(),
            id: "j1",
            createdAt: "2026-10-15T18:00:00.000Z",
            gate: doorGate(),
        });
        // A baseline that answered *exactly* what this firing will read, but
        // asked a different question (a different action). Comparing the answer
        // alone would decline a firing whose check is not the one that answered.
        seedPreviousRun(
            h.store,
            "j1",
            {
                state: "skipped",
                gateOutput: "front door: closed",
                gateKey: keyOf({
                    tool: "homeAssistant",
                    args: { action: "list" },
                    when: "changed",
                }),
            },
            AT,
        );

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "done", output: "Ran because the question changed." },
        ]);
        expect(h.store.getJob(h.userId, "j1")?.state).toBe("done");
    });

    it("ends a one-shot that declines, without saying anything", async () => {
        const { agent, calls } = fakeAgent("unused");
        const door = homeAssistantDouble(() => "front door: closed");
        const h = harness({ at: AT, actor: agent, tools: [door.instance] });
        h.store.createJob(h.userId, {
            id: "j1",
            label: "Tell me if the door opened",
            kind: "message",
            message: "The front door opened.",
            runAt: AT.toISOString(),
            createdAt: "2026-10-15T18:00:00.000Z",
            gate: doorGate(),
        });
        seedPreviousRun(
            h.store,
            "j1",
            {
                state: "skipped",
                gateOutput: "front door: closed",
                gateKey: keyOf(doorGate()),
            },
            AT,
        );

        const summary = await h.scheduler.tick();

        expect(summary.outcomes).toEqual([
            { kind: "declined", reason: "the check found nothing changed" },
        ]);
        // Its one firing happened, so the job is over rather than missed — and
        // the run row is where the reason it produced nothing lives.
        expect(h.store.getJob(h.userId, "j1")).toMatchObject({
            state: "done",
            settledAt: AT.toISOString(),
        });
        expect(h.store.listJobRuns("j1")).toMatchObject([
            { state: "skipped", gateOutput: "front door: closed" },
            { state: "skipped" },
        ]);
        // Nothing was announced either: a message job's announcement *is* its
        // payload, and there was nothing to deliver.
        expect(pushed(h.socket)).toHaveLength(0);
        expect(calls).toHaveLength(0);
    });
});
