/**
 * Boot-reaper tests (#141).
 *
 * The point of this module is the *disagreement* between a row and a container,
 * so every test here constructs one deliberately: a running row with no
 * container, a container no row names, a container whose row already settled,
 * a `resume` job whose container has stopped. A suite that only covered the
 * happy resume path would leave the cases that actually lose work untested.
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppCodingJob, AppDatabase } from "@lukestanbery/jarvis-auth";
import { createFakeSandbox } from "../src/sandbox/fake";
import {
    reconcileCodingJobs,
    RECOVERY_REASONS,
    type CodingJobRecoveryHandlers,
} from "../src/sandbox/recovery";

/** When claims and settles happen in these fixtures. */
const START = "2026-10-19T12:00:00.000Z";
const END = "2026-10-19T12:30:00.000Z";

/** A store with one owner. */
function makeStore(): { store: AppDatabase; userId: number } {
    const store = createInMemoryAppDatabase();
    const user = store.createUser("luke", "hash", "owner");
    return { store, userId: user.id };
}

/**
 * Creates one coding job, optionally claims it.
 *
 * @param store - The store.
 * @param userId - Its owner.
 * @param id - The job id.
 * @param options - `claimed` puts it in `running`; `policy` picks the crash policy.
 * @returns The stored row.
 */
function makeJob(
    store: AppDatabase,
    userId: number,
    id: string,
    options: { claimed?: boolean; policy?: "prune" | "resume" } = {},
): AppCodingJob {
    store.createCodingJob(userId, {
        id,
        repo: "luke/app",
        branch: `jarvis/${id}`,
        prompt: "do the thing",
        workspacePath: `/jobs/${id}/repo`,
        ...(options.policy ? { crashPolicy: options.policy } : {}),
        createdAt: START,
    });
    const claimed =
        options.claimed === false
            ? store.getCodingJobById(id)
            : store.claimCodingJob(id, `container-${id}`, START);
    if (claimed === null) {
        throw new Error("fixture claim vanished");
    }
    return claimed;
}

/** Two spies with the recovery handler's shape. */
function spies(): CodingJobRecoveryHandlers & {
    resume: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
} {
    return {
        resume: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
    };
}

describe("coding-job recovery", () => {
    it("removes a container no row can describe", async () => {
        const { store, userId } = makeStore();
        void userId;
        const runner = createFakeSandbox({
            containers: [{ containerId: "c-ghost", jobId: "deleted-job" }],
        });
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary).toEqual({
            adopted: 0,
            pruned: 0,
            failed: 0,
            removed: 1,
            errors: 0,
        });
        expect(runner.removed).toEqual(["c-ghost"]);
        expect(handlers.resume).not.toHaveBeenCalled();
        expect(handlers.fail).not.toHaveBeenCalled();
    });

    it("removes a container whose job already settled", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "done");
        store.settleCodingJob("done", "ok", {}, END);
        const runner = createFakeSandbox({
            containers: [{ containerId: "c-done", jobId: "done" }],
        });
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary.removed).toBe(1);
        expect(runner.removed).toEqual(["c-done"]);
        // A settled row's history is not reopened just because a container
        // matched its id.
        expect(store.getCodingJobById("done")?.state).toBe("ok");
        expect(handlers.fail).not.toHaveBeenCalled();
    });

    it("removes an awaiting job's container but keeps its workspace", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "parked");
        store.awaitCodingJob("parked", { plan: "Plan." });
        const runner = createFakeSandbox({
            containers: [{ containerId: "c-parked", jobId: "parked" }],
        });
        const handlers = { ...spies(), discard: vi.fn(async () => {}) };

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary.removed).toBe(1);
        expect(runner.removed).toEqual(["c-parked"]);
        // The parked row's tree is the next attempt's workspace: only the
        // leftover container is discarded, never the workspace.
        expect(handlers.discard).not.toHaveBeenCalled();
        expect(store.getCodingJobById("parked")?.state).toBe("awaiting-answer");
    });

    it("adopts a running container under a resume job", async () => {
        const { store, userId } = makeStore();
        const job = makeJob(store, userId, "resume-me", { policy: "resume" });
        const runner = createFakeSandbox({
            containers: [{ containerId: "c-live", jobId: "resume-me" }],
        });
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary.adopted).toBe(1);
        expect(summary.pruned).toBe(0);
        expect(handlers.resume).toHaveBeenCalledTimes(1);
        const [calledJob, handle] = handlers.resume.mock.calls[0] as [
            AppCodingJob,
            { containerId: string },
        ];
        expect(calledJob.id).toBe(job.id);
        expect(handle.containerId).toBe("c-live");
        expect(handlers.fail).not.toHaveBeenCalled();
        expect(runner.removed).toEqual([]);
    });

    it("prunes a running container under a prune job, with a handle for its logs", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "prune-me");
        const runner = createFakeSandbox({
            containers: [
                {
                    containerId: "c-prune",
                    jobId: "prune-me",
                    logs: ["working…"],
                },
            ],
        });
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary.pruned).toBe(1);
        expect(summary.adopted).toBe(0);
        expect(handlers.resume).not.toHaveBeenCalled();
        const [job, handle, reason] = handlers.fail.mock.calls[0] as [
            AppCodingJob,
            { containerId: string } | null,
            string,
        ];
        expect(job.id).toBe("prune-me");
        expect(handle?.containerId).toBe("c-prune");
        expect(reason).toBe(RECOVERY_REASONS.restarted);
    });

    it("fails a job whose container stopped while the server was down", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "resume-dead", { policy: "resume" });
        const runner = createFakeSandbox({
            containers: [
                {
                    containerId: "c-dead",
                    jobId: "resume-dead",
                    running: false,
                    exitCode: 137,
                },
            ],
        });
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        // A stopped process cannot be resumed: `resume` means "carry on", and
        // the reason says what was actually found.
        expect(summary.adopted).toBe(0);
        expect(summary.failed).toBe(1);
        const [job, handle, reason] = handlers.fail.mock.calls[0] as [
            AppCodingJob,
            { wait: () => Promise<{ exitCode: number | null }> } | null,
            string,
        ];
        expect(job.id).toBe("resume-dead");
        expect(reason).toBe(RECOVERY_REASONS.stopped);
        expect((await handle?.wait())?.exitCode).toBe(137);
    });

    it("fails a running row whose container is gone", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "lost", { policy: "resume" });
        const runner = createFakeSandbox();
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary.failed).toBe(1);
        const [job, handle, reason] = handlers.fail.mock.calls[0] as [
            AppCodingJob,
            unknown,
            string,
        ];
        expect(job.id).toBe("lost");
        expect(handle).toBeNull();
        expect(reason).toBe(RECOVERY_REASONS.gone);
    });

    it("treats a container that vanishes between listing and adopt as gone", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "race", { policy: "resume" });
        const fake = createFakeSandbox({
            containers: [{ containerId: "c-race", jobId: "race" }],
        });
        // A runner whose listing still names the container but whose adopt
        // finds nothing — the window a real daemon can produce.
        const runner = {
            ...fake,
            list: async () => [
                {
                    containerId: "c-race",
                    jobId: "race",
                    running: true,
                    startedAt: START,
                },
            ],
            adopt: async () => null,
        };
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary.adopted).toBe(0);
        expect(summary.failed).toBe(1);
        expect(handlers.fail.mock.calls[0]?.[2]).toBe(RECOVERY_REASONS.gone);
        expect(handlers.fail.mock.calls[0]?.[1]).toBeNull();
    });

    it("keeps going when one job's handler throws", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "first");
        makeJob(store, userId, "second");
        const runner = createFakeSandbox();
        const fail = vi
            .fn()
            .mockRejectedValueOnce(new Error("store unavailable"))
            .mockResolvedValueOnce(undefined);
        const handlers = { resume: vi.fn(async () => {}), fail };

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary.errors).toBe(1);
        expect(summary.failed).toBe(1);
        expect(fail).toHaveBeenCalledTimes(2);
    });

    it("leaves queued jobs alone", async () => {
        const { store, userId } = makeStore();
        makeJob(store, userId, "waiting", { claimed: false });
        const runner = createFakeSandbox();
        const handlers = spies();

        const summary = await reconcileCodingJobs({
            ledger: store,
            runner,
            handlers,
        });

        expect(summary).toEqual({
            adopted: 0,
            pruned: 0,
            failed: 0,
            removed: 0,
            errors: 0,
        });
        expect(handlers.fail).not.toHaveBeenCalled();
    });
});
