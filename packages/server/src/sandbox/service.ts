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
import type { IssueSnapshot, PullRequestSnapshot } from "../github/client";
import { logger } from "../logger";
import type { NotificationService } from "../notify/service";
import { createCodingLogHub, type CodingLogStream } from "./logHub";
import { createJobLog, sweepCodingLogs, type JobLog } from "./logs";
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
import type { JobPublisher } from "./publish";
import { deriveJobToken } from "./proxy";
import {
    sweepWorkspaces,
    type PreparedWorkspace,
    type WorkspaceManager,
} from "./workspace";

/** How much of a job's output is kept on its row (the tail, not the whole log). */
const LOG_TAIL_BYTES = 16 * 1024;

/** A settled run's outcome, as the announcement needs it. */
interface Ending {
    /** Whether the container exited 0 before the wall clock. */
    ok: boolean;
    /** Whether the workspace differs from the clone. */
    changed: boolean;
    /** Why it failed, or `null`. */
    error: string | null;
    /** What the run left behind, from `collect`. */
    diffSummary: string;
    /** The agent's own last words, parsed from its JSON output. */
    lastMessage: string;
    /** The pull request opened for the branch, or `null`. */
    prUrl: string | null;
    /** Why publishing failed, when it did — the job is still `ok`. */
    publishError: string | null;
    /** True when this run continued an existing pull request (#140). */
    followUp: boolean;
}

/** Why a job could not be started; each code is a decision a surface routes on. */
export type CodingJobRefusalCode =
    | "task-missing"
    | "model-missing"
    | "key-missing"
    | "repo-not-allowed"
    | "busy"
    | "follow-ups-unavailable"
    | "pull-request-unavailable"
    | "pull-request-closed"
    | "pull-request-fork"
    | "issue-unavailable"
    | "issue-is-pull-request"
    | "issue-and-pull-request";

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
        /**
         * Continue this pull request instead of opening a new branch (#140).
         *
         * The job checks out the PR's head branch, is handed the PR's
         * description and review comments, and pushes back to the same branch
         * — so the review updates rather than splitting in two.
         */
        pullRequest?: number;
        /**
         * Implement this GitHub issue (#140).
         *
         * The issue is read server-side and its title, description and URL are
         * prepended to the task, so "implement issue #N" is one tool call
         * instead of a read whose body the relay model would have to paste.
         */
        issue?: number;
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
    /**
     * Replays the buffered part of a job's log and follows the rest, until it
     * settles. The file is the durable record; this is the live window.
     *
     * @param jobId - The job to follow.
     * @returns A replay plus a subscription (see {@link CodingLogStream}).
     */
    openLogStream(jobId: string): CodingLogStream;
}

/**
 * Whether a model endpoint needs no credential because it is on this machine.
 *
 * A local LM Studio ignores an `Authorization` header; a remote provider
 * rejects the request without one. The distinction is the host, not the
 * scheme: `host.docker.internal` is the host as a container sees it, and the
 * loopback names cover a server running beside its model.
 *
 * @param baseUrl - The configured OpenAI-compatible endpoint.
 * @returns True when a job may start without an API key.
 */
export function isLocalModelEndpoint(baseUrl: string): boolean {
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        return (
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "::1" ||
            host === "[::1]" ||
            host === "host.docker.internal"
        );
    } catch {
        // An unparseable URL is not something to send a key to by default.
        return false;
    }
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
    /**
     * The credential broker a job talks to instead of the provider (#141
     * phase 7). When present, the container's base URL is the broker and its
     * `apiKey` is a token derived from its own job id; the real provider key
     * never enters the container.
     *
     * Absent means the direct shape (a job reaches the provider with
     * `config.apiKey`), which exists for tests and for a deliberately direct
     * deployment.
     */
    proxy?: { url: string; secret: string };
    /**
     * Pushes a successful branch and opens a pull request (#140).
     *
     * Absent means the branch stays local and the workspace is kept: the
     * publisher owns the GitHub decision, the supervisor only records what it
     * returned.
     */
    publisher?: JobPublisher;
    /**
     * Reads an existing pull request for a follow-up job (#140).
     *
     * Absent (no GitHub App) means a follow-up is refused rather than started
     * against a branch the server cannot see.
     */
    pullRequests?: (input: {
        owner: string;
        repo: string;
        number: number;
    }) => Promise<PullRequestSnapshot>;
    /** Reads an issue for `start({ issue })` (#140). */
    issues?: (input: {
        owner: string;
        repo: string;
        number: number;
    }) => Promise<IssueSnapshot>;
    notifications?: Pick<NotificationService, "notify">;
    now?: () => Date;
    newId?: () => string;
}): CodingJobService {
    const {
        ledger,
        runner,
        workspace,
        config,
        notifications,
        proxy,
        publisher,
        pullRequests,
        issues,
    } = options;
    const now = options.now ?? (() => new Date());
    const newId = options.newId ?? (() => randomUUID());
    const nowIso = () => now().toISOString();
    const logHub = createCodingLogHub();

    /**
     * Trims the owner's settled rows to the configured keep count.
     *
     * Called after every settle rather than per boot: a row is small but
     * unbounded growth is still growth, and the settle is the one moment the
     * table is guaranteed to have changed.
     *
     * @param userId - The job's owner.
     */
    function pruneRows(userId: number): void {
        try {
            const removed = ledger.pruneCodingJobs(userId, config.keepJobRows);
            if (removed > 0) {
                logger.info(
                    `coding retention: pruned ${removed} settled job row(s)`,
                );
            }
        } catch (err) {
            logger.warn(
                `coding retention: could not prune settled rows: ${describe(err)}`,
            );
        }
    }

    /**
     * Boot sweep: removes row-less or expired workspaces and expired logs.
     *
     * Retention is by `finished_at` for a workspace (falling back to creation
     * for a row that never got one) and by file `mtime` for a log, which is
     * what still works for a job whose row was pruned. A queued or running job
     * is never touched, and an unreadable timestamp keeps a workspace rather
     * than guessing.
     *
     * @returns What was removed, for one boot line.
     */
    async function sweepRetention(): Promise<{
        workspaces: string[];
        logs: { removed: number; bytes: number };
    }> {
        const nowMs = now().getTime();
        const workspaces = await sweepWorkspaces(
            config.workspaceRoot,
            (jobId) => {
                const job = ledger.getCodingJobById(jobId);
                if (job === null) {
                    return false;
                }
                if (job.state === "queued" || job.state === "running") {
                    return true;
                }
                const finished =
                    job.finishedAt !== null
                        ? Date.parse(job.finishedAt)
                        : Date.parse(job.createdAt);
                if (!Number.isFinite(finished)) {
                    return true;
                }
                return (
                    nowMs - finished <
                    config.workspaceRetentionDays * 86_400_000
                );
            },
        );
        const logs = await sweepCodingLogs({
            logRoot: config.logRoot,
            olderThanMs: config.logRetentionDays * 86_400_000,
            now: now(),
        });
        return { workspaces, logs };
    }

    /**
     * Announces a job's ending. Failure to announce never changes the row — the
     * run record is the durable fact, the notification is the courtesy.
     *
     * A run that exits 0 without touching a file is **not** a success to boast
     * about: the agent may have refused the task (a small model asked to change
     * something it cannot see does), and "finished" alone would read as "done".
     * The title says "finished with no changes" and the body carries the
     * agent's own last words, which is the only place its explanation exists.
     *
     * @param job - The job that ended.
     * @param ending - Its outcome and what to say about it.
     */
    async function announce(job: AppCodingJob, ending: Ending): Promise<void> {
        if (notifications === undefined) {
            return;
        }
        const title = !ending.ok
            ? `Coding job failed: ${job.repo}`
            : ending.changed
              ? `Coding job finished: ${job.repo}`
              : `Coding job finished with no changes: ${job.repo}`;
        const base = !ending.ok
            ? `${ending.error ?? "the run failed"}${
                  ending.lastMessage.length > 0
                      ? `\n\n${ending.lastMessage}`
                      : ""
              }`
            : ending.changed
              ? ending.diffSummary ||
                "The run changed files but left no summary."
              : ending.lastMessage ||
                "The agent finished without changing any files.";
        // A successful change's most useful fact is where it went. The pull
        // request is the answer when there is one; otherwise say why not,
        // rather than leaving the user to wonder whether the work escaped.
        const note =
            ending.prUrl !== null
                ? ending.followUp
                    ? `Updated pull request: ${ending.prUrl}`
                    : `Pull request: ${ending.prUrl}`
                : ending.publishError !== null
                  ? `The branch was not pushed: ${ending.publishError}`
                  : "";
        const body = note.length > 0 ? `${base}\n\n${note}` : base;
        try {
            await notifications.notify(job.userId, {
                kind: ending.ok ? "coding.finished" : "coding.failed",
                class: "notification",
                priority: "normal",
                title: clamp(title, MAX_NOTIFICATION_TITLE_LENGTH),
                body: clamp(body, MAX_NOTIFICATION_BODY_LENGTH),
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
        // A follow-up starts *at* its pull request, so the row already names
        // it; a new job learns the URL only when it publishes (#140).
        const followUp = job.prUrl !== null;
        const tail = createLogTail(LOG_TAIL_BYTES);
        // The full record, on disk: the container is removed below, so this is
        // the only post-mortem that outlives it (#141 phase 7).
        const log: JobLog = createJobLog({
            logRoot: config.logRoot,
            jobId: job.id,
            maxBytes: config.logMaxMb * 1024 * 1024,
        });
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
                    log.write(line);
                    logHub.publish(job.id, line);
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

            const ok = !timedOut && exit.exitCode === 0;
            const error = ok
                ? null
                : timedOut
                  ? `the job exceeded its ${Math.round(
                        config.wallClockMs / 60_000,
                    )}-minute wall clock`
                  : `the agent exited with code ${exit.exitCode ?? "unknown"}`;

            // A model can edit a file and *say* it committed without calling
            // git — the first live run did. Committing here makes the claim
            // true, and gives the branch something to push later. Only on
            // success: a failed tree is discarded, not curated.
            if (ok) {
                const firstLine = job.prompt.split("\n")[0] ?? "coding job";
                const committed = await workspace
                    .commit({
                        workspacePath: job.workspacePath,
                        message: `JARVIS: ${firstLine.slice(0, 72)}`,
                    })
                    .catch((err: unknown) => {
                        logger.warn(
                            `coding job ${job.id}: could not commit its workspace: ${describe(err)}`,
                        );
                        return false;
                    });
                if (committed) {
                    logger.info(
                        `coding job ${job.id}: committed the agent's uncommitted changes`,
                    );
                }
            }

            const collected = await workspace
                .collect({ workspacePath: job.workspacePath })
                .catch((err: unknown) => {
                    logger.warn(
                        `coding job ${job.id}: could not collect its artifacts: ${describe(err)}`,
                    );
                    return { changed: false, diffSummary: "" };
                });

            // Publishing is the last step of a successful run: the branch has
            // been committed and collected, so a push can carry it and a pull
            // request can describe it. A GitHub failure does not undo the work
            // — the job still settles `ok`, and its ending says what happened.
            let prUrl: string | null = null;
            let publishError: string | null = null;
            if (ok && collected.changed && publisher !== undefined) {
                try {
                    const published = await publisher.publish({
                        jobId: job.id,
                        workspacePath: job.workspacePath,
                        repo: job.repo,
                        branch: job.branch,
                        task: job.prompt,
                        diffSummary: collected.diffSummary,
                        ...(job.prUrl !== null
                            ? { existing: { url: job.prUrl } }
                            : {}),
                    });
                    prUrl = published?.prUrl ?? null;
                } catch (err) {
                    publishError = describe(err);
                    logger.warn(
                        `coding job ${job.id}: could not publish its branch: ${publishError}`,
                    );
                }
            }

            const settled = ledger.settleCodingJob(
                job.id,
                ok ? "ok" : "failed",
                {
                    diffSummary: collected.diffSummary,
                    logTail: tail.text(),
                    error,
                    ...(prUrl !== null ? { prUrl } : {}),
                },
                nowIso(),
            );

            // The supervisor used to settle in silence, so a job that ran and
            // ended looked identical in the log to one whose process died on
            // the way in. One line per ending is the cost of not wondering.
            const seconds =
                job.startedAt === null
                    ? null
                    : Math.max(
                          0,
                          (now().getTime() - Date.parse(job.startedAt)) / 1000,
                      );
            logger.info(
                `coding job ${job.id} settled ${ok ? "ok" : "failed"}` +
                    (seconds === null ? "" : ` after ${seconds.toFixed(1)}s`) +
                    `: changed=${collected.changed}` +
                    (prUrl === null ? "" : `, pr=${prUrl}`) +
                    (error === null ? "" : `, error=${error}`),
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

            await announce(settled ?? job, {
                ok,
                changed: collected.changed,
                error,
                diffSummary: collected.diffSummary,
                lastMessage: lastAgentMessage(tail.text()),
                prUrl,
                publishError,
                followUp,
            });
            pruneRows(job.userId);
            if (prUrl !== null) {
                // The branch is on the remote now; the clone is a second copy
                // of something GitHub already has (#140).
                await workspace
                    .remove(job.workspacePath)
                    .catch((err: unknown) => {
                        logger.warn(
                            `coding job ${job.id}: could not remove its published workspace: ${describe(err)}`,
                        );
                    });
            }
        } finally {
            clearTimeout(timer);
            logHub.finish(job.id);
            await log.close().catch((err: unknown) => {
                logger.warn(
                    `coding job ${job.id}: could not close its log: ${describe(err)}`,
                );
            });
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
                // The agent talks to the broker, never to the provider: the
                // key stays in this process and the container holds a token
                // derived from its own job id (#141 phase 7). Without a broker
                // (tests, or a deliberately direct deployment) the old shape
                // applies.
                JARVIS_JOB_LLM_BASE_URL: proxy?.url ?? config.llmBaseUrl,
                JARVIS_JOB_MODEL_ID: config.model,
                ...(proxy !== undefined
                    ? {
                          JARVIS_JOB_API_KEY: deriveJobToken(
                              proxy.secret,
                              job.id,
                          ),
                      }
                    : config.apiKey.length > 0
                      ? { JARVIS_JOB_API_KEY: config.apiKey }
                      : {}),
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
            ...(config.network.length > 0 ? { network: config.network } : {}),
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
            if (
                config.apiKey.trim().length === 0 &&
                !isLocalModelEndpoint(config.llmBaseUrl)
            ) {
                return {
                    ok: false,
                    code: "key-missing",
                    reason: `no API key is configured for ${config.llmBaseUrl} (\`JARVIS_SANDBOX_API_KEY\`)`,
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

            // An issue is read before anything is cloned: its description is
            // the task, and a number that names a pull request belongs to the
            // follow-up path instead.
            let issue: IssueSnapshot | null = null;
            if (input.issue !== undefined && input.pullRequest !== undefined) {
                return {
                    ok: false,
                    code: "issue-and-pull-request",
                    reason: "pass an issue or a pull request, not both",
                };
            }
            if (input.issue !== undefined) {
                if (issues === undefined) {
                    return {
                        ok: false,
                        code: "issue-unavailable",
                        reason: "no GitHub App is configured (`JARVIS_GITHUB_*`), so an issue cannot be read",
                    };
                }
                try {
                    issue = await issues({
                        owner: repo.owner,
                        repo: repo.name,
                        number: input.issue,
                    });
                } catch (err) {
                    return {
                        ok: false,
                        code: "issue-unavailable",
                        reason: `issue #${input.issue} could not be read: ${describe(err)}`,
                    };
                }
                if (issue.pullRequest) {
                    return {
                        ok: false,
                        code: "issue-is-pull-request",
                        reason: `#${issue.number} is a pull request`,
                    };
                }
            }

            // A follow-up is resolved before anything is cloned: the PR says
            // which branch to check out, what the reviewers asked for, and
            // whether continuing is even possible (open, same repository).
            let followUp: PullRequestSnapshot | null = null;
            if (input.pullRequest !== undefined) {
                if (pullRequests === undefined) {
                    return {
                        ok: false,
                        code: "follow-ups-unavailable",
                        reason: "no GitHub App is configured (`JARVIS_GITHUB_*`), so a pull request cannot be read",
                    };
                }
                let snapshot: PullRequestSnapshot;
                try {
                    snapshot = await pullRequests({
                        owner: repo.owner,
                        repo: repo.name,
                        number: input.pullRequest,
                    });
                } catch (err) {
                    return {
                        ok: false,
                        code: "pull-request-unavailable",
                        reason: `pull request #${input.pullRequest} could not be read: ${describe(err)}`,
                    };
                }
                if (snapshot.state !== "open") {
                    return {
                        ok: false,
                        code: "pull-request-closed",
                        reason: `pull request #${snapshot.number} is ${snapshot.state}`,
                    };
                }
                // The push targets this repository's origin. A fork's branch
                // is not there, so a job would edit a clone it cannot publish.
                const target = `${repo.owner}/${repo.name}`.toLowerCase();
                if (
                    snapshot.headRepo !== null &&
                    snapshot.headRepo.toLowerCase() !== target
                ) {
                    return {
                        ok: false,
                        code: "pull-request-fork",
                        reason: `pull request #${snapshot.number} comes from ${snapshot.headRepo}`,
                    };
                }
                followUp = snapshot;
            }

            const id = newId();
            const branch =
                followUp === null ? branchFor(task, id) : followUp.head;
            const prepared = await workspace.prepare({
                jobId: id,
                repo,
                branch,
                ...(followUp !== null ? { existing: true } : {}),
            });
            // The row records what the user asked; the container gets the
            // pull request's context as well, because an isolated clone has
            // the branch but not the conversation that shaped it.
            const prompt =
                followUp !== null
                    ? followUpPrompt(followUp, task)
                    : issue !== null
                      ? issuePrompt(issue, task)
                      : task;

            const job = ledger.createCodingJob(input.userId, {
                id,
                repo: repo.entry,
                branch,
                prompt: task,
                workspacePath: prepared.path,
                crashPolicy: input.crashPolicy ?? "prune",
                model: config.model,
                ...(followUp !== null ? { prUrl: followUp.url } : {}),
                createdAt: nowIso(),
            });

            try {
                const handle = await runner.start(
                    specFor(job, prepared, prompt),
                );
                const claimed = ledger.claimCodingJob(
                    job.id,
                    handle.containerId,
                    nowIso(),
                );
                if (claimed === null) {
                    await handle.remove();
                    throw new Error("the job was claimed by another process");
                }
                logger.info(
                    `coding job ${claimed.id} started: repo=${claimed.repo}, branch=${claimed.branch}` +
                        (issue === null ? "" : `, issue=#${issue.number}`) +
                        `, model=${config.model}, container=${handle.containerId}`,
                );
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
            // Retention first: a boot is the only moment every job is settled
            // and every container is about to be classified, so it is where
            // the disk can be given back (#141 phase 7).
            const swept = await sweepRetention();
            if (swept.workspaces.length > 0 || swept.logs.removed > 0) {
                logger.info(
                    `coding retention: removed ${swept.workspaces.length} workspace(s) and ${swept.logs.removed} log file(s) (${Math.round(swept.logs.bytes / 1024)} KiB)`,
                );
            }

            const handlers: CodingJobRecoveryHandlers = {
                resume: async (job, handle) => {
                    // Adopt and keep watching. `reconcile` returns as soon as
                    // every row is classified, so the boot is not held open by
                    // a job with an hour left on its clock.
                    logger.info(
                        `coding job ${job.id} resumed in container ${handle.containerId}`,
                    );
                    void supervise(job, handle);
                },
                fail: async (job, handle, reason) => {
                    const tail = createLogTail(LOG_TAIL_BYTES);
                    let log: JobLog | null = null;
                    if (handle !== null) {
                        // Stop first: the log stream only ends when the
                        // container does, and a prune is discarding the work
                        // anyway. The tail is what survives — and the file
                        // keeps the whole thing.
                        await handle.stop().catch(() => {});
                        log = createJobLog({
                            logRoot: config.logRoot,
                            jobId: job.id,
                            maxBytes: config.logMaxMb * 1024 * 1024,
                        });
                        try {
                            for await (const line of handle.logs()) {
                                tail.push(line);
                                log.write(line);
                                logHub.publish(job.id, line);
                            }
                        } catch {
                            // A container that cannot be read is still a
                            // container that must be removed.
                        } finally {
                            logHub.finish(job.id);
                            await log.close().catch(() => {});
                            log = null;
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
                    await announce(job, {
                        ok: false,
                        changed: false,
                        error: reason,
                        diffSummary: "",
                        lastMessage: lastAgentMessage(tail.text()),
                        prUrl: null,
                        publishError: null,
                        followUp: job.prUrl !== null,
                    });
                    pruneRows(job.userId);
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

        openLogStream(jobId: string): CodingLogStream {
            return logHub.open(jobId);
        },
    };
}

/**
 * The agent's last textual message, recovered from its JSON event stream.
 *
 * The container runs `opencode run --format json`, so its output is one JSON
 * frame per line and the agent's actual words live in `{"type":"text",
 * "part":{"text": …}}`. That message is often the only explanation a run has:
 * an agent that refuses a task exits 0 with an empty diff, and "finished" alone
 * would tell the user nothing. Scans from the end because the last message is
 * the conclusion; a line the tail cut in half is skipped rather than guessed.
 *
 * @param logTail - The job's stored output tail.
 * @returns The last non-empty text message, or `""` when there is none.
 */
export function lastAgentMessage(logTail: string): string {
    const lines = logTail.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (line === undefined || !line.startsWith("{")) {
            continue;
        }
        try {
            const frame = JSON.parse(line) as {
                type?: unknown;
                part?: { text?: unknown };
            };
            if (
                frame.type === "text" &&
                typeof frame.part?.text === "string" &&
                frame.part.text.trim().length > 0
            ) {
                return frame.part.text.trim();
            }
        } catch {
            // A truncated frame is not a message.
        }
    }
    return "";
}

/** One comment's share of a follow-up prompt. */
const MAX_COMMENT_CHARS = 1_200;

/** The whole reference context (a pull request, an issue); the task is short. */
const MAX_JOB_CONTEXT_CHARS = 12_000;

/** Indents a comment so a multi-line body stays inside its list item. */
function quote(body: string): string {
    return body
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
}

/**
 * Builds the prompt a follow-up job runs with (#140).
 *
 * The container sees a clone of the branch, not the review that asked for the
 * change; without this the agent would be guessing which comments are still
 * open. Everything here is something the user could read on GitHub — the
 * credential and the host never enter it.
 *
 * @param pull - The pull request, as read when the job started.
 * @param task - What the user wants done now.
 * @returns The prompt, bounded.
 */
export function followUpPrompt(
    pull: PullRequestSnapshot,
    task: string,
): string {
    const lines: string[] = [
        `This job continues an existing pull request (#${pull.number}): ${pull.title}`,
        pull.url,
        `Its branch \`${pull.head}\` is already checked out and targets \`${pull.base}\`.`,
        "",
        "## The original request",
        "",
        pull.body.trim() || "(the pull request has no description)",
        "",
    ];
    if (pull.comments.length > 0) {
        lines.push("## Review comments and conversation", "");
        for (const comment of pull.comments) {
            const where =
                comment.path === undefined
                    ? "conversation"
                    : `${comment.path}${
                          comment.line === undefined ? "" : `:${comment.line}`
                      }`;
            const body = comment.body.trim();
            lines.push(
                `- @${comment.author} on ${where}:`,
                quote(
                    body.length > MAX_COMMENT_CHARS
                        ? `${body.slice(0, MAX_COMMENT_CHARS - 1)}…`
                        : body,
                ),
                "",
            );
        }
        if (pull.commentsTruncated) {
            lines.push("(Only the most recent comments are shown.)", "");
        }
    }
    if (pull.conversationUnavailable) {
        lines.push(
            "(The pull request's conversation could not be read; only inline review notes are shown.)",
            "",
        );
    }
    lines.push(
        "## What this job should do",
        "",
        task.trim() || "Address the review comments above.",
        "",
    );
    const prompt = lines.join("\n");
    return prompt.length > MAX_JOB_CONTEXT_CHARS
        ? `${prompt.slice(0, MAX_JOB_CONTEXT_CHARS - 1)}…`
        : prompt;
}

/**
 * Builds the prompt for a job started from an issue (#140).
 *
 * The task comes first — it is the instruction — and the issue follows as
 * reference: title, state, labels, URL and description. Reading it on the host
 * keeps a long body out of the relay model's context and out of its hands.
 *
 * @param issue - The issue, as read when the job started.
 * @param task - What the user wants done; empty means "implement it".
 * @returns The prompt, bounded.
 */
export function issuePrompt(issue: IssueSnapshot, task: string): string {
    const body = issue.body.trim();
    const lines = [
        task.trim() || `Implement issue #${issue.number}.`,
        "",
        `## GitHub issue #${issue.number}: ${issue.title}`,
        issue.url,
        `state: ${issue.state}${
            issue.labels.length > 0
                ? `; labels: ${issue.labels.join(", ")}`
                : ""
        }`,
        "",
        body.length > MAX_JOB_CONTEXT_CHARS
            ? `${body.slice(0, MAX_JOB_CONTEXT_CHARS - 1)}…`
            : body || "(the issue has no description)",
        "",
    ];
    return lines.join("\n");
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
