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
 *   `listJobs`, `cancelJob`) must never see another account's job, while
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
            kind: "prompt",
            prompt: "Remind me to change the AC filter.",
            toolName: null,
            toolArgs: null,
            runAt: "2026-10-20T09:00:00.000Z",
            state: "pending",
            attempts: 0,
            createdAt: "2026-10-15T18:00:00.000Z",
            settledAt: null,
            lastError: null,
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
});
