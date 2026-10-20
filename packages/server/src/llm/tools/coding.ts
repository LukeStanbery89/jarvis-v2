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
import { z } from "zod";
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
        .min(1)
        .describe(
            "What to do, in the user's own words. The agent sees this sentence and works in a clone of the repository.",
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
    | "busy",
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
};

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
            const gate = requireSignedInUser(runtime, {
                subject: "Coding jobs",
                logName: "startCodingJob",
            });
            if (!gate.ok) {
                return gate.text;
            }
            if (!deps.isOwner(gate.userId)) {
                logger.warn(
                    `startCodingJob refused: user ${gate.userId} is not an owner`,
                );
                return "Coding jobs can only be started by the owner account.";
            }

            // "Change the primary color in the JARVIS repo" names no slug. A
            // single-entry allowlist is not ambiguity — it is the answer.
            const repo =
                input.repo !== undefined && input.repo.trim().length > 0
                    ? input.repo.trim()
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
                    task: input.task,
                    ...(input.crashPolicy !== undefined
                        ? { crashPolicy: input.crashPolicy }
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
                    `Started coding job ${result.job.id} in ${result.job.repo} on branch ${result.job.branch}.`,
                    result.job.crashPolicy === "resume"
                        ? "If I restart mid-job it will be resumed."
                        : "If I restart mid-job it will be stopped and reported.",
                    "I will notify you when it finishes; you can keep talking to me meanwhile.",
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
                "It clones the repository, runs an agent in an isolated container for minutes to hours, and notifies the user when it ends. " +
                "It does not return the work itself, so do not wait for it in the reply. " +
                "`repo` may be omitted when the user did not name one and exactly one repository is allowed. " +
                "Owner-only, one job at a time.",
            schema,
        },
    );
}
