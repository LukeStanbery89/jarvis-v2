/**
 * One scheduled job's run (#90 phase 1): the whole life of a single job, from
 * "is this still worth doing?" to the notification that says what happened.
 *
 * The loop (`loop.ts`) decides *when* to look; this decides *what happens to
 * one job*, and it is the only place a job's outcome is settled or announced.
 * Every path through it ends in the same two records and one announcement, so
 * there is no way for a job to quietly stop existing:
 *
 * 1. a **run row** — this attempt happened, here is what it produced, or here
 *    is why it failed;
 * 2. the **job's state** — `done`/`failed`/`missed`, stamped with when;
 * 3. one **notification**, whose `kind` says which of the three it was.
 *
 * Two payload kinds, and no third path:
 *
 * - `prompt` runs an agent turn through `runAgent` — the same seam a socket
 *   turn uses — on a thread named `job:<id>`. That thread is the job's own: it
 *   never claims a row in the chat-session ledger, so a job's runs are not
 *   conversations, but the checkpoint still gives the job memory across its
 *   own runs ("what did you try last night?").
 * - `tool` invokes one tool directly with the runtime the graph would have
 *   stamped, so the gates inside that tool (per-user quotas, ownership, quiet
 *   hours) behave exactly as they do in a chat turn.
 *
 * Deliberate limits, all of them policy rather than shortcut: no retries (a
 * failed run says so, and the user re-asks); a run is bounded by the same turn
 * timeout a chat turn gets; and an announcement that fails to send does not
 * turn a completed run into a failed one — the run row is the durable half.
 */
import { randomBytes } from "node:crypto";
import type { AppJob, JobLedger } from "@lukestanbery/jarvis-auth";
import {
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
} from "@lukestanbery/jarvis-protocol";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { runAgent } from "../agent";
import { createKeyedLock } from "../keyedLock";
import { logger } from "../logger";
import type { NotificationService } from "../notify/service";
import { resolveSchedulableTool } from "./tools";

/** The agent seam, narrow enough to stub in tests (no model, no graph). */
export type JobAgentRunner = typeof runAgent;

/**
 * The thread a job's runs share.
 *
 * Namespaced rather than random so the checkpoint history of a job is findable
 * from the job, and prefixed so it can never collide with a client-chosen
 * `sessionId` in the ledger (a client's thread is claimed in `sessions`; this
 * one deliberately is not).
 */
export function jobThreadId(jobId: string): string {
    return `job:${jobId}`;
}

/**
 * What happened to one job.
 *
 * `skipped` is not a failure: it means another claimant got there first (or
 * this process already holds the job), which is the normal outcome of an
 * overlapping tick.
 */
export type RunOutcome =
    | { kind: "skipped"; reason: string }
    | { kind: "missed" }
    | { kind: "done"; output: string }
    | { kind: "failed"; error: string };

/** Runs one job and reports what happened, having recorded it either way. */
export interface JobRunner {
    /** Executes `job` if it is still owed and nobody else holds it. */
    run(job: AppJob): Promise<RunOutcome>;
    /**
     * Fails a job a dead process left `running`, closing its open run and
     * saying so. Called at boot for every claimed row.
     */
    recover(job: AppJob): Promise<RunOutcome>;
}

/** Everything the runner needs; all process-level wiring. */
export interface JobRunnerOptions {
    ledger: JobLedger;
    notifications: NotificationService;
    /** The tool instances the agent graph was built with. */
    tools: readonly StructuredToolInterface[];
    /** Bound on one scheduled turn, as for a chat turn (`JARVIS_TURN_TIMEOUT_MS`). */
    turnTimeoutMs: number;
    /** Jobs kept per user, enforced after a run — the table cannot grow free. */
    maxPerUser: number;
    /**
     * How late a job may be and still run (`JARVIS_JOB_MAX_LATENESS_MS`).
     * Beyond it the job is `missed` rather than attempted: a reminder that
     * fires six hours after the fact is not a reminder.
     */
    maxLatenessMs: number;
    /** Reads "now"; injectable so lateness and timestamps are testable. */
    now?: () => Date;
    /** Runs the turn; defaults to the real agent seam. */
    agent?: JobAgentRunner;
    /** Generates a run row's id (and the notification ids the service makes). */
    newId?: () => string;
}

/** Builds the runner (see the module doc for what it guarantees). */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
    const {
        ledger,
        notifications,
        tools,
        turnTimeoutMs,
        maxPerUser,
        maxLatenessMs,
    } = options;
    const now = options.now ?? (() => new Date());
    const agent = options.agent ?? runAgent;
    const newId =
        options.newId ?? (() => randomBytes(18).toString("base64url"));
    /** One job at a time, in this process (a second tick must not double-run). */
    const locks = createKeyedLock();

    /**
     * Announces one job outcome, best-effort.
     *
     * `kind` carries the meaning rather than the priority: which classes pierce
     * quiet hours and which defer is phase 2's policy, and inventing a priority
     * ladder here would be a second answer to a question that already has one.
     */
    async function announce(
        kind: "job.finished" | "job.failed" | "job.missed",
        job: AppJob,
        text: string,
    ): Promise<void> {
        try {
            const outcome = await notifications.notify(job.userId, {
                kind,
                priority: "normal",
                title: clamp(job.label, MAX_NOTIFICATION_TITLE_LENGTH),
                body: clamp(text, MAX_NOTIFICATION_BODY_LENGTH),
            });
            logger.debug(
                `job ${job.id} announced (${kind}): delivered=${outcome.delivered} suppressed=${String(outcome.suppressed)}`,
            );
        } catch (err) {
            // The record is the durable half: an announcement that failed must
            // not make a completed run look like a failed one.
            logger.warn(
                `could not announce job ${job.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /** Records a run's ending, settles the job, announces, prunes. */
    async function settle(
        job: AppJob,
        runId: string,
        state: "ok" | "failed",
        result: { output?: string; error?: string },
    ): Promise<RunOutcome> {
        const at = now().toISOString();
        ledger.finishJobRun(runId, state, result, at);
        ledger.settleJob(
            job.id,
            state === "ok" ? "done" : "failed",
            result.error !== undefined ? { error: result.error } : {},
            at,
        );
        await announce(
            state === "ok" ? "job.finished" : "job.failed",
            job,
            state === "ok"
                ? (result.output ?? "")
                : (result.error ?? "the run failed"),
        );
        // Retention rides on the run that just landed: a user's table cannot
        // grow without bound even though jobs are only created by a caller.
        ledger.pruneJobs(job.userId, maxPerUser);
        return state === "ok"
            ? { kind: "done", output: result.output ?? "" }
            : { kind: "failed", error: result.error ?? "the run failed" };
    }

    /**
     * Runs the job's payload, returning its output or why it failed.
     *
     * The signal is the turn timeout, composed by `AbortSignal.timeout`, so a
     * hung model cannot pin a job (and its lock) open forever — the same bound
     * a chat turn carries.
     */
    async function execute(
        job: AppJob,
        signal: AbortSignal,
    ): Promise<{ output: string } | { error: string }> {
        try {
            if (job.kind === "prompt") {
                return { output: await runPrompt(job, signal) };
            }
            const resolved = resolveSchedulableTool(tools, job.toolName ?? "");
            if (!resolved.ok) {
                return { error: resolved.reason };
            }
            const result = await resolved.tool.invoke(job.toolArgs ?? {}, {
                configurable: {
                    sessionId: jobThreadId(job.id),
                    userId: job.userId,
                },
                signal,
            });
            return {
                output:
                    typeof result === "string"
                        ? result
                        : JSON.stringify(result),
            };
        } catch (err) {
            return { error: failureText(err, signal, turnTimeoutMs) };
        }
    }

    /**
     * Runs one agent turn for a prompt job and collects the reply.
     *
     * No capabilities are declared: nobody is listening, and the output is read
     * later — in the run history and in the notification — so the turn is told
     * nothing about rendering and answers plainly.
     */
    async function runPrompt(
        job: AppJob,
        signal: AbortSignal,
    ): Promise<string> {
        let output = "";
        const stream = agent(job.prompt ?? "", jobThreadId(job.id), {
            userId: job.userId,
            signal,
        });
        for await (const event of stream) {
            if (event.type === "token") {
                output += event.text;
            }
        }
        return output;
    }

    return {
        async run(job: AppJob): Promise<RunOutcome> {
            const key = jobThreadId(job.id);
            if (!locks.tryAcquire(key)) {
                return {
                    kind: "skipped",
                    reason: "already running in this process",
                };
            }
            try {
                const at = now();
                const latenessMs = at.getTime() - Date.parse(job.runAt);
                if (latenessMs > maxLatenessMs) {
                    // Not attempted, so no claim and no run row: the honest
                    // record is "this moment passed while nobody was looking".
                    const reason = `missed by ${formatDelay(latenessMs)} — the server was not running when it was due`;
                    ledger.settleJob(
                        job.id,
                        "missed",
                        { error: reason },
                        at.toISOString(),
                    );
                    await announce("job.missed", job, reason);
                    logger.info(
                        `job ${job.id} "${job.label}" missed (${formatDelay(latenessMs)} late)`,
                    );
                    return { kind: "missed" };
                }
                if (!ledger.claimJob(job.id)) {
                    return {
                        kind: "skipped",
                        reason: "claimed by another tick",
                    };
                }
                const runId = newId();
                ledger.startJobRun({
                    id: runId,
                    jobId: job.id,
                    startedAt: at.toISOString(),
                });
                logger.info(
                    `job ${job.id} "${job.label}" running (${job.kind}, attempt ${job.attempts + 1})`,
                );
                const signal = AbortSignal.timeout(turnTimeoutMs);
                const result = await execute(job, signal);
                const outcome =
                    "error" in result
                        ? await settle(job, runId, "failed", {
                              error: result.error,
                          })
                        : await settle(job, runId, "ok", {
                              output: result.output,
                          });
                // The outcome belongs at the default level: "running" followed
                // by silence is exactly the "nothing happened" reading this
                // whole area exists to remove, and a failed job is a line an
                // operator should see without turning on debug.
                const elapsed = now().getTime() - at.getTime();
                const line = `job ${job.id} "${job.label}" ${outcome.kind} in ${elapsed}ms${
                    outcome.kind === "failed" ? `: ${outcome.error}` : ""
                }`;
                if (outcome.kind === "failed") {
                    logger.warn(line);
                } else {
                    logger.info(line);
                }
                return outcome;
            } finally {
                locks.release(key);
            }
        },

        async recover(job: AppJob): Promise<RunOutcome> {
            const at = now().toISOString();
            const reason =
                "the server restarted while this run was in progress";
            ledger.failOpenJobRuns(job.id, reason, at);
            ledger.settleJob(job.id, "failed", { error: reason }, at);
            await announce("job.failed", job, reason);
            logger.warn(
                `job ${job.id} "${job.label}" was interrupted by a restart`,
            );
            return { kind: "failed", error: reason };
        },
    };
}

/**
 * The sentence a failed run ends with.
 *
 * A timeout gets its own wording because the raw DOMException ("The operation
 * was aborted due to timeout") says nothing about what to do next, and this
 * text is what the user reads.
 */
function failureText(
    err: unknown,
    signal: AbortSignal,
    turnTimeoutMs: number,
): string {
    if (signal.aborted) {
        return `the run was still going after ${Math.round(turnTimeoutMs / 1000)}s and was stopped`;
    }
    return err instanceof Error && err.message.length > 0
        ? err.message
        : "the run failed";
}

/** Trims to `max` so an over-long reply cannot fail the notification write. */
function clamp(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "3h 20m" / "12m" / "9s" — how far past due something was. */
function formatDelay(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
