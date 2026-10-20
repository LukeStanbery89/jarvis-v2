/**
 * Coding-job ledger tests (#141).
 *
 * Three properties carry more weight than the row round-trip, and each is
 * tested directly rather than inferred:
 *
 * - **The claim is the transition**, exactly as for a scheduled job: `queued`
 *   in the WHERE clause means a second claimant touches no row. The container id
 *   is written at claim time — it is what `resume` needs after a crash, so a row
 *   that only learned its container on success would be unrecoverable exactly
 *   when recovery matters.
 * - **The terminal guard.** A late settle cannot rewrite a finished job's
 *   state or its recorded artifacts, and a settle of a row that was never
 *   claimed reports an attempt that never happened if it were allowed to land.
 * - **Two surfaces, deliberately.** `getCodingJob`/`listCodingJobs` are the
 *   caller's own rows; `getCodingJobById`/`listRunningCodingJobs` are the
 *   process's, because the boot reaper finds a container by label and has no
 *   owner to scope by.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryAppDatabase } from "../src/testing";
import type { AppDatabase } from "../src";

/** A store with one owner and one plain user, plus their ids. */
function makeStore(): {
    store: AppDatabase;
    ownerId: number;
    userId: number;
} {
    const store = createInMemoryAppDatabase();
    const owner = store.createUser("luke", "hash", "owner");
    const user = store.createUser("sam", "hash", "user");
    return { store, ownerId: owner.id, userId: user.id };
}

/** A minimal coding job; every field the caller must decide is overridable. */
function codingJob(
    overrides: Partial<{
        id: string;
        repo: string;
        branch: string;
        prompt: string;
        workspacePath: string;
        crashPolicy: "prune" | "resume";
        createdAt: string;
    }> = {},
) {
    return {
        id: overrides.id ?? "c1",
        repo: overrides.repo ?? "luke/app",
        branch: overrides.branch ?? "jarvis/fix-the-thing",
        prompt: overrides.prompt ?? "Fix the failing login test.",
        workspacePath:
            overrides.workspacePath ?? "/home/jarvis/.jarvis/jobs/c1/repo",
        ...(overrides.crashPolicy
            ? { crashPolicy: overrides.crashPolicy }
            : {}),
        createdAt: overrides.createdAt ?? "2026-10-19T12:00:00.000Z",
    };
}

describe("coding-job ledger", () => {
    it("stores a job as queued with the documented defaults", () => {
        const { store, ownerId } = makeStore();
        const created = store.createCodingJob(ownerId, codingJob());

        expect(created).toEqual({
            id: "c1",
            userId: ownerId,
            repo: "luke/app",
            branch: "jarvis/fix-the-thing",
            prompt: "Fix the failing login test.",
            state: "queued",
            crashPolicy: "prune",
            containerId: null,
            workspacePath: "/home/jarvis/.jarvis/jobs/c1/repo",
            logTail: "",
            diffSummary: null,
            prUrl: null,
            attempts: 0,
            lastError: null,
            createdAt: "2026-10-19T12:00:00.000Z",
            startedAt: null,
            finishedAt: null,
        });
    });

    it("stores the crash policy the user chose", () => {
        const { store, ownerId } = makeStore();
        const created = store.createCodingJob(
            ownerId,
            codingJob({ crashPolicy: "resume" }),
        );
        expect(created.crashPolicy).toBe("resume");
    });

    it("scopes the user read to its owner", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(ownerId, codingJob());

        expect(store.getCodingJob(ownerId, "c1")?.id).toBe("c1");
        // A foreign id is indistinguishable from a missing one.
        expect(store.getCodingJob(userId, "c1")).toBeNull();
        expect(store.getCodingJob(ownerId, "nope")).toBeNull();
        // The process-scoped read has no owner to ask.
        expect(store.getCodingJobById("c1")?.id).toBe("c1");
    });

    it("claims a queued job once, recording the container and the attempt", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());

        const claimed = store.claimCodingJob(
            "c1",
            "abc123",
            "2026-10-19T12:01:00.000Z",
        );
        expect(claimed?.state).toBe("running");
        expect(claimed?.containerId).toBe("abc123");
        expect(claimed?.attempts).toBe(1);
        expect(claimed?.startedAt).toBe("2026-10-19T12:01:00.000Z");

        // The claim lives in the WHERE clause: a second claimant wins nothing.
        expect(
            store.claimCodingJob("c1", "second", "2026-10-19T12:02:00.000Z"),
        ).toBeNull();
        expect(store.getCodingJobById("c1")?.containerId).toBe("abc123");
        expect(store.getCodingJobById("c1")?.attempts).toBe(1);
    });

    it("keeps the container id after a settle, so the record still names it", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob("c1", "abc123", "2026-10-19T12:01:00.000Z");

        const settled = store.settleCodingJob(
            "c1",
            "ok",
            {},
            "2026-10-19T12:30:00.000Z",
        );
        expect(settled?.state).toBe("ok");
        expect(settled?.containerId).toBe("abc123");
        expect(settled?.finishedAt).toBe("2026-10-19T12:30:00.000Z");
    });

    it("records a failed run's reason and its output tail", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob("c1", "abc123", "2026-10-19T12:01:00.000Z");

        const settled = store.settleCodingJob(
            "c1",
            "failed",
            {
                logTail: "error: tests failed\n",
                error: "the agent exited 1",
            },
            "2026-10-19T12:30:00.000Z",
        );
        expect(settled?.state).toBe("failed");
        expect(settled?.lastError).toBe("the agent exited 1");
        expect(settled?.logTail).toBe("error: tests failed\n");
    });

    it("lets a late duplicate settle change nothing", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob("c1", "abc123", "2026-10-19T12:01:00.000Z");
        store.settleCodingJob(
            "c1",
            "ok",
            { diffSummary: "1 file changed" },
            "2026-10-19T12:30:00.000Z",
        );

        const again = store.settleCodingJob(
            "c1",
            "failed",
            { diffSummary: "rewritten", error: "late" },
            "2026-10-19T12:40:00.000Z",
        );
        expect(again?.state).toBe("ok");
        expect(again?.diffSummary).toBe("1 file changed");
        expect(again?.lastError).toBeNull();
        expect(again?.finishedAt).toBe("2026-10-19T12:30:00.000Z");
    });

    it("does not settle a job that was never claimed, except as failed", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob({ id: "never" }));
        store.createCodingJob(ownerId, codingJob({ id: "broken" }));

        // Nothing ran, so nothing can have succeeded.
        expect(
            store.settleCodingJob("never", "ok", {}, "2026-10-19T12:30:00.000Z")
                ?.state,
        ).toBe("queued");

        // A start that threw is the one ending a queued row can reach, and it
        // must be recordable — otherwise the row would claim to be waiting
        // forever.
        const failed = store.settleCodingJob(
            "broken",
            "failed",
            { error: "the container image is missing" },
            "2026-10-19T12:31:00.000Z",
        );
        expect(failed?.state).toBe("failed");
        expect(failed?.lastError).toBe("the container image is missing");
        expect(failed?.attempts).toBe(0);
    });

    it("cancels a queued job but not a running or settled one", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(ownerId, codingJob({ id: "queued" }));
        store.createCodingJob(ownerId, codingJob({ id: "running" }));
        store.claimCodingJob("running", "abc123", "2026-10-19T12:01:00.000Z");

        const cancelled = store.cancelCodingJob(
            ownerId,
            "queued",
            "2026-10-19T12:02:00.000Z",
        );
        expect(cancelled?.state).toBe("cancelled");
        expect(cancelled?.finishedAt).toBe("2026-10-19T12:02:00.000Z");

        // A running job is stopped through its container, not by editing a row
        // out from under the process watching it; a foreign cancel is a miss.
        expect(
            store.cancelCodingJob(
                ownerId,
                "running",
                "2026-10-19T12:03:00.000Z",
            )?.state,
        ).toBe("running");
        expect(
            store.cancelCodingJob(userId, "queued", "2026-10-19T12:04:00.000Z"),
        ).toBeNull();
    });

    it("lists a user's jobs, hiding settled ones unless asked", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(
            ownerId,
            codingJob({ id: "old", createdAt: "2026-10-19T09:00:00.000Z" }),
        );
        store.createCodingJob(
            ownerId,
            codingJob({ id: "new", createdAt: "2026-10-19T10:00:00.000Z" }),
        );
        store.createCodingJob(
            userId,
            codingJob({ id: "theirs", createdAt: "2026-10-19T11:00:00.000Z" }),
        );
        store.claimCodingJob("old", "c-1", "2026-10-19T09:01:00.000Z");
        store.settleCodingJob("old", "ok", {}, "2026-10-19T09:30:00.000Z");

        expect(store.listCodingJobs(ownerId).map((j) => j.id)).toEqual(["new"]);
        expect(
            store
                .listCodingJobs(ownerId, { includeSettled: true })
                .map((j) => j.id),
        ).toEqual(["new", "old"]);
        expect(store.listCodingJobs(ownerId, { limit: 1 })).toHaveLength(1);
    });

    it("reports every user's running jobs to the process", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(ownerId, codingJob({ id: "mine" }));
        store.createCodingJob(userId, codingJob({ id: "theirs" }));
        store.createCodingJob(userId, codingJob({ id: "queued" }));
        store.claimCodingJob("mine", "c-1", "2026-10-19T12:01:00.000Z");
        store.claimCodingJob("theirs", "c-2", "2026-10-19T12:02:00.000Z");

        expect(store.listRunningCodingJobs(10).map((j) => j.id)).toEqual([
            "mine",
            "theirs",
        ]);
        expect(store.listRunningCodingJobs(1).map((j) => j.id)).toEqual([
            "mine",
        ]);
    });

    it("replaces the stored output tail", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.setCodingJobLogTail("c1", "line one\nline two\n");
        expect(store.getCodingJobById("c1")?.logTail).toBe(
            "line one\nline two\n",
        );
    });

    it("prunes settled history but never queued or running work", () => {
        const { store, ownerId } = makeStore();
        for (const id of ["a", "b", "c", "d"]) {
            store.createCodingJob(
                ownerId,
                codingJob({
                    id,
                    createdAt: `2026-10-19T0${id.charCodeAt(0) - 96}:00:00.000Z`,
                }),
            );
            store.claimCodingJob(id, `c-${id}`, "2026-10-19T12:01:00.000Z");
            store.settleCodingJob(id, "ok", {}, "2026-10-19T12:30:00.000Z");
        }
        store.createCodingJob(
            ownerId,
            codingJob({ id: "live", createdAt: "2026-10-19T05:00:00.000Z" }),
        );
        store.claimCodingJob("live", "c-live", "2026-10-19T12:01:00.000Z");

        // Keep the two newest settled rows; `live` survives despite being the
        // oldest row overall, because a run in flight is not history.
        expect(store.pruneCodingJobs(ownerId, 2)).toBe(2);
        expect(
            store
                .listCodingJobs(ownerId, { includeSettled: true })
                .map((j) => j.id),
        ).toEqual(["live", "d", "c"]);
    });
});
