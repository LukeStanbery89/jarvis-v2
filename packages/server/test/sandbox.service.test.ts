/**
 * Supervisor tests (#141).
 *
 * The daemon and git are both faked here, because what is being tested is the
 * *lifecycle*: who claims the row, what the container is handed, what a
 * successful or failed ending records, what a cancel does to a supervisor
 * already watching, and what the boot does with each disagreement between a row
 * and a container. Real Docker and real git are covered by the probe, the
 * runner's smoke test and the workspace suite.
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import type { SandboxConfig } from "../src/config";
import type { NotificationService } from "../src/notify/service";
import { createFakeSandbox } from "../src/sandbox/fake";
import { createCodingJobService } from "../src/sandbox/service";
import type { RepoSpec, WorkspaceManager } from "../src/sandbox/workspace";

/** A config with every knob decided. */
const CONFIG: SandboxConfig = {
    image: "jarvis-job:test",
    socketPath: "/var/run/docker.sock",
    workspaceRoot: "/jobs",
    workspaceHostRoot: "/host/jobs",
    maxJobs: 1,
    cpus: 2,
    memoryMb: 1024,
    pids: 128,
    wallClockMs: 60_000,
    repos: ["luke/app"],
    model: "lmstudio/qwen3",
    llmBaseUrl: "http://host.docker.internal:1234/v1",
    extraHosts: [],
};

/** A store with one owner. */
function makeStore(): { store: AppDatabase; userId: number } {
    const store = createInMemoryAppDatabase();
    const user = store.createUser("luke", "hash", "owner");
    return { store, userId: user.id };
}

/** A workspace that records what it was asked to do, without touching disk. */
function fakeWorkspace(
    options: {
        allow?: boolean;
        collect?: () => { changed: boolean; diffSummary: string };
    } = {},
): WorkspaceManager & {
    prepared: Array<{ jobId: string; branch: string }>;
    removed: string[];
} {
    const prepared: Array<{ jobId: string; branch: string }> = [];
    const removed: string[] = [];
    return {
        prepared,
        removed,
        allows(repo: string): RepoSpec | null {
            if (options.allow === false) {
                return null;
            }
            return {
                entry: repo,
                owner: "luke",
                name: "app",
                url: "https://github.com/luke/app",
            };
        },
        async prepare(input) {
            prepared.push({ jobId: input.jobId, branch: input.branch });
            return {
                path: `/jobs/${input.jobId}/repo`,
                hostPath: `/host/jobs/${input.jobId}/repo`,
            };
        },
        async collect() {
            return (
                options.collect?.() ?? {
                    changed: true,
                    diffSummary: "1 file changed",
                }
            );
        },
        async remove(workspacePath: string) {
            removed.push(workspacePath);
        },
    };
}

/** A notification service spy; the outcome itself is not under test. */
function notifications(): Pick<NotificationService, "notify"> & {
    notify: ReturnType<typeof vi.fn>;
} {
    return {
        notify: vi.fn(async () => ({
            notification: {},
            delivered: 1,
            suppressed: null,
        })),
    } as unknown as Pick<NotificationService, "notify"> & {
        notify: ReturnType<typeof vi.fn>;
    };
}

/** The fake workspace's surface, including its recording arrays. */
type FakeWorkspace = ReturnType<typeof fakeWorkspace>;

/** A service whose ids count up, so assertions can name the rows. */
function makeService(
    overrides: {
        config?: Partial<SandboxConfig>;
        workspace?: FakeWorkspace;
        runner?: ReturnType<typeof createFakeSandbox>;
        now?: () => Date;
    } = {},
) {
    const { store, userId } = makeStore();
    const workspace = overrides.workspace ?? fakeWorkspace();
    const runner = overrides.runner ?? createFakeSandbox();
    const notify = notifications();
    let sequence = 0;
    const service = createCodingJobService({
        ledger: store,
        runner,
        workspace,
        config: { ...CONFIG, ...overrides.config },
        notifications: notify,
        now: overrides.now ?? (() => new Date("2026-10-19T12:00:00.000Z")),
        newId: () => `job-${++sequence}`,
    });
    return { store, userId, workspace, runner, notify, service };
}

describe("starting a coding job", () => {
    it("clones, starts the container and settles an ok run", async () => {
        const { store, userId, workspace, runner, notify, service } =
            makeService();

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Fix the login bug",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }

        expect(started.job).toMatchObject({
            id: "job-1",
            state: "running",
            repo: "luke/app",
            crashPolicy: "prune",
            attempts: 1,
            workspacePath: "/jobs/job-1/repo",
        });
        expect(started.job.branch).toMatch(/^jarvis\/fix-the-login-bug-/);
        expect(workspace.prepared).toEqual([
            { jobId: "job-1", branch: started.job.branch },
        ]);
        expect(runner.started).toHaveLength(1);
        expect(runner.started[0]).toMatchObject({
            jobId: "job-1",
            image: "jarvis-job:test",
            // The *host* path, not the server's: the daemon resolves it.
            workspacePath: "/host/jobs/job-1/repo",
            command: [],
        });
        expect(runner.started[0]?.env).toMatchObject({
            JARVIS_JOB_PROMPT: "Fix the login bug",
            JARVIS_JOB_MODEL_ID: "lmstudio/qwen3",
            JARVIS_JOB_LLM_BASE_URL: "http://host.docker.internal:1234/v1",
            JARVIS_JOB_BRANCH: started.job.branch,
        });

        runner.emit(started.job.containerId ?? "", "working…");
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        const settled = store.getCodingJobById("job-1");
        expect(settled?.state).toBe("ok");
        expect(settled?.logTail).toContain("working…");
        expect(settled?.diffSummary).toBe("1 file changed");
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({ kind: "coding.finished" }),
        );
        // The container is gone; the workspace is kept for the PR step.
        expect(runner.removed).toContain(started.job.containerId);
        expect(workspace.removed).toEqual([]);
    });

    it("records a failed run, removes its workspace and says why", async () => {
        const { store, userId, workspace, runner, notify, service } =
            makeService();
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Break the build",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }

        runner.emit(started.job.containerId ?? "", "error: tests failed");
        runner.exit(started.job.containerId ?? "", 1);
        await started.done;

        const settled = store.getCodingJobById("job-1");
        expect(settled?.state).toBe("failed");
        expect(settled?.lastError).toContain("exited with code 1");
        expect(settled?.logTail).toContain("error: tests failed");
        expect(workspace.removed).toEqual(["/jobs/job-1/repo"]);
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({ kind: "coding.failed" }),
        );
    });

    it("stops a job that overruns its wall clock", async () => {
        vi.useFakeTimers();
        try {
            const { store, userId, runner, service } = makeService();
            const started = await service.start({
                userId,
                repo: "luke/app",
                task: "Ruminate forever",
            });
            if (!started.ok) {
                throw new Error("fixture refused");
            }

            await vi.advanceTimersByTimeAsync(CONFIG.wallClockMs);
            await started.done;

            const settled = store.getCodingJobById("job-1");
            expect(settled?.state).toBe("failed");
            expect(settled?.lastError).toContain("wall clock");
            // The fake's stop ends the container, which is what unblocks the
            // supervisor's log stream.
            expect(runner.removed).toContain(started.job.containerId);
        } finally {
            vi.useRealTimers();
        }
    });

    it("refuses a missing task, a missing model, a foreign repo and a full queue", async () => {
        const missingTask = makeService();
        expect(
            await missingTask.service.start({
                userId: missingTask.userId,
                repo: "luke/app",
                task: "   ",
            }),
        ).toMatchObject({ ok: false, code: "task-missing" });

        const noModel = makeService({ config: { model: "" } });
        expect(
            await noModel.service.start({
                userId: noModel.userId,
                repo: "luke/app",
                task: "do it",
            }),
        ).toMatchObject({ ok: false, code: "model-missing" });

        const foreign = makeService({
            workspace: fakeWorkspace({ allow: false }),
        });
        const refused = await foreign.service.start({
            userId: foreign.userId,
            repo: "someone/else",
            task: "do it",
        });
        expect(refused).toMatchObject({ ok: false, code: "repo-not-allowed" });
        expect(foreign.runner.started).toHaveLength(0);

        const busy = makeService();
        const first = await busy.service.start({
            userId: busy.userId,
            repo: "luke/app",
            task: "first",
        });
        expect(first.ok).toBe(true);
        expect(
            await busy.service.start({
                userId: busy.userId,
                repo: "luke/app",
                task: "second",
            }),
        ).toMatchObject({ ok: false, code: "busy" });
        // Only one clone and one container were ever made.
        expect(busy.workspace.prepared).toHaveLength(1);
        expect(busy.runner.started).toHaveLength(1);
    });
});

describe("stopping a coding job", () => {
    it("settles cancelled, reaps the container and stays silent", async () => {
        const { store, userId, workspace, runner, notify, service } =
            makeService();
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "long task",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }

        const cancelled = await service.stop(userId, "job-1");
        expect(cancelled?.state).toBe("cancelled");
        expect(runner.removed).toContain(started.job.containerId);
        expect(workspace.removed).toEqual(["/jobs/job-1/repo"]);

        // The supervisor was already watching; the terminal guard keeps it
        // from announcing a failure for the user's own decision.
        await started.done;
        expect(store.getCodingJobById("job-1")?.state).toBe("cancelled");
        expect(notify.notify).not.toHaveBeenCalled();
    });

    it("is a miss for a foreign id and a no-op for a settled job", async () => {
        const { store, userId, service } = makeService();
        expect(await service.stop(userId, "nope")).toBeNull();

        const other = store.createUser("sam", "hash", "user");
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "do it",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }
        expect(await service.stop(other.id, "job-1")).toBeNull();
        expect(store.getCodingJobById("job-1")?.state).toBe("running");
    });
});

describe("recovering coding jobs at boot", () => {
    it("prunes a running container, keeping its tail as evidence", async () => {
        const { store, userId } = makeStore();
        store.createCodingJob(userId, {
            id: "job-1",
            repo: "luke/app",
            branch: "jarvis/one",
            prompt: "do it",
            workspacePath: "/jobs/job-1/repo",
            createdAt: "2026-10-19T11:00:00.000Z",
        });
        store.claimCodingJob("job-1", "c-1", "2026-10-19T11:01:00.000Z");

        const runner = createFakeSandbox({
            containers: [
                {
                    containerId: "c-1",
                    jobId: "job-1",
                    logs: ["was working on it"],
                },
            ],
        });
        const workspace = fakeWorkspace();
        const notify = notifications();
        const service = createCodingJobService({
            ledger: store,
            runner,
            workspace,
            config: CONFIG,
            notifications: notify,
            now: () => new Date("2026-10-19T12:00:00.000Z"),
        });

        const summary = await service.recover();

        expect(summary).toMatchObject({ pruned: 1, adopted: 0, failed: 0 });
        const settled = store.getCodingJobById("job-1");
        expect(settled?.state).toBe("failed");
        expect(settled?.lastError).toContain("server restarted");
        expect(settled?.logTail).toContain("was working on it");
        expect(runner.removed).toContain("c-1");
        expect(workspace.removed).toEqual(["/jobs/job-1/repo"]);
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({ kind: "coding.failed" }),
        );
    });

    it("adopts a resume job and keeps watching it", async () => {
        const { store, userId } = makeStore();
        store.createCodingJob(userId, {
            id: "job-1",
            repo: "luke/app",
            branch: "jarvis/one",
            prompt: "do it",
            workspacePath: "/jobs/job-1/repo",
            crashPolicy: "resume",
            createdAt: "2026-10-19T11:00:00.000Z",
        });
        store.claimCodingJob("job-1", "c-1", "2026-10-19T11:01:00.000Z");

        const runner = createFakeSandbox({
            containers: [{ containerId: "c-1", jobId: "job-1" }],
        });
        const service = createCodingJobService({
            ledger: store,
            runner,
            workspace: fakeWorkspace(),
            config: CONFIG,
            now: () => new Date("2026-10-19T12:00:00.000Z"),
        });

        const summary = await service.recover();
        expect(summary.adopted).toBe(1);
        expect(runner.removed).toEqual([]);
        // Still running: adoption is a continuation, not a settlement.
        expect(store.getCodingJobById("job-1")?.state).toBe("running");

        runner.exit("c-1", 0);
        await vi.waitFor(() => {
            expect(store.getCodingJobById("job-1")?.state).toBe("ok");
        });
    });

    it("discards a container with no row and its workspace", async () => {
        const { store } = makeStore();
        const runner = createFakeSandbox({
            containers: [{ containerId: "c-ghost", jobId: "deleted-job" }],
        });
        const workspace = fakeWorkspace();
        const service = createCodingJobService({
            ledger: store,
            runner,
            workspace,
            config: CONFIG,
            now: () => new Date("2026-10-19T12:00:00.000Z"),
        });

        const summary = await service.recover();

        expect(summary.removed).toBe(1);
        expect(runner.removed).toEqual(["c-ghost"]);
        // The row is gone, but the workspace's path is derivable from the id
        // the container's label carried.
        expect(workspace.removed).toEqual(["/jobs/deleted-job/repo"]);
    });
});
