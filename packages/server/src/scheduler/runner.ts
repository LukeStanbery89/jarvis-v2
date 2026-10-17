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
 * Three payload kinds, and no fourth path:
 *
 * - `prompt` runs an agent turn through `runAgent` — the same seam a socket
 *   turn uses — on a thread named `job:<id>`. That thread is the job's own: it
 *   never claims a row in the chat-session ledger, so a job's runs are not
 *   conversations, but the checkpoint still gives the job memory across its
 *   own runs ("what did you try last night?").
 * - `tool` invokes one tool directly with the runtime the graph would have
 *   stamped, so the gates inside that tool (per-user quotas, ownership, quiet
 *   hours) behave exactly as they do in a chat turn.
 * - `message` runs nothing at all: the job's own text, delivered by the
 *   announcement. That is what a reminder or a timer actually is — no model
 *   call, no tool, and (since `sendNotification` is not schedulable) exactly
 *   one notification rather than two.
 *
 * The job's **class** rides along to that announcement unchanged, so quiet
 * hours are decided by the thing the user scheduled rather than by anything
 * this module invents — and a `reminder` that lands inside them does not run at
 * all: it moves itself to the moment the window closes (`deferralFor`).
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
import type { NotificationSuppression } from "../notify/types";
import {
    NOTIFY_ENABLED_PREF,
    NOTIFY_QUIET_HOURS_PREF,
    parseQuietHours,
    quietHoursEnd,
    quietHoursHold,
} from "../notify/prefs";
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
    /**
     * A reminder moved itself out of quiet hours: nothing ran, nothing was
     * announced, and the job is still `pending` at its new moment.
     */
    | { kind: "deferred"; until: string }
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
    /**
     * The jobs ledger, plus the read a deferral needs: a reminder has to know
     * whether quiet hours are in force before it runs. The auth package's
     * `AppDatabase` satisfies both halves; tests pass the same store.
     */
    ledger: JobLedger & {
        getPrefs(userId: number): Record<string, unknown>;
    };
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
                // The job's class travels with its announcement (#90 2b): a
                // timer's result must pierce quiet hours, a reminder's waits
                // (until 2b's deferral re-schedules it), and a notification's
                // simply waits to be read. The runner has no opinion of its
                // own — the class was chosen when the job was created.
                class: job.class,
                priority: "normal",
                title: clamp(job.label, MAX_NOTIFICATION_TITLE_LENGTH),
                body: clamp(text, MAX_NOTIFICATION_BODY_LENGTH),
            });
            if (outcome.suppressed === null) {
                logger.debug(
                    `job ${job.id} announced (${kind}) → delivered to ${outcome.delivered} client(s)`,
                );
            } else {
                // The default-level answer to the question a scheduled job
                // exists to raise: did the user hear about it, and if not, why?
                // Silence at `info` therefore means "delivered" — an
                // announcement that went nowhere can no longer be quiet.
                logger.info(
                    `job ${job.id} "${job.label}" recorded only (${outcome.suppressed}) — ${whyRecorded(
                        outcome.suppressed,
                        job.class,
                    )}`,
                );
            }
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
            if (job.kind === "message") {
                // Nothing to run: the text *is* the payload, and the
                // announcement below is what delivers it. This is the branch
                // that lets a reminder or a timer exist without a model call
                // and without a tool — the common case, and the one that used
                // to be modelled as a `sendNotification` tool job (which
                // announced twice).
                return { output: job.message ?? "" };
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

    /**
     * The instant a reminder defers to, or `null` when it should run now.
     *
     * **Reminders only**, which is the class decision (#90): a `timer` pierces
     * quiet hours instead of being postponed (a timer that waits until morning
     * is not a timer), and a `notification` records its announcement and waits
     * to be read. A reminder is the one class whose whole point is "at this
     * moment — but quietly if I am asleep", so it moves itself to the end of the
     * window rather than being held indefinitely.
     *
     * Prefs are read defensively: a failed read means "run it now", never
     * "defer it silently". A reminder that vanished because a read threw would
     * be exactly the unexplained silence this area exists to remove.
     *
     * **The window is read live, never copied onto the job.** What the job
     * stores is its class, and a deferral overwrites its `run_at`; so changing
     * quiet hours between scheduling and firing changes *this* decision (and a
     * deferred job re-evaluates when its new moment arrives, deferring again if
     * the window has been extended over it). The move is one-way: the original
     * moment is not retained, so clearing quiet hours cannot bring a deferred
     * reminder forward again — it runs where it was moved to.
     */
    function deferralFor(job: AppJob, at: Date): Date | null {
        if (job.class !== "reminder") {
            return null;
        }
        let prefs: Record<string, unknown>;
        try {
            prefs = ledger.getPrefs(job.userId);
        } catch (err) {
            logger.warn(
                `could not read prefs for job ${job.id}; running it now: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return null;
        }
        // The master switch is a kill switch, not a quiet hour: with
        // notifications off there is nothing to defer *for* — the announcement
        // would be recorded either way — so the job runs at its own moment and
        // its record is produced then, rather than hours late for no reason.
        if (prefs[NOTIFY_ENABLED_PREF] === false) {
            return null;
        }
        if (!quietHoursHold(prefs, job.class, at)) {
            return null;
        }
        const window = parseQuietHours(prefs[NOTIFY_QUIET_HOURS_PREF]);
        return window === null ? null : quietHoursEnd(window, at);
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
                const deferredTo = deferralFor(job, at);
                if (deferredTo !== null) {
                    // Not a claim: no attempt, no run row, no notification —
                    // just a different moment for the same pending job.
                    ledger.rescheduleJob(job.id, deferredTo.toISOString());
                    logger.info(
                        `job ${job.id} "${job.label}" deferred to ${deferredTo.toISOString()} (quiet hours)`,
                    );
                    return {
                        kind: "deferred",
                        until: deferredTo.toISOString(),
                    };
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

/**
 * The human half of a suppression reason, for the log line.
 *
 * The token alone (`quiet-hours`) is greppable but opaque to someone reading a
 * log for the first time; the prose is what makes "why didn't that appear?"
 * answerable without a debug rerun. Exhaustive over the reasons on purpose, so
 * a new one cannot be added without someone deciding how to say it.
 */
function whyRecorded(
    reason: NonNullable<NotificationSuppression>,
    jobClass: AppJob["class"],
): string {
    switch (reason) {
        case "quiet-hours":
            return `quiet hours hold a ${jobClass}`;
        case "disabled":
            return "notifications are off for this account";
        case "absent":
            return "no client was connected";
        case "cap":
            return "the delivery budget for this minute was spent";
    }
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
