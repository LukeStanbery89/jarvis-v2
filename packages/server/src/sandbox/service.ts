/**
 * The coding-job supervisor (#141).
 *
 * One job's life, from "the user asked for this" to a settled row and one
 * announcement: prepare a clone, claim the row with the container's id, stream
 * the container's output, collect what it left behind, settle, reap. The
 * process that starts a job does not wait for it — a coding job is minutes to
 * hours — so {@link CodingJobService.start} returns as soon as the container is
 * running, with a `done` promise the caller may await (tests do; a tool does
 * not).
 *
 * Crash policy is the one place the supervisor reads the user's decision rather
 * than making it: a job carries `prune` or `resume` (#141), and the boot
 * reaper honours it. `prune` never means "lose the evidence": the tail is read
 * from the container before it is removed, so the settled row still says where
 * the job stopped.
 *
 * The notification deliberately does **not** carry a `jobId`: that field links
 * to the scheduler's `jobs` table, and a coding job id is not a row there. The
 * id is in the text instead, so nothing invents a foreign key.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
    AppCodingJob,
    CodingJobCrashPolicy,
    CodingJobLedger,
} from "@lukestanbery/jarvis-auth";
import {
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
} from "@lukestanbery/jarvis-protocol";
import type { SandboxConfig } from "../config";
import { logger } from "../logger";
import type { NotificationService } from "../notify/service";
import {
    reconcileCodingJobs,
    type CodingJobRecoveryHandlers,
    type RecoverySummary,
} from "./recovery";
import type {
    SandboxExit,
    SandboxHandle,
    SandboxRunner,
    SandboxSpec,
} from "./types";
import type { PreparedWorkspace, WorkspaceManager } from "./workspace";

/** How much of a job's output is kept on its row (the tail, not the whole log). */
const LOG_TAIL_BYTES = 16 * 1024;

/** Why a job could not be started; each code is a decision a surface routes on. */
export type CodingJobRefusalCode =
    "task-missing" | "model-missing" | "repo-not-allowed" | "busy";

/** The result of asking to start one job. */
export type StartCodingJobResult =
    | { ok: true; job: AppCodingJob; done: Promise<void> }
    | { ok: false; code: CodingJobRefusalCode; reason: string };

/** The supervisor's public surface. */
export interface CodingJobService {
    /**
     * Prepares a workspace, starts the container and returns immediately.
     *
     * The returned `done` resolves when the job has settled (or when the
     * process that owned it died — the reaper settles then). A caller that
     * does not care ignores it.
     */
    start(input: {
        userId: number;
        repo: string;
        task: string;
        crashPolicy?: CodingJobCrashPolicy;
    }): Promise<StartCodingJobResult>;
    /**
     * Reconciles rows and containers after a restart, then supervises whatever
     * was adopted. Runs once, at boot.
     */
    recover(): Promise<RecoverySummary>;
    /**
     * Cancels one of the caller's own running jobs: the row settles
     * `cancelled` first (so the supervisor's own settle cannot win), then the
     * container is removed.
     *
     * @returns The row after the attempt, or `null` for a foreign or missing id.
     */
    stop(userId: number, jobId: string): Promise<AppCodingJob | null>;
}

/**
 * Builds the supervisor.
 *
 * @param options - The ledger, runner, workspace, config and optional notifier.
 * @returns The service the composition root wires and the tool calls.
 */
export function createCodingJobService(options: {
    ledger: CodingJobLedger;
    runner: SandboxRunner;
    workspace: WorkspaceManager;
    config: SandboxConfig;
    notifications?: Pick<NotificationService, "notify">;
    now?: () => Date;
    newId?: () => string;
}): CodingJobService {
    const { ledger, runner, workspace, config, notifications } = options;
    const now = options.now ?? (() => new Date());
    const newId = options.newId ?? (() => randomUUID());
    const nowIso = () => now().toISOString();

    /**
     * Announces a job's ending. Failure to announce never changes the row — the
     * run record is the durable fact, the notification is the courtesy.
     *
     * @param job - The job that ended.
     * @param ok - Whether it succeeded.
     * @param detail - What to say: the diff summary, or why it failed.
     */
    async function announce(
        job: AppCodingJob,
        ok: boolean,
        detail: string,
    ): Promise<void> {
        if (notifications === undefined) {
            return;
        }
        try {
            await notifications.notify(job.userId, {
                kind: ok ? "coding.finished" : "coding.failed",
                class: "notification",
                priority: "normal",
                title: clamp(
                    `${ok ? "Coding job finished" : "Coding job failed"}: ${job.repo}`,
                    MAX_NOTIFICATION_TITLE_LENGTH,
                ),
                body: clamp(
                    detail.length > 0 ? detail : "The run left no summary.",
                    MAX_NOTIFICATION_BODY_LENGTH,
                ),
            });
        } catch (err) {
            logger.warn(
                `coding job ${job.id}: could not announce its ending: ${describe(err)}`,
            );
        }
    }

    /**
     * Watches one container to its end and settles the job.
     *
     * Idempotent in effect: if the row is no longer `running` (a user cancel
     * settled it first), this does nothing but reap the container.
     *
     * @param job - The claimed row.
     * @param handle - The running container.
     */
    async function supervise(
        job: AppCodingJob,
        handle: SandboxHandle,
    ): Promise<void> {
        const tail = createLogTail(LOG_TAIL_BYTES);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            void handle.stop().catch((err: unknown) => {
                logger.warn(
                    `coding job ${job.id}: could not stop an overrunning container: ${describe(err)}`,
                );
            });
        }, config.wallClockMs);
        timer.unref?.();

        try {
            try {
                for await (const line of handle.logs({
                    ...(job.startedAt !== null ? { since: job.startedAt } : {}),
                })) {
                    tail.push(line);
                }
            } catch (err) {
                // A broken log stream must not cost the job its ending: the
                // exit code below is the outcome, the log is commentary.
                logger.warn(
                    `coding job ${job.id}: log stream failed: ${describe(err)}`,
                );
            }

            const exit: SandboxExit = await handle
                .wait()
                .catch(() => ({ exitCode: null }));

            const current = ledger.getCodingJobById(job.id);
            if (current === null || current.state !== "running") {
                // Someone else (a cancel) already decided this job's ending.
                return;
            }

            const collected = await workspace
                .collect({ workspacePath: job.workspacePath })
                .catch((err: unknown) => {
                    logger.warn(
                        `coding job ${job.id}: could not collect its artifacts: ${describe(err)}`,
                    );
                    return { changed: false, diffSummary: "" };
                });

            const ok = !timedOut && exit.exitCode === 0;
            const error = ok
                ? null
                : timedOut
                  ? `the job exceeded its ${Math.round(
                        config.wallClockMs / 60_000,
                    )}-minute wall clock`
                  : `the agent exited with code ${exit.exitCode ?? "unknown"}`;

            const settled = ledger.settleCodingJob(
                job.id,
                ok ? "ok" : "failed",
                {
                    diffSummary: collected.diffSummary,
                    logTail: tail.text(),
                    error,
                },
                nowIso(),
            );

            if (!ok) {
                // A failed workspace is evidence nobody can act on, and it
                // would grow the volume one dead clone at a time.
                await workspace
                    .remove(job.workspacePath)
                    .catch((err: unknown) => {
                        logger.warn(
                            `coding job ${job.id}: could not remove its failed workspace: ${describe(err)}`,
                        );
                    });
            }

            await announce(
                settled ?? job,
                ok,
                ok
                    ? collected.diffSummary
                    : `${error ?? "the run failed"}\n\n${tail
                          .text()
                          .slice(-800)}`,
            );
        } finally {
            clearTimeout(timer);
            if (job.containerId !== null) {
                await runner.remove(job.containerId).catch((err: unknown) => {
                    logger.warn(
                        `coding job ${job.id}: could not remove its container: ${describe(err)}`,
                    );
                });
            }
        }
    }

    /**
     * The container spec for one job. The workspace is the only mount, the
     * image's entrypoint is the agent, and the prompt travels by environment
     * rather than argv so a shell never sees it.
     *
     * @param job - The stored row.
     * @param prepared - The clone's two paths.
     * @param task - The instruction.
     * @returns The spec the runner starts.
     */
    function specFor(
        job: AppCodingJob,
        prepared: PreparedWorkspace,
        task: string,
    ): SandboxSpec {
        return {
            jobId: job.id,
            image: config.image,
            workspacePath: prepared.hostPath,
            // The image's entrypoint owns the command line: it reads the job
            // from the environment, so the prompt never becomes an argv token.
            command: [],
            env: {
                JARVIS_JOB_ID: job.id,
                JARVIS_JOB_REPO: job.repo,
                JARVIS_JOB_BRANCH: job.branch,
                JARVIS_JOB_PROMPT: task,
                // The endpoint and the id are separate on purpose: the agent's
                // provider block is generated at container start from these,
                // so a deployment changes its model without rebuilding the
                // image and no repository can supply a provider.
                JARVIS_JOB_LLM_BASE_URL: config.llmBaseUrl,
                JARVIS_JOB_MODEL_ID: config.model,
                HOME: "/home/job",
            },
            limits: {
                cpus: config.cpus,
                memoryMb: config.memoryMb,
                pids: config.pids,
                wallClockMs: config.wallClockMs,
            },
            // The job image runs as uid 10001, so its tmpfs home is mounted
            // *for that uid* — the image's job user. The root filesystem stays
            // read-only and the home is private (0700), not shared scratch.
            tmpfs: {
                "/home/job": "rw,size=256m,uid=10001,gid=10001,mode=0700",
            },
            extraHosts: config.extraHosts,
        };
    }

    return {
        async start(input): Promise<StartCodingJobResult> {
            const task = input.task.trim();
            if (task.length === 0) {
                return {
                    ok: false,
                    code: "task-missing",
                    reason: "a coding job needs a task to work on",
                };
            }
            if (config.model.trim().length === 0) {
                return {
                    ok: false,
                    code: "model-missing",
                    reason: "no coding model is configured (`JARVIS_SANDBOX_MODEL`)",
                };
            }
            const repo = workspace.allows(input.repo);
            if (repo === null) {
                return {
                    ok: false,
                    code: "repo-not-allowed",
                    reason:
                        config.repos.length === 0
                            ? "no repository is allowed (`JARVIS_SANDBOX_REPOS` is empty)"
                            : `${input.repo} is not in JARVIS_SANDBOX_REPOS`,
                };
            }

            // A cap on concurrent jobs rather than a queue: a second job on a
            // laptop would starve the first of the model and the CPU, and a
            // refusal is a sentence the user can act on.
            if (
                ledger.listRunningCodingJobs(config.maxJobs).length >=
                config.maxJobs
            ) {
                return {
                    ok: false,
                    code: "busy",
                    reason: `${config.maxJobs} coding job(s) are already running`,
                };
            }

            const id = newId();
            const branch = branchFor(task, id);
            const prepared = await workspace.prepare({
                jobId: id,
                repo,
                branch,
            });

            const job = ledger.createCodingJob(input.userId, {
                id,
                repo: repo.entry,
                branch,
                prompt: task,
                workspacePath: prepared.path,
                crashPolicy: input.crashPolicy ?? "prune",
                createdAt: nowIso(),
            });

            try {
                const handle = await runner.start(specFor(job, prepared, task));
                const claimed = ledger.claimCodingJob(
                    job.id,
                    handle.containerId,
                    nowIso(),
                );
                if (claimed === null) {
                    await handle.remove();
                    throw new Error("the job was claimed by another process");
                }
                return {
                    ok: true,
                    job: claimed,
                    done: supervise(claimed, handle),
                };
            } catch (err) {
                // The row must not sit `queued` forever because the container
                // never started; `failed` is the one ending a queued row can
                // reach, and it names what went wrong.
                ledger.settleCodingJob(
                    job.id,
                    "failed",
                    { error: describe(err) },
                    nowIso(),
                );
                await workspace.remove(prepared.path).catch(() => {});
                throw err;
            }
        },

        async recover(): Promise<RecoverySummary> {
            const handlers: CodingJobRecoveryHandlers = {
                resume: async (job, handle) => {
                    // Adopt and keep watching. `reconcile` returns as soon as
                    // every row is classified, so the boot is not held open by
                    // a job with an hour left on its clock.
                    void supervise(job, handle);
                },
                fail: async (job, handle, reason) => {
                    const tail = createLogTail(LOG_TAIL_BYTES);
                    if (handle !== null) {
                        // Stop first: the log stream only ends when the
                        // container does, and a prune is discarding the work
                        // anyway. The tail is what survives.
                        await handle.stop().catch(() => {});
                        try {
                            for await (const line of handle.logs()) {
                                tail.push(line);
                            }
                        } catch {
                            // A container that cannot be read is still a
                            // container that must be removed.
                        }
                        await handle.remove().catch((err: unknown) => {
                            logger.warn(
                                `coding job ${job.id}: could not remove its recovered container: ${describe(err)}`,
                            );
                        });
                    }
                    ledger.settleCodingJob(
                        job.id,
                        "failed",
                        { error: reason, logTail: tail.text() },
                        nowIso(),
                    );
                    await workspace.remove(job.workspacePath).catch(() => {});
                    await announce(job, false, reason);
                },
                discard: async (jobId) => {
                    // A container with no row: its workspace is still at the
                    // deterministic path, so it can be removed too.
                    await workspace
                        .remove(path.join(config.workspaceRoot, jobId, "repo"))
                        .catch(() => {});
                },
            };

            return reconcileCodingJobs({ ledger, runner, handlers });
        },

        async stop(userId, jobId): Promise<AppCodingJob | null> {
            const job = ledger.getCodingJob(userId, jobId);
            if (job === null) {
                return null;
            }
            if (job.state !== "running") {
                return job;
            }
            // Settle first: the supervisor's settle is terminal-guarded, so the
            // user's decision wins the race, and the supervisor then stays
            // silent instead of announcing a failure.
            const cancelled = ledger.settleCodingJob(
                job.id,
                "cancelled",
                {},
                nowIso(),
            );
            if (job.containerId !== null) {
                await runner.remove(job.containerId).catch((err: unknown) => {
                    logger.warn(
                        `coding job ${job.id}: could not remove its cancelled container: ${describe(err)}`,
                    );
                });
            }
            await workspace.remove(job.workspacePath).catch(() => {});
            return cancelled;
        },
    };
}

/**
 * The branch a job works on: a readable slug plus the id, so two jobs with the
 * same task never collide on one branch.
 *
 * @param task - The instruction.
 * @param id - The job id.
 * @returns A branch name.
 */
export function branchFor(task: string, id: string): string {
    const slug =
        task
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) || "job";
    return `jarvis/${slug}-${id.slice(0, 8)}`;
}

/**
 * A bounded tail of a log: the last `maxBytes` of output, in order.
 *
 * Bounded rather than complete because it is stored on a row: a chatty agent
 * would otherwise write megabytes into SQLite, and the container's own log is
 * the full record while it exists.
 */
export function createLogTail(maxBytes: number): {
    push(line: string): void;
    text(): string;
} {
    const lines: string[] = [];
    let size = 0;
    return {
        push(line: string): void {
            const entry = `${line}\n`;
            size += Buffer.byteLength(entry);
            lines.push(entry);
            while (size > maxBytes && lines.length > 1) {
                const dropped = lines.shift();
                size -= Buffer.byteLength(dropped ?? "");
            }
        },
        text(): string {
            return lines.join("");
        },
    };
}

/**
 * Truncates a string to a wire limit without cutting a surrogate pair.
 *
 * @param value - The text.
 * @param limit - Maximum characters.
 * @returns The text, shortened when needed.
 */
function clamp(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Renders an unknown throw for a log line or a row.
 *
 * @param err - Whatever was caught.
 * @returns The message, never a stack (a row is user-facing).
 */
function describe(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
