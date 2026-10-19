/**
 * Scheduler-ledger tests (#90 phase 1).
 *
 * Two things about this ledger are worth more than the row round-trip, and both
 * are about it being the *scheduler's* table rather than another per-user list:
 *
 * - **The claim is the transition.** `claimJob` puts `state = 'pending'` in the
 *   WHERE clause, so the second claimant — a later tick, or a process that
 *   restarted mid-run — touches no row. Everything the scheduler guarantees
 *   about not firing a job twice rests on that one statement, so it is tested
 *   directly (claim twice, one winner) rather than assumed.
 * - **Two surfaces, deliberately.** The user-scoped methods (`getJob`,
 *   `listJobs`, `cancelJob`, `moveJob`) must never see another account's job, while
 *   `listDueJobs`/`settleJob` are cross-user because the scheduler acts for
 *   every user at once. A test that only exercised one surface would leave the
 *   other free to leak.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryAppDatabase } from "../src/testing";
import type { AppDatabase } from "../src";

/** A store with one owner account, plus the account's id. */
function makeStore(): { store: AppDatabase; userId: number } {
    const store = createInMemoryAppDatabase();
    const user = store.createUser("luke", "hash", "owner");
    return { store, userId: user.id };
}

/** A minimal prompt job; every field the caller must decide is overridable. */
function promptJob(
    overrides: {
        id?: string;
        label?: string;
        prompt?: string;
        runAt?: string;
        createdAt?: string;
    } = {},
) {
    return {
        id: overrides.id ?? "j1",
        label: overrides.label ?? "Change the AC filter",
        kind: "prompt" as const,
        prompt: overrides.prompt ?? "Remind me to change the AC filter.",
        runAt: overrides.runAt ?? "2026-10-20T09:00:00.000Z",
        createdAt: overrides.createdAt ?? "2026-10-15T18:00:00.000Z",
    };
}

describe("jobs ledger", () => {
    it("stores a prompt job as pending and reads it back", () => {
        const { store, userId } = makeStore();
        const created = store.createJob(userId, promptJob());

        expect(created).toEqual({
            id: "j1",
            userId,
            label: "Change the AC filter",
            class: "notification",
            kind: "prompt",
            prompt: "Remind me to change the AC filter.",
            toolName: null,
            toolArgs: null,
            message: null,
            runAt: "2026-10-20T09:00:00.000Z",
            state: "pending",
            attempts: 0,
            createdAt: "2026-10-15T18:00:00.000Z",
            settledAt: null,
            lastError: null,
            repeat: null,
        });
        expect(store.getJob(userId, "j1")).toEqual(created);
    });

    it("round-trips a tool job's arguments as JSON", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, {
            id: "j1",
            label: "Kitchen light",
            kind: "tool",
            toolName: "homeAssistant",
            toolArgs: { action: "turn_on", entity_id: "light.kitchen" },
            runAt: "2026-10-20T20:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        const job = store.getJob(userId, "j1");
        expect(job?.toolName).toBe("homeAssistant");
        expect(job?.toolArgs).toEqual({
            action: "turn_on",
            entity_id: "light.kitchen",
        });
        expect(job?.prompt).toBeNull();
    });

    it("carries a delivery class, defaulting to the quiet one", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob({ id: "quiet" }));
        store.createJob(userId, {
            ...promptJob({ id: "loud" }),
            class: "timer",
        });

        expect(store.getJob(userId, "quiet")?.class).toBe("notification");
        expect(store.getJob(userId, "loud")?.class).toBe("timer");
    });

    it("stores a message job: text with nothing to run", () => {
        const { store, userId } = makeStore();
        const created = store.createJob(userId, {
            id: "j1",
            label: "Kettle",
            class: "timer",
            kind: "message",
            message: "Take the kettle off the heat.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });

        // No prompt and no tool: the job's own text is the whole payload, which
        // is what lets a reminder or a timer exist without a model call.
        expect(created).toMatchObject({
            class: "timer",
            kind: "message",
            message: "Take the kettle off the heat.",
            prompt: null,
            toolName: null,
            state: "pending",
        });
    });

    it("refuses a job that could never run", () => {
        const { store, userId } = makeStore();
        const base = {
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        };

        // A prompt job with no prompt, a tool job with no tool, and a job
        // claiming both halves at once: the table's CHECK is what stops a row
        // the runner would have to invent behaviour for.
        expect(() =>
            store.createJob(userId, {
                ...base,
                id: "a",
                label: "x",
                kind: "prompt",
            }),
        ).toThrow();
        expect(() =>
            store.createJob(userId, {
                ...base,
                id: "b",
                label: "x",
                kind: "tool",
            }),
        ).toThrow();
        expect(() =>
            store.createJob(userId, {
                ...base,
                id: "c",
                label: "x",
                kind: "prompt",
                prompt: "do it",
                toolName: "homeAssistant",
            }),
        ).toThrow();
        expect(() =>
            store.createJob(userId, {
                ...base,
                id: "d",
                label: "x",
                kind: "message",
            }),
        ).toThrow();
        expect(() =>
            store.createJob(userId, {
                ...base,
                id: "e",
                label: "x",
                kind: "message",
                message: "say this",
                prompt: "do it",
            }),
        ).toThrow();
    });

    it("hides settled jobs from the default list, newest-created first", () => {
        const { store, userId } = makeStore();
        for (let i = 0; i < 3; i += 1) {
            store.createJob(
                userId,
                promptJob({
                    id: `j${i}`,
                    createdAt: `2026-10-15T1${i}:00:00.000Z`,
                }),
            );
        }
        store.settleJob("j0", "done", {}, "2026-10-16T11:00:00.000Z");

        expect(store.listJobs(userId).map((job) => job.id)).toEqual([
            "j2",
            "j1",
        ]);
        expect(
            store
                .listJobs(userId, { includeSettled: true })
                .map((job) => job.id),
        ).toEqual(["j2", "j1", "j0"]);
        expect(
            store.listJobs(userId, { limit: 1 }).map((job) => job.id),
        ).toEqual(["j2"]);
    });

    it("scopes reads and writes to the owning user", () => {
        const { store, userId } = makeStore();
        const pepper = store.createUser("pepper", "hash", "user");
        store.createJob(userId, promptJob());

        expect(store.getJob(pepper.id, "j1")).toBeNull();
        expect(store.listJobs(pepper.id)).toEqual([]);
        expect(store.cancelJob(pepper.id, "j1")).toBeNull();
        // …and the owner's job is untouched by the attempt.
        expect(store.getJob(userId, "j1")?.state).toBe("pending");
    });

    it("feeds the scheduler only work that is due, across every account", () => {
        const { store, userId } = makeStore();
        const pepper = store.createUser("pepper", "hash", "user");
        store.createJob(
            userId,
            promptJob({ id: "later", runAt: "2026-10-15T20:00:00.000Z" }),
        );
        store.createJob(
            userId,
            promptJob({ id: "first", runAt: "2026-10-15T10:00:00.000Z" }),
        );
        store.createJob(
            pepper.id,
            promptJob({ id: "second", runAt: "2026-10-15T11:00:00.000Z" }),
        );

        const due = store.listDueJobs("2026-10-15T12:00:00.000Z", 10);
        // Oldest due first, and Pepper's job is in the same feed: the
        // scheduler is one process acting for everyone.
        expect(due.map((job) => job.id)).toEqual(["first", "second"]);
        expect(store.listDueJobs("2026-10-15T12:00:00.000Z", 1)).toHaveLength(
            1,
        );
    });

    it("lets exactly one claimant win a job", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob());

        expect(store.claimJob("j1")).toBe(true);
        expect(store.claimJob("j1")).toBe(false);
        const claimed = store.getJob(userId, "j1");
        expect(claimed?.state).toBe("running");
        // A claim is an attempt: the count is the record of how many times
        // this job was taken, which is what a restart-mid-run needs to see.
        expect(claimed?.attempts).toBe(1);
    });

    it("refuses to claim a job that is not pending", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob());
        store.settleJob("j1", "cancelled", {}, "2026-10-15T18:05:00.000Z");

        expect(store.claimJob("j1")).toBe(false);
        expect(store.getJob(userId, "j1")?.attempts).toBe(0);
    });

    it("moves a pending job's moment, and only a pending one's", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob({ id: "pending" }));
        store.createJob(userId, promptJob({ id: "running" }));
        store.claimJob("running");

        const moved = store.rescheduleJob(
            "pending",
            "2026-10-21T07:00:00.000Z",
        );
        expect(moved?.runAt).toBe("2026-10-21T07:00:00.000Z");
        expect(moved?.state).toBe("pending");
        // A deferral is not an attempt: nothing was tried.
        expect(moved?.attempts).toBe(0);

        // A claimed job is being worked on, so its moment is history.
        const refused = store.rescheduleJob(
            "running",
            "2026-10-21T07:00:00.000Z",
        );
        expect(refused?.runAt).toBe("2026-10-20T09:00:00.000Z");
        expect(
            store.rescheduleJob("missing", "2026-10-21T07:00:00.000Z"),
        ).toBeNull();
    });

    it("records a run's start and outcome", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob());
        store.claimJob("j1");
        store.startJobRun({
            id: "r1",
            jobId: "j1",
            startedAt: "2026-10-20T09:00:01.000Z",
        });

        expect(store.listJobRuns("j1")).toEqual([
            {
                id: "r1",
                jobId: "j1",
                startedAt: "2026-10-20T09:00:01.000Z",
                finishedAt: null,
                state: "running",
                output: null,
                error: null,
            },
        ]);

        store.finishJobRun(
            "r1",
            "ok",
            {
                output: "Changed the filter, and the new one is in the cupboard.",
            },
            "2026-10-20T09:00:04.000Z",
        );
        const finished = store.listJobRuns("j1")[0];
        expect(finished.state).toBe("ok");
        expect(finished.output).toMatch(/cupboard/);
        expect(finished.finishedAt).toBe("2026-10-20T09:00:04.000Z");
    });

    it("records a failed run's reason", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob());
        store.claimJob("j1");
        store.startJobRun({
            id: "r1",
            jobId: "j1",
            startedAt: "2026-10-20T09:00:01.000Z",
        });
        store.finishJobRun(
            "r1",
            "failed",
            { error: "the model is not reachable" },
            "2026-10-20T09:00:02.000Z",
        );

        expect(store.listJobRuns("j1")[0]).toMatchObject({
            state: "failed",
            output: null,
            error: "the model is not reachable",
        });
    });

    it("settles a claimed job once, and never rewrites a settled one", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob());
        store.claimJob("j1");

        const done = store.settleJob(
            "j1",
            "done",
            {},
            "2026-10-20T09:00:05.000Z",
        );
        expect(done?.state).toBe("done");
        expect(done?.settledAt).toBe("2026-10-20T09:00:05.000Z");

        // A late duplicate — the second half of a retried tick — must not turn
        // a completed job into a failed one.
        const again = store.settleJob(
            "j1",
            "failed",
            { error: "late" },
            "2026-10-20T09:10:00.000Z",
        );
        expect(again?.state).toBe("done");
        expect(again?.lastError).toBeNull();
        expect(
            store.settleJob("nope", "done", {}, "2026-10-20T09:00:00.000Z"),
        ).toBeNull();
    });

    it("cancels a pending job but leaves a running one alone", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob({ id: "pending" }));
        store.createJob(userId, promptJob({ id: "running" }));
        store.claimJob("running");

        const cancelled = store.cancelJob(userId, "pending");
        expect(cancelled?.state).toBe("cancelled");
        expect(cancelled?.settledAt).not.toBeNull();

        // Already claimed: the work is in flight and its result is on its way,
        // so the row comes back unchanged rather than half-cancelled.
        const refused = store.cancelJob(userId, "running");
        expect(refused?.state).toBe("running");
        expect(store.cancelJob(userId, "missing")).toBeNull();
    });

    it("moves the owner's pending job, and nothing else", () => {
        const { store, userId } = makeStore();
        const pepper = store.createUser("pepper", "hash", "user");
        store.createJob(userId, promptJob({ id: "owed" }));
        store.createJob(userId, promptJob({ id: "running" }));
        store.createJob(pepper.id, promptJob({ id: "theirs" }));
        const theirsBefore = store.getJob(pepper.id, "theirs")?.runAt;
        store.claimJob("running");

        const moved = store.moveJob(userId, "owed", "2026-10-16T09:00:00.000Z");
        expect(moved?.runAt).toBe("2026-10-16T09:00:00.000Z");
        // A move is not an attempt: the job keeps its state and count.
        expect(moved?.state).toBe("pending");
        expect(moved?.attempts).toBe(0);

        // A claimed job is being worked on; someone else's is not ours to move.
        expect(
            store.moveJob(userId, "running", "2026-10-16T09:00:00.000Z")?.runAt,
        ).not.toBe("2026-10-16T09:00:00.000Z");
        expect(
            store.moveJob(userId, "theirs", "2026-10-16T09:00:00.000Z"),
        ).toBeNull();
        expect(
            store.moveJob(userId, "missing", "2026-10-16T09:00:00.000Z"),
        ).toBeNull();
        expect(store.getJob(pepper.id, "theirs")?.runAt).toBe(theirsBefore);
    });

    it("edits the owner's pending job, and nothing else", () => {
        const { store, userId } = makeStore();
        const pepper = store.createUser("pepper", "hash", "user");
        store.createJob(userId, {
            id: "kettle",
            label: "Kettle",
            class: "timer",
            kind: "message",
            message: "Take the kettle off the heat.",
            runAt: "2026-10-20T09:00:00.000Z",
            createdAt: "2026-10-15T18:00:00.000Z",
        });
        store.createJob(userId, promptJob({ id: "running" }));
        store.createJob(pepper.id, promptJob({ id: "theirs" }));
        store.claimJob("running");

        const edited = store.editJob(userId, "kettle", {
            label: "Tea",
            message: "The tea is ready.",
            runAt: "2026-10-21T09:00:00.000Z",
        });
        expect(edited).toMatchObject({
            label: "Tea",
            message: "The tea is ready.",
            runAt: "2026-10-21T09:00:00.000Z",
            state: "pending",
        });
        // An edit is not an attempt, and a field the caller did not mention
        // keeps the value it had.
        expect(edited?.attempts).toBe(0);
        expect(
            store.editJob(userId, "kettle", { label: "Kettle again" }),
        ).toMatchObject({
            label: "Kettle again",
            message: "The tea is ready.",
            runAt: "2026-10-21T09:00:00.000Z",
        });

        // A claimed job is being worked on, someone else's is not ours to edit,
        // and an id that does not exist belongs to nobody.
        expect(
            store.editJob(userId, "running", { label: "too late" })?.label,
        ).toBe("Change the AC filter");
        expect(
            store.editJob(userId, "theirs", { label: "not mine" }),
        ).toBeNull();
        expect(store.editJob(userId, "missing", { label: "ghost" })).toBeNull();
        expect(store.getJob(pepper.id, "theirs")?.label).toBe(
            "Change the AC filter",
        );
        expect(store.getJob(userId, "kettle")?.label).toBe("Kettle again");
    });

    it("evicts settled jobs first, and only reaches pending ones if it must", () => {
        const { store, userId } = makeStore();
        for (let i = 0; i < 4; i += 1) {
            store.createJob(
                userId,
                promptJob({
                    id: `j${i}`,
                    createdAt: `2026-10-15T0${i}:00:00.000Z`,
                }),
            );
            store.settleJob(`j${i}`, "done", {}, "2026-10-15T08:00:00.000Z");
        }
        // Newest of all and still owed: the row a prune must keep if there is
        // any choice at all.
        store.createJob(
            userId,
            promptJob({ id: "keep", createdAt: "2026-10-15T09:00:00.000Z" }),
        );

        expect(store.pruneJobs(userId, 2)).toBe(3);
        expect(
            store
                .listJobs(userId, { includeSettled: true })
                .map((job) => job.id),
        ).toEqual(["keep", "j3"]);
    });

    it("still bounds the table when pending jobs are the ones piling up", () => {
        const { store, userId } = makeStore();
        for (let i = 0; i < 5; i += 1) {
            // The case retention exists for: a producer that keeps scheduling
            // faster than anything settles, so no settled row can absorb the
            // cut.
            store.createJob(
                userId,
                promptJob({
                    id: `p${i}`,
                    createdAt: `2026-10-15T0${i}:00:00.000Z`,
                }),
            );
        }
        expect(store.pruneJobs(userId, 2)).toBe(3);
        expect(store.listJobs(userId).map((job) => job.id)).toEqual([
            "p4",
            "p3",
        ]);
    });

    it("takes a pruned job's runs with it", () => {
        const { store, userId } = makeStore();
        store.createJob(userId, promptJob());
        store.claimJob("j1");
        store.startJobRun({
            id: "r1",
            jobId: "j1",
            startedAt: "2026-10-20T09:00:01.000Z",
        });
        store.settleJob("j1", "done", {}, "2026-10-20T09:00:05.000Z");

        expect(store.pruneJobs(userId, 0)).toBe(1);
        // The history of a job that no longer exists is not history: the rows
        // cascade rather than accumulating against a dangling id.
        expect(store.listJobRuns("j1")).toEqual([]);
    });

    it("reports the jobs a dead process left running, and closes their runs", () => {
        const { store, userId } = makeStore();
        const pepper = store.createUser("pepper", "hash", "user");
        store.createJob(userId, promptJob({ id: "j1" }));
        store.createJob(pepper.id, promptJob({ id: "j2" }));
        store.claimJob("j1");
        store.claimJob("j2");
        store.startJobRun({
            id: "r1",
            jobId: "j1",
            startedAt: "2026-10-20T09:00:01.000Z",
        });

        // Both users' in-flight jobs, because recovery is the process's job,
        // not one account's.
        expect(store.listRunningJobs(10).map((job) => job.id)).toEqual([
            "j1",
            "j2",
        ]);
        expect(store.listRunningJobs(1)).toHaveLength(1);

        expect(
            store.failOpenJobRuns(
                "j1",
                "interrupted by a restart",
                "2026-10-20T09:05:00.000Z",
            ),
        ).toBe(1);
        // Closing twice touches nothing: the run is no longer open.
        expect(
            store.failOpenJobRuns(
                "j1",
                "interrupted by a restart",
                "2026-10-20T09:06:00.000Z",
            ),
        ).toBe(0);
        expect(store.listJobRuns("j1")[0]).toMatchObject({
            state: "failed",
            error: "interrupted by a restart",
            finishedAt: "2026-10-20T09:05:00.000Z",
        });
    });
});

describe("recurrence and retention (#90 phase 8b)", () => {
    /** A weekly rule, Mondays at 09:00 — the shape the server validates into. */
    const weekly = {
        every: "week" as const,
        interval: 1,
        start: "2026-10-19T09:00:00.000Z",
        weekdays: ["mo" as const],
    };

    /** A job claimed and mid-run, which is where every settle path starts. */
    function claimed(
        store: AppDatabase,
        userId: number,
        overrides: { repeat?: unknown; id?: string } = {},
    ) {
        const created = store.createJob(userId, {
            ...promptJob({ id: overrides.id }),
            ...(overrides.repeat !== undefined
                ? { repeat: overrides.repeat }
                : {}),
        });
        expect(store.claimJob(created.id)).toBe(true);
        store.startJobRun({
            id: `run-${created.id}`,
            jobId: created.id,
            startedAt: "2026-10-19T09:00:00.000Z",
        });
        return created;
    }

    it("stores a rule and reads it back", () => {
        const { store, userId } = makeStore();
        const created = store.createJob(userId, {
            ...promptJob(),
            repeat: weekly,
        });
        expect(created.repeat).toEqual(weekly);
        expect(store.getJob(userId, created.id)?.repeat).toEqual(weekly);
        // A one-shot says so with `null` rather than a missing field.
        expect(
            store.createJob(userId, promptJob({ id: "j2" })).repeat,
        ).toBeNull();
    });

    it("keeps the rule through an edit and a move", () => {
        const { store, userId } = makeStore();
        const created = store.createJob(userId, {
            ...promptJob(),
            repeat: weekly,
        });
        store.editJob(userId, created.id, { label: "Standup (renamed)" });
        store.moveJob(userId, created.id, "2026-10-19T09:30:00.000Z");
        // The anchor is immutable, so neither an edit nor a snooze can shift the
        // series' own clock — which is what makes the next occurrence come back
        // to 09:00.
        expect(store.getJob(userId, created.id)?.repeat).toEqual(weekly);
    });

    it("re-arms a claimed job at a new moment, with no run row", () => {
        const { store, userId } = makeStore();
        const created = store.createJob(userId, {
            ...promptJob(),
            repeat: weekly,
        });
        // The missed-slot shape: a claim, but nothing attempted — so no run row.
        expect(store.claimJob(created.id)).toBe(true);
        const after = store.rearmJob(
            created.id,
            "2026-10-26T09:00:00.000Z",
            "missed its slot",
        );
        expect(after).toMatchObject({
            state: "pending",
            runAt: "2026-10-26T09:00:00.000Z",
            settledAt: null,
            lastError: "missed its slot",
        });
        expect(store.listJobRuns(created.id)).toEqual([]);
    });

    it("will not re-arm a job that is not running", () => {
        const { store, userId } = makeStore();
        const created = store.createJob(userId, promptJob());
        const after = store.rearmJob(created.id, "2026-10-26T09:00:00.000Z");
        expect(after).toMatchObject({
            state: "pending",
            runAt: created.runAt,
        });
    });

    it("counts model runs per account and per day", () => {
        const { store, userId } = makeStore();
        const day = "2026-10-20";
        expect(store.countModelRuns(userId, day)).toBe(0);
        store.recordModelRun(userId, day);
        store.recordModelRun(userId, day);
        expect(store.countModelRuns(userId, day)).toBe(2);
        // Tomorrow starts empty, and so does somebody else's day.
        expect(store.countModelRuns(userId, "2026-10-21")).toBe(0);
        expect(
            store.countModelRuns(
                store.createUser("sam", "hash", "user").id,
                day,
            ),
        ).toBe(0);
    });

    it("records a firing and re-arms the series in one write", () => {
        const { store, userId } = makeStore();
        const job = claimed(store, userId, { repeat: weekly });
        const settled = store.settleJobRun({
            jobId: job.id,
            runId: `run-${job.id}`,
            run: { state: "ok", output: "checked" },
            job: { state: "pending", runAt: "2026-10-26T09:00:00.000Z" },
            at: "2026-10-19T09:00:05.000Z",
        });
        expect(settled).toMatchObject({
            state: "pending",
            runAt: "2026-10-26T09:00:00.000Z",
            // Not history: the row is owed again.
            settledAt: null,
            attempts: 1,
        });
        expect(store.listJobRuns(job.id)).toMatchObject([
            { state: "ok", output: "checked" },
        ]);
    });

    it("settles a one-shot through the same call", () => {
        const { store, userId } = makeStore();
        const job = claimed(store, userId);
        const settled = store.settleJobRun({
            jobId: job.id,
            runId: `run-${job.id}`,
            run: { state: "ok", output: "done" },
            job: { state: "done" },
            at: "2026-10-19T09:00:05.000Z",
        });
        expect(settled).toMatchObject({
            state: "done",
            settledAt: "2026-10-19T09:00:05.000Z",
        });
    });

    it("cannot re-arm a series the user cancelled while it ran", () => {
        const { store, userId } = makeStore();
        const job = claimed(store, userId, { repeat: weekly });
        // A repeating job is cancellable mid-run: what the user stops is the
        // series, and the firing already in flight still reports.
        expect(store.cancelJob(userId, job.id)?.state).toBe("cancelled");
        const after = store.settleJobRun({
            jobId: job.id,
            runId: `run-${job.id}`,
            run: { state: "ok", output: "done" },
            job: { state: "pending", runAt: "2026-10-26T09:00:00.000Z" },
            at: "2026-10-19T09:00:05.000Z",
        });
        // The re-arm is a no-op on a row that is no longer `running`, so the
        // cancellation stands and the moment never moved.
        expect(after).toMatchObject({ state: "cancelled", runAt: job.runAt });
        expect(store.listJobRuns(job.id)[0]?.state).toBe("ok");
    });

    it("refuses to cancel a one-shot mid-run", () => {
        const { store, userId } = makeStore();
        const job = claimed(store, userId);
        // Its result is the whole job, and it is on its way.
        expect(store.cancelJob(userId, job.id)?.state).toBe("running");
    });

    it("trims a job's runs to the newest", () => {
        const { store, userId } = makeStore();
        const created = store.createJob(userId, promptJob());
        for (let hour = 1; hour <= 5; hour++) {
            store.startJobRun({
                id: `r${hour}`,
                jobId: created.id,
                startedAt: `2026-10-19T0${hour}:00:00.000Z`,
            });
        }
        expect(store.pruneJobRuns(created.id, 2)).toBe(3);
        expect(store.listJobRuns(created.id).map((run) => run.id)).toEqual([
            "r5",
            "r4",
        ]);
    });

    it("spares a live series from the job prune, and prunes a finished one", () => {
        const { store, userId } = makeStore();
        // Asked for first, so it is the *oldest* row — the one the old prune
        // took first, because a series' `created_at` never moves.
        store.createJob(userId, {
            ...promptJob({
                id: "series",
                createdAt: "2026-10-01T09:00:00.000Z",
            }),
            repeat: weekly,
        });
        for (const [id, day] of [
            ["a", "02"],
            ["b", "03"],
            ["c", "04"],
        ] as const) {
            store.createJob(
                userId,
                promptJob({ id, createdAt: `2026-10-${day}T09:00:00.000Z` }),
            );
        }
        // Four rows, keep two: the oldest one-shot goes, the live series stays.
        expect(store.pruneJobs(userId, 2)).toBe(1);
        expect(store.getJob(userId, "series")).not.toBeNull();
        expect(store.getJob(userId, "a")).toBeNull();

        // A series that has ended is history, and prunes like anything else.
        expect(store.cancelJob(userId, "series")?.state).toBe("cancelled");
        expect(store.pruneJobs(userId, 2)).toBe(1);
        expect(store.getJob(userId, "series")).toBeNull();
    });
});
