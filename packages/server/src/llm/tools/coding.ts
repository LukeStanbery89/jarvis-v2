/**
 * The `startCodingJob` tool (#141 → #94): the agent's way to hand work to a
 * sandboxed coding agent.
 *
 * It is the thinnest possible door. Everything that decides whether a job may
 * start — the repository allowlist, the model, the concurrency cap — lives in
 * the service (`sandbox/service.ts`), because the same decisions must be
 * reachable from a future REST surface without a second opinion. This tool
 * renders those refusals in the model's voice and otherwise stays out of the
 * way; it does not wait for the job, because a coding job is minutes to hours
 * and the user is told when it ends by the notification the supervisor raises.
 *
 * **Owner-only**, deliberately (#138's smallest slice). A sandboxed agent with
 * network access and a repository clone is the most capable thing in the
 * system; until capabilities exist, the binary is "the owner may, nobody else
 * may". The check is a `deps.isOwner` injection rather than a store import so
 * the tool stays a pure function of its wiring.
 */
import { tool, type ToolRuntime } from "@langchain/core/tools";
import type { AppCodingJob } from "@lukestanbery/jarvis-auth";
import { z } from "zod";
import { parseCommentRef } from "../../github/comment";
import { logger } from "../../logger";
import type { CodingJobService } from "../../sandbox/service";
import { requireSignedInUser } from "./metering";

/** Everything the tool needs, injected at wiring time. */
export interface CodingToolDeps {
    /** The supervisor: one per process, shared with boot recovery. */
    service: CodingJobService;
    /**
     * Whether this account may start a job. The owner-only gate (#138's first
     * slice): a sandbox with a clone and network access is the most capable
     * thing JARVIS runs, so it is not a `user`-role capability yet.
     */
    isOwner(userId: number): boolean;
    /** The configured allowlist, so a refusal can name what *is* allowed. */
    repos: readonly string[];
}

/** The tool's input shape. */
const schema = z.object({
    repo: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The repository to work in, as `owner/name`. Omit it when the user did not name one and exactly one repository is allowed; the tool answers with the allowlist when it cannot choose.",
        ),
    task: z
        .string()
        .optional()
        .describe(
            "What to do, in the user's own words. The agent sees this sentence and works in a clone of the repository. Omit it when the request is simply to implement the issue named by `issue` or to address the review on `pullRequest`.",
        ),
    issue: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "Implement this GitHub issue: the job reads it and gives the agent its title, description and URL. Use it for 'implement issue #N' rather than pasting a long body into `task`. Do not also pass `pullRequest`.",
        ),
    replyTo: z
        .string()
        .min(1)
        .optional()
        .describe(
            "For a pull request, the comment to answer: the `reply-to` URL that getGitHubPullRequest prints for it. The job posts its final message as a reply in that thread (or as a quoted reply for a conversation comment).",
        ),
    // Coerced so a model that passes `165` as a number still reaches the
    // parser instead of failing validation over a type it "knew".
    pullRequest: z.coerce
        .string()
        .min(1)
        .optional()
        .describe(
            "Continue an existing pull request instead of starting a new one: its number (`165`) or its URL (`https://github.com/owner/name/pull/165`). The job checks out that PR's branch, is given its description and review comments, and pushes back to the same branch — the review updates rather than a second PR opening.",
        ),
    crashPolicy: z
        .enum(["prune", "resume"])
        .optional()
        .describe(
            "What to do if JARVIS restarts mid-job: `prune` (default) discards the container and reports a failure, `resume` adopts the still-running container and carries on. Ask the user when they might care.",
        ),
});

/** What a refusal reads like, per code. Kept exhaustive by the union. */
const REFUSAL: Record<
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
    | "issue-and-pull-request"
    | "reply-without-pull-request"
    | "broker-unreachable"
    | "egress-unsafe",
    string
> = {
    "task-missing": "A coding job needs a task; say what the agent should do.",
    "model-missing":
        "Coding jobs are configured without a model right now, so nothing can start.",
    "key-missing":
        "Coding jobs have no model API key configured, so nothing can start.",
    "repo-not-allowed":
        "That repository is not on the coding allowlist, so I did not start a job.",
    busy: "A coding job is already running; only one runs at a time. I can start this one when it finishes.",
    "follow-ups-unavailable":
        "I cannot continue a pull request because GitHub is not configured for coding jobs.",
    "pull-request-unavailable":
        "I could not read that pull request, so I did not start a job. Check its number and that the repository is allowed.",
    "pull-request-closed":
        "That pull request is already closed or merged, so there is nothing to continue.",
    "pull-request-fork":
        "That pull request comes from a fork; coding jobs can only push branches in the repository itself.",
    "issue-unavailable":
        "I could not read that issue, so I did not start a job. Check its number and that the repository is allowed.",
    "issue-is-pull-request":
        "That number is a pull request, not an issue; ask me to continue the pull request instead.",
    "issue-and-pull-request":
        "Pass either an issue or a pull request, not both.",
    "reply-without-pull-request":
        "Replying to a comment needs the pull request it belongs to; pass `pullRequest` too.",
    "broker-unreachable":
        "The coding broker is not reachable, so I did not start a job. Start the sidecar (`npm run sandbox:proxy`) and try again.",
    "egress-unsafe":
        "The coding job network is not isolated, so I did not start a job. Sidecar mode needs an internal Docker network (`JARVIS_SANDBOX_NETWORK`).",
};

/** The identity + owner gate every coding tool shares. */
function requireCodingOwner(
    deps: CodingToolDeps,
    runtime: ToolRuntime,
    logName: string,
): { ok: true; userId: number } | { ok: false; text: string } {
    const signed = requireSignedInUser(runtime, {
        subject: "Coding jobs",
        logName,
    });
    if (!signed.ok) {
        return { ok: false, text: signed.text };
    }
    if (!deps.isOwner(signed.userId)) {
        logger.warn(
            `${logName} refused: user ${signed.userId} is not an owner`,
        );
        return {
            ok: false,
            text: "Coding jobs can only be used by the owner account.",
        };
    }
    return { ok: true, userId: signed.userId };
}

/** A pull request reference: always a number, plus the repo a URL named. */
export interface PullRequestRef {
    number: number;
    /** `owner/name`, when the reference was a URL. */
    repo?: string;
}

/**
 * Reads what the model passed for `pullRequest`.
 *
 * Accepts a bare number (`165`), a `#165`, or a GitHub pull request URL. The
 * URL also names the repository, which saves the tool from asking for a repo
 * the user already gave it.
 *
 * @param value - The model's argument.
 * @returns The reference, or `null` when it is not one.
 */
export function parsePullRequestRef(value: string): PullRequestRef | null {
    const trimmed = value.trim();
    const bare = /^#?(\d+)$/.exec(trimmed);
    if (bare !== null) {
        const number = Number(bare[1]);
        return Number.isSafeInteger(number) && number > 0 ? { number } : null;
    }
    const url =
        /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
            trimmed,
        );
    if (url === null) {
        return null;
    }
    const [, owner, name, rawNumber] = url;
    const number = Number(rawNumber);
    if (
        owner === undefined ||
        name === undefined ||
        !Number.isSafeInteger(number) ||
        number <= 0
    ) {
        return null;
    }
    return { number, repo: `${owner}/${name}` };
}

/**
 * Builds the tool.
 *
 * @param deps - The service, the owner gate and the allowlist.
 * @returns The `startCodingJob` tool.
 */
export function createCodingTool(deps: CodingToolDeps) {
    return tool(
        async (
            input: z.infer<typeof schema>,
            runtime: ToolRuntime,
        ): Promise<string> => {
            const gate = requireCodingOwner(deps, runtime, "startCodingJob");
            if (!gate.ok) {
                return gate.text;
            }

            // A pull request URL names its repository; a bare number does
            // not, and falls through to the same single-entry rule as a task.
            const ref =
                input.pullRequest === undefined
                    ? null
                    : parsePullRequestRef(input.pullRequest);
            if (input.pullRequest !== undefined && ref === null) {
                return "I could not read that pull request reference; give me its number or its URL.";
            }
            const replyRef =
                input.replyTo === undefined
                    ? null
                    : parseCommentRef(input.replyTo);
            if (input.replyTo !== undefined && replyRef === null) {
                return "I could not read that comment link; pass the `reply-to` URL from getGitHubPullRequest.";
            }
            if (replyRef !== null && ref === null) {
                return REFUSAL["reply-without-pull-request"];
            }
            if (input.issue !== undefined && ref !== null) {
                return REFUSAL["issue-and-pull-request"];
            }
            // "Implement issue #140" names no task; the issue is the task.
            // The service composes the prompt from it, so the relay model
            // never has to copy a long description into an argument.
            const requested = input.task?.trim() ?? "";
            const task =
                requested.length > 0
                    ? requested
                    : input.issue !== undefined
                      ? `Implement issue #${input.issue}.`
                      : ref !== null
                        ? "Address the review comments."
                        : "";

            // "Change the primary color in the JARVIS repo" names no slug. A
            // single-entry allowlist is not ambiguity — it is the answer.
            const repo =
                input.repo !== undefined && input.repo.trim().length > 0
                    ? input.repo.trim()
                    : ref?.repo !== undefined
                      ? ref.repo
                      : deps.repos.length === 1
                        ? deps.repos[0]
                        : undefined;
            if (repo === undefined) {
                return deps.repos.length === 0
                    ? "No repository is allowed for coding jobs, so there is nowhere to work."
                    : `Which repository? Allowed: ${deps.repos.join(", ")}.`;
            }

            try {
                const result = await deps.service.start({
                    userId: gate.userId,
                    repo,
                    task,
                    ...(input.crashPolicy !== undefined
                        ? { crashPolicy: input.crashPolicy }
                        : {}),
                    ...(ref !== null ? { pullRequest: ref.number } : {}),
                    ...(replyRef !== null ? { replyTo: replyRef } : {}),
                    ...(input.issue !== undefined
                        ? { issue: input.issue }
                        : {}),
                });
                if (!result.ok) {
                    const allowed =
                        result.code === "repo-not-allowed" &&
                        deps.repos.length > 0
                            ? ` Allowed: ${deps.repos.join(", ")}. Call again with one of those, or omit \`repo\` when exactly one is allowed.`
                            : "";
                    return `${REFUSAL[result.code]}${allowed}`;
                }
                return [
                    `Started coding job ${result.job.id} in ${result.job.repo} on branch ${result.job.branch}${
                        ref !== null
                            ? ` (continuing pull request #${ref.number})`
                            : input.issue !== undefined
                              ? ` (implementing issue #${input.issue})`
                              : ""
                    }.`,
                    result.job.crashPolicy === "resume"
                        ? "If I restart mid-job it will be resumed."
                        : "If I restart mid-job it will be stopped and reported.",
                    "I will notify you when it finishes; you can keep talking to me meanwhile, and ask me for its status or to stop it at any time.",
                ].join(" ");
            } catch (err) {
                logger.error(
                    `startCodingJob failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
                );
                return "I could not start the coding job; the server log has the reason.";
            }
        },
        {
            name: "startCodingJob",
            description:
                "Start a sandboxed coding agent on an allowlisted repository. " +
                "Use when the user asks for any change to the repository's files — code, documentation, comments, configuration, or assets — or explicitly asks to start a coding job; a one-line edit still counts. " +
                "To continue an open pull request (address its review comments, revise it), pass `pullRequest`; the job works on that PR's branch and pushes back to it. " +
                "To implement a GitHub issue, pass `issue` with its number; the job reads the issue itself, so do not paste its body into the task. " +
                "It clones the repository, runs an agent in an isolated container for minutes to hours, and notifies the user when it ends. " +
                "It does not return the work itself, so do not wait for it in the reply. " +
                "`repo` may be omitted when the user did not name one and exactly one repository is allowed. " +
                "Use getCodingJob for its status, resumeCodingJob to answer questions it posts, and cancelCodingJob to stop it. " +
                "Owner-only, one job at a time.",
            schema,
        },
    );
}

/** How much of a job's stored tail a status answer quotes. */
const STATUS_TAIL_CHARS = 1500;

/** The status tool's input shape. */
const statusSchema = z.object({
    jobId: z
        .string()
        .min(1)
        .optional()
        .describe(
            "The id `startCodingJob` returned. Omit it to list what is running and what finished recently.",
        ),
});

/**
 * Renders one job as the status answer: state first, then the facts a user
 * asks for, then a bounded tail of the container's output.
 *
 * @param job - The stored row.
 * @param liveTail - The live log's tail for a running job, or `null` to use
 *   the row's settled tail.
 * @returns A multi-line answer for the model to relay.
 */
function describeJob(
    job: AppCodingJob,
    liveTail: string | null = null,
): string {
    const tail = (liveTail ?? job.logTail).trim();
    const recent =
        tail.length === 0
            ? ""
            : tail.length > STATUS_TAIL_CHARS
              ? `Recent output (tail):\n…${tail.slice(-STATUS_TAIL_CHARS)}`
              : `Recent output:\n${tail}`;
    return [
        `Coding job ${job.id} is ${job.state}.`,
        `Repository: ${job.repo}`,
        `Branch: ${job.branch}`,
        `Pull request: ${job.prUrl ?? "none"}`,
        job.model === null ? "" : `Model: ${job.model}`,
        job.issueNumber === null ? "" : `Issue: #${job.issueNumber}`,
        job.questionCommentId === null || job.issueNumber === null
            ? ""
            : `Questions: https://github.com/${job.repo}/issues/${job.issueNumber}#issuecomment-${job.questionCommentId}`,
        job.state === "awaiting-answer"
            ? "Waiting for answers: answer in the issue, or call resumeCodingJob with the answers."
            : "",
        `Started: ${job.startedAt ?? "not yet"} · finished: ${
            job.finishedAt ?? "not yet"
        }`,
        job.lastError === null ? "" : `Last error: ${job.lastError}`,
        job.diffSummary === null ? "" : `Diff: ${job.diffSummary}`,
        job.plan === null || job.plan.trim().length === 0
            ? ""
            : `Plan:\n${planPreview(job.plan)}`,
        recent,
    ]
        .filter((line) => line.length > 0)
        .join("\n");
}

/**
 * The beginning of the plan, bounded for the relay model.
 *
 * @param plan - The plan the agent wrote.
 * @returns At most {@link STATUS_TAIL_CHARS} characters.
 */
function planPreview(plan: string): string {
    const text = plan.trim();
    return text.length > STATUS_TAIL_CHARS
        ? `${text.slice(0, STATUS_TAIL_CHARS)}…`
        : text;
}

/**
 * One line for the list answer.
 *
 * @param job - The stored row.
 * @returns `id — state — repo — branch — pr`.
 */
function jobLine(job: AppCodingJob): string {
    return `${job.id} — ${job.state} — ${job.repo} — ${job.branch}${
        job.prUrl === null ? "" : ` — ${job.prUrl}`
    }`;
}

/**
 * Builds `getCodingJob`: the status/read half of the lifecycle (#141).
 *
 * Without an id it lists the caller's five newest rows, running first, so a
 * user asking "how is it going?" needs no id; with an id it returns the row's
 * facts and the tail the supervisor kept. It reads through the service, not
 * the ledger, so a future REST surface answers from the same place.
 *
 * @param deps - The service, the owner gate and the allowlist.
 * @returns The `getCodingJob` tool.
 */
export function createCodingStatusTool(deps: CodingToolDeps) {
    return tool(
        async (
            input: z.infer<typeof statusSchema>,
            runtime: ToolRuntime,
        ): Promise<string> => {
            const gate = requireCodingOwner(deps, runtime, "getCodingJob");
            if (!gate.ok) {
                return gate.text;
            }
            if (input.jobId !== undefined) {
                const job = deps.service.get(gate.userId, input.jobId);
                if (job === null) {
                    return `No coding job ${input.jobId} belongs to you.`;
                }
                // A running row's tail is only written at settle; the log file
                // is the live record. A settled row already has its tail.
                const live =
                    job.state === "running"
                        ? await deps.service.output(gate.userId, job.id)
                        : null;
                return describeJob(job, live);
            }
            const jobs = deps.service.list(gate.userId, {
                limit: 5,
                includeSettled: true,
            });
            if (jobs.length === 0) {
                return "No coding jobs are running or recently finished.";
            }
            // The store orders by creation; a user asking "what is happening"
            // cares about the live one first.
            const ordered = [...jobs].sort(
                (a, b) =>
                    Number(b.state === "running") -
                    Number(a.state === "running"),
            );
            return [
                "Coding jobs (running first, then recent):",
                ...ordered.map((job) => `- ${jobLine(job)}`),
                "",
                "Pass a job id for its full status and log tail.",
            ].join("\n");
        },
        {
            name: "getCodingJob",
            description:
                "Check a coding job's state, branch, pull request and recent output, or list what is running and recently finished. " +
                "Use it when the user asks how a job is going, whether it is done, or what it produced. " +
                "`jobId` is the id startCodingJob returned; omit it to list. Owner-only.",
            schema: statusSchema,
        },
    );
}

/** The cancel tool's input shape. */
const cancelSchema = z.object({
    jobId: z.string().min(1).describe("The id `startCodingJob` returned."),
});

/**
 * Builds `cancelCodingJob`: the interrupt half of the lifecycle (#141).
 *
 * The service settles the row `cancelled` before removing the container, so
 * the supervisor cannot later overwrite the user's decision. A missing or
 * foreign id is the same answer, and an already-settled job is a sentence
 * rather than an error.
 *
 * @param deps - The service, the owner gate and the allowlist.
 * @returns The `cancelCodingJob` tool.
 */
export function createCodingCancelTool(deps: CodingToolDeps) {
    return tool(
        async (
            input: z.infer<typeof cancelSchema>,
            runtime: ToolRuntime,
        ): Promise<string> => {
            const gate = requireCodingOwner(deps, runtime, "cancelCodingJob");
            if (!gate.ok) {
                return gate.text;
            }
            try {
                const job = await deps.service.stop(gate.userId, input.jobId);
                if (job === null) {
                    return `No coding job ${input.jobId} belongs to you.`;
                }
                return job.state === "cancelled"
                    ? `Stopped coding job ${job.id}; its container and workspace are gone.`
                    : `Coding job ${job.id} is ${job.state}; it was not running, so there was nothing to stop.`;
            } catch (err) {
                logger.error(
                    `cancelCodingJob failed: ${
                        err instanceof Error
                            ? (err.stack ?? err.message)
                            : String(err)
                    }`,
                );
                return "I could not stop that coding job; the server log has the reason.";
            }
        },
        {
            name: "cancelCodingJob",
            description:
                "Stop a running coding job and discard its container and workspace. " +
                "Use it when the user says to stop, cancel, or kill a job. " +
                "Requires the job id startCodingJob returned. Owner-only.",
            schema: cancelSchema,
        },
    );
}

/** The resume tool's input shape. */
const resumeSchema = z.object({
    jobId: z.string().min(1).describe("The id `startCodingJob` returned."),
    answers: z
        .string()
        .min(1)
        .describe(
            "The user's answers to the job's questions, in their own words. Include the question context when the job asked more than one.",
        ),
});

/**
 * Builds `resumeCodingJob`: the answer half of the SDLC loop (#94).
 *
 * The service reopens the same row and the same workspace, so the agent
 * continues in the tree it already edited. The atomic transition means the
 * chat tool and the issue poller cannot start two runs from one answer.
 *
 * @param deps - The service, the owner gate and the allowlist.
 * @returns The `resumeCodingJob` tool.
 */
export function createCodingResumeTool(deps: CodingToolDeps) {
    return tool(
        async (
            input: z.infer<typeof resumeSchema>,
            runtime: ToolRuntime,
        ): Promise<string> => {
            const gate = requireCodingOwner(deps, runtime, "resumeCodingJob");
            if (!gate.ok) {
                return gate.text;
            }
            try {
                const result = await deps.service.resume(
                    gate.userId,
                    input.jobId,
                    input.answers,
                );
                if (!result.ok) {
                    return result.reason;
                }
                return `Resumed coding job ${result.job.id} in ${result.job.repo} on branch ${result.job.branch}. I will notify you when it finishes.`;
            } catch (err) {
                logger.error(
                    `resumeCodingJob failed: ${
                        err instanceof Error
                            ? (err.stack ?? err.message)
                            : String(err)
                    }`,
                );
                return "I could not resume that coding job; the server log has the reason.";
            }
        },
        {
            name: "resumeCodingJob",
            description:
                "Continue a coding job that is waiting for answers. " +
                "Use it when the user answers the questions a job posted, or says to go ahead. " +
                "`answers` is the user's reply in their own words; `jobId` is the parked job's id. " +
                "Owner-only.",
            schema: resumeSchema,
        },
    );
}

/**
 * All four coding tools, in the order the agent should see them: start, then
 * inspect, then the answer, then the destructive one.
 *
 * @param deps - The service, the owner gate and the allowlist.
 * @returns The tools to register.
 */
export function createCodingTools(deps: CodingToolDeps) {
    return [
        createCodingTool(deps),
        createCodingStatusTool(deps),
        createCodingResumeTool(deps),
        createCodingCancelTool(deps),
    ];
}
