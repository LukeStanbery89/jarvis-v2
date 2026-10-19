/**
 * One scheduled job's run (#90 phase 1; repeating jobs in 8c): the whole life of
 * a single job, from "is this still worth doing?" to the notification that says
 * what happened.
 *
 * The loop (`loop.ts`) decides *when* to look; this decides *what happens to
 * one job*, and it is the only place a job's outcome is settled or announced.
 * Every path through it ends in the same two records — and, for a firing that
 * reached its payload, one announcement — so there is no way for a job to
 * quietly stop existing:
 *
 * 1. a **run row** — this attempt happened, here is what it produced, or here
 *    is why it failed;
 * 2. the **job's state** — `done`/`failed`/`missed`, or `pending` again when it
 *    repeats, stamped with when;
 * 3. one **notification**, whose `kind` says which of the three it was.
 *
 * **One run row per firing; exactly one announcement per _payload_ run.** A
 * firing can end without a payload in three ways, and each is shaped
 * deliberately rather than merely tolerated. A slot that passed while the server
 * was down, and an occurrence skipped by the day's model-run budget, leave **no**
 * run row: nothing was ever begun, so there is nothing to record. A firing a
 * **gate** declined (#90 phase 8f) *is* recorded — it was claimed and its check
 * was made — as `state: "skipped"` with the answer the check read, because a job
 * that declines often is legible only in its own history. None of the three
 * announces the ordinary finished/failed pair; the one exception is the budget,
 * whose single deduped notice for the day exists because a schedule starving in
 * silence is the failure this module must not become. What this module
 * guarantees is that every firing which reached its payload leaves a run row and
 * exactly one announcement.
 *
 * **A series keeps one live announcement.** Each firing's announcement carries a
 * dedupe key of the job's own id (#90 phase 9a), so the previous one is replaced
 * rather than stacked: a reminder that repeats every minute is one row in the
 * list that keeps saying the newest thing, not a thousand rows of the same
 * sentence. That is what lets a `message` series repeat at any cadence — the
 * notification-rate argument for a floor stops applying once the rows cannot
 * accumulate. A one-shot has no predecessor, so the key costs it nothing.
 *
 * **A repeating job is a job that is owed again.** When a firing settles, the
 * rule decides whether the row returns to `pending` at its next occurrence or
 * becomes terminal — in one transaction, in the ledger, so a dead process can
 * never leave a series without a successor. The next occurrence comes from the
 * *rule's* anchor and never from the moment that just fired, which is what makes
 * a snoozed or quiet-hours-deferred firing return to its own clock afterwards. A
 * series also handles two paths differently: a slot that passed while the server
 * was down moves it forward silently rather than announcing a `missed` firing,
 * and an interrupted firing re-arms instead of failing the series.
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
 * A firing may also carry a **gate** (#90 phase 8f): one read-only tool call,
 * made before any payload, whose answer is compared with the answer at the
 * previous firing. The same answer to the same question ends the firing there —
 * `skipped`, no payload, no announcement, no tokens — while a different one (or
 * no previous answer to compare, or a gate whose own identity changed) runs the
 * payload and records what the check read on that run too. A gate that *cannot*
 * be evaluated fails the firing rather than running the payload blind: "only if
 * it changed" is not a request to run regardless, so the reason it could not read
 * goes in the run and in the failure — the same shape as a tool job whose tool
 * the server no longer has.
 *
 * The job's **class** rides along to that announcement unchanged, so quiet
 * hours are decided by the thing the user scheduled rather than by anything
 * this module invents — and a `reminder` that lands inside them does not run at
 * all: it moves itself to the moment the window closes (`deferralFor`).
 *
 * Deliberate limits, all of them policy rather than shortcut: no retries (a
 * failed run says so and the user re-asks — for a series, the next occurrence
 * *is* the retry, which is why re-arming does not wait for success); a run is
 * bounded by the same turn timeout a chat turn gets; and an announcement that
 * fails to send does not turn a completed run into a failed one — the run row is
 * the durable half.
 */
import { randomBytes } from "node:crypto";
import type { AppJob, AppJobRun, JobLedger } from "@lukestanbery/jarvis-auth";
import {
    gateKey,
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
    nextOccurrence,
    parseJobGate,
    parseJobRepeat,
    repeatExhausted,
} from "@lukestanbery/jarvis-protocol";
import type { JobGate, JobRepeat } from "@lukestanbery/jarvis-protocol";
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
import { resolveGateTool, resolveSchedulableTool } from "./tools";

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
 * overlapping tick — nothing was begun, so nothing was recorded.
 *
 * `declined` is the gate's outcome (#90 phase 8f) and is *not* the same thing:
 * the firing was claimed and recorded (`state: "skipped"`), and its check found
 * nothing changed, so no payload ran and nothing was announced. It is a separate
 * kind so that a caller counting "jobs the scheduler did not get to" cannot
 * confuse a decision the job made with a tick that overlapped.
 */
export type RunOutcome =
    | { kind: "skipped"; reason: string }
    | { kind: "declined"; reason: string }
    /**
     * A reminder moved itself out of quiet hours: nothing ran, nothing was
     * announced, and the job is still `pending` at its new moment.
     */
    | { kind: "deferred"; until: string }
    | { kind: "missed" }
    | { kind: "done"; output: string }
    | { kind: "failed"; error: string };

/**
 * What a gate's check observed (#90 phase 8f).
 *
 * `key` is the *question* (see `gateKey`), carried beside the answer because the
 * two are compared together: a gate that was edited asks something new, and an
 * answer to the old question is not evidence about the new one.
 */
interface GateObservation {
    /** The tool's result, as the payload path would have rendered it. */
    output: string;
    /** The check's identity: its tool and arguments, as one string. */
    key: string;
}

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
    /**
     * Model-calling runs one account may spend in a local day (#90 phase 8c).
     *
     * The budget that makes a repeating `prompt` job safe to offer: it is
     * counted in the ledger, so a restart cannot hand the day back, and only a
     * firing that reached the model spends it.
     */
    modelRunsPerDay: number;
    /**
     * How many of a job's runs to keep (defaults to the ledger's own 50).
     *
     * An option rather than a config knob: the scheduler's tests need a small
     * number to exercise the trim, and nobody else has a reason to change it.
     */
    runsToKeep?: number;
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
        modelRunsPerDay,
    } = options;
    const runsToKeep = options.runsToKeep;
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
        options: { dedupeKey?: string } = {},
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
                // The job this announcement is about (#90 phase 5). Stored so a
                // reminder's banner can offer *snooze* rather than only
                // *dismiss* — the client would otherwise have to guess which
                // job a row came from.
                jobId: job.id,
                // Only the budget notice uses this: an occurrence skipped for
                // the day's allowance supersedes that day's earlier notice
                // rather than stacking one per firing.
                ...(options.dedupeKey !== undefined
                    ? { dedupeKey: options.dedupeKey }
                    : {}),
                // A message job's text is often the label itself ("Call Mum",
                // with no detail to add). Passing it as the body would render
                // the same line twice in the banner, so a message that is only
                // the headline is sent as one.
                ...(text === job.label
                    ? {}
                    : { body: clamp(text, MAX_NOTIFICATION_BODY_LENGTH) }),
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

    /**
     * The job's rule, or `null` for a one-shot (#90 phase 8c).
     *
     * An unreadable rule is *reported and then treated as a one-shot*: the job
     * fires once, settles, and the warning says why. The alternatives are worse
     * in both directions — a series that silently never fires again, or one that
     * throws on every tick — and the row still holds the text, so it can be
     * inspected where it was written.
     */
    function repeatOf(job: AppJob): JobRepeat | null {
        if (job.repeat === null || job.repeat === undefined) {
            return null;
        }
        const parsed = parseJobRepeat(job.repeat);
        if (!parsed.ok) {
            logger.warn(
                `job ${job.id} has an unreadable repeat rule (${parsed.reason}); treating it as a one-shot`,
            );
            return null;
        }
        return parsed.repeat;
    }

    /**
     * The job's gate, or `null` for a job that runs unconditionally (#90 phase 8f).
     *
     * A *structurally* unreadable gate is reported and treated as absent, exactly
     * as {@link repeatOf} treats an unreadable rule: the row still holds the text
     * for inspection, and running the job the user asked for beats refusing every
     * firing forever. A gate that is well-formed but **cannot be evaluated here**
     * is a different case, and fails its firing instead — see {@link checkGate}.
     */
    function gateOf(job: AppJob): JobGate | null {
        if (job.gate === null || job.gate === undefined) {
            return null;
        }
        const parsed = parseJobGate(job.gate);
        if (!parsed.ok) {
            logger.warn(
                `job ${job.id} has an unreadable gate (${parsed.reason}); running without a check`,
            );
            return null;
        }
        return parsed.gate;
    }

    /**
     * Whether this firing's read says nothing has changed since the last one.
     *
     * Three things have to line up: there was a previous firing, it recorded an
     * answer, and it asked the *same* question. Any of them missing means the
     * payload runs — the direction that keeps a job from skipping forever against
     * a baseline it never had (a job whose gate was just added, or one whose runs
     * the retention trim has aged out). The comparison is the check's **text**,
     * which is why a gate's action must render stably while nothing changes: a
     * volatile read would answer "different" on every poll.
     */
    function gateDeclined(
        observed: GateObservation,
        previous: AppJobRun | null,
    ): boolean {
        return (
            previous !== null &&
            previous.gateKey === observed.key &&
            previous.gateOutput === observed.output
        );
    }

    /**
     * Makes the gate's read, returning what it saw or why it could not.
     *
     * Two refusals live here rather than at creation, because a stored tool call
     * is a durable capability and this server's configuration can change between
     * the two: the tool may be gone at 3am, and the action it names must still be
     * one that only reads. Both are returned as text rather than thrown, so they
     * land in the run row and in the failure the user is told about — the same
     * treatment a tool job gets when its target has vanished.
     */
    async function checkGate(
        job: AppJob,
        gate: JobGate,
        signal: AbortSignal,
    ): Promise<{ observation: GateObservation } | { error: string }> {
        const resolved = resolveGateTool(tools, gate);
        if (!resolved.ok) {
            return { error: resolved.reason };
        }
        try {
            const result = await resolved.tool.invoke(gate.args, {
                configurable: {
                    sessionId: jobThreadId(job.id),
                    userId: job.userId,
                },
                signal,
            });
            return {
                observation: {
                    output:
                        typeof result === "string"
                            ? result
                            : JSON.stringify(result),
                    key: gateKey(gate),
                },
            };
        } catch (err) {
            return { error: failureText(err, signal, turnTimeoutMs) };
        }
    }

    /**
     * When a series fires next, or `null` when the firing in hand was its last.
     *
     * `attempts` is the count the decision is made against, and the callers
     * differ on purpose. A run that was *claimed* counts (the count including
     * this firing), because claiming is what a firing is; a slot that was skipped
     * does not — which is the whole meaning of `ends.after`: it counts firings,
     * so a schedule that lost a day to an outage spans more calendar time than
     * its count suggests.
     *
     * `rule` lets a caller that already parsed the job's rule hand it over —
     * `settle` needs the same answer to decide whether the firing belongs to a
     * series, and parsing twice would warn twice about an unreadable one.
     */
    function nextFiring(
        job: AppJob,
        at: Date,
        attempts: number,
        rule: JobRepeat | null = repeatOf(job),
    ): string | null {
        if (rule === null) {
            return null;
        }
        if (repeatExhausted(rule, attempts)) {
            logger.info(
                `job ${job.id} "${job.label}" has run as many times as it was asked to`,
            );
            return null;
        }
        const next = nextOccurrence(rule, at);
        if (!next.ok) {
            if (next.reason === "never") {
                logger.warn(
                    `job ${job.id} "${job.label}" has a rule that will never come round again`,
                );
            }
            return null;
        }
        return next.at.toISOString();
    }

    /**
     * The local calendar day a budget counts against.
     *
     * Local, not UTC: "200 runs today" is a person's day, and it should turn over
     * when theirs does.
     */
    function localDay(at: Date): string {
        const pad = (value: number) => String(value).padStart(2, "0");
        return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    }

    /**
     * Skips one firing because its account has spent the day's model-run budget.
     *
     * A one-shot is settled `missed` with the reason: its moment passed and it
     * was not attempted, which is exactly what that state means. A series moves
     * to its next occurrence instead — the occurrence is lost, not the series —
     * and says so **once a day**, deduped, because a schedule that starves in
     * silence is the failure this budget must not become.
     */
    async function skipForBudget(
        job: AppJob,
        at: Date,
        day: string,
    ): Promise<RunOutcome> {
        const reason = `the daily budget of ${modelRunsPerDay} model-calling runs is spent, so "${job.label}" did not run`;
        const next = nextFiring(job, at, job.attempts);
        if (next !== null) {
            // Nothing was claimed and nothing was attempted, so the row is still
            // `pending`: the same shape as a quiet-hours deferral.
            ledger.rescheduleJob(job.id, next);
            await announce("job.missed", job, reason, {
                dedupeKey: `job-budget:${job.userId}:${day}`,
            });
            logger.warn(
                `job ${job.id} "${job.label}" skipped (daily model-run budget spent); next ${next}`,
            );
            return { kind: "deferred", until: next };
        }
        ledger.settleJob(job.id, "missed", { error: reason }, at.toISOString());
        await announce("job.missed", job, reason);
        logger.warn(
            `job ${job.id} "${job.label}" missed (daily model-run budget spent)`,
        );
        return { kind: "missed" };
    }

    /**
     * The dedupe key a series' announcements share (#90 phase 9a).
     *
     * One key per job, so each firing replaces the one before it. The budget
     * notice deliberately uses a different key (`job-budget:<user>:<day>`): a
     * firing that did not happen must not erase the last one that did.
     */
    function seriesKey(job: AppJob): string {
        return `job:${job.id}`;
    }

    /**
     * Records a run's ending, settles the job, announces, prunes.
     *
     * `observed` is the gate's answer, when the job has one: it is written on
     * **every** gated firing, not only on the declined ones, because the
     * comparison reads the newest run — a payload run that recorded nothing would
     * reset the baseline and every other firing would run.
     */
    async function settle(
        job: AppJob,
        runId: string,
        state: "ok" | "failed",
        result: { output?: string; error?: string },
        observed: GateObservation | null = null,
    ): Promise<RunOutcome> {
        const at = now();
        // Parsed once: the rule decides both whether this job is owed again and
        // whether its announcement replaces a predecessor (#90 phase 9a).
        const rule = repeatOf(job);
        // A repeating job is owed again unless this firing was its last: the
        // claim counted it, so `ends.after` is decided against the count
        // including it.
        const next = nextFiring(job, at, job.attempts + 1, rule);
        ledger.settleJobRun({
            jobId: job.id,
            runId,
            run: {
                state,
                ...result,
                ...(observed !== null
                    ? { gateOutput: observed.output, gateKey: observed.key }
                    : {}),
            },
            job:
                next === null
                    ? {
                          state: state === "ok" ? "done" : "failed",
                          ...(result.error !== undefined
                              ? { error: result.error }
                              : {}),
                      }
                    : {
                          state: "pending",
                          runAt: next,
                          ...(result.error !== undefined
                              ? { error: result.error }
                              : {}),
                      },
            at: at.toISOString(),
        });
        await announce(
            state === "ok" ? "job.finished" : "job.failed",
            job,
            state === "ok"
                ? (result.output ?? "")
                : (result.error ?? "the run failed"),
            // A series keeps one live announcement: this firing's replaces the
            // one before it, so a minutely reminder is one row rather than a
            // thousand. A one-shot has nothing to replace, and the key is inert.
            rule !== null ? { dedupeKey: seriesKey(job) } : {},
        );
        if (next !== null) {
            logger.info(
                `job ${job.id} "${job.label}" repeats at ${next} (attempt ${job.attempts + 1})`,
            );
        }
        // Retention rides on the run that just landed: a user's table cannot
        // grow without bound even though jobs are only created by a caller — and
        // a series' runs are its own history, so they are trimmed with it.
        ledger.pruneJobs(job.userId, maxPerUser);
        ledger.pruneJobRuns(job.id, runsToKeep);
        return state === "ok"
            ? { kind: "done", output: result.output ?? "" }
            : { kind: "failed", error: result.error ?? "the run failed" };
    }

    /**
     * Records a firing a gate declined, and moves its job forward (#90 8f).
     *
     * The run row is the record — `skipped`, with what the check read and which
     * check read it — so the next firing has a baseline and the history says why
     * nothing happened. Nothing is announced: the user asked to hear about this
     * job when something *changed*, and nothing did. A one-shot ends `done` rather
     * than `missed`, because its one firing did happen; it is the run row that
     * carries the reason it produced nothing.
     *
     * The firing counts toward `ends.after`, because being claimed is what a
     * firing *is* here — the rule counts firings, not payloads.
     */
    async function settleDeclined(
        job: AppJob,
        runId: string,
        observed: GateObservation,
    ): Promise<RunOutcome> {
        const at = now();
        const next = nextFiring(job, at, job.attempts + 1);
        ledger.settleJobRun({
            jobId: job.id,
            runId,
            run: {
                state: "skipped",
                gateOutput: observed.output,
                gateKey: observed.key,
            },
            job:
                next === null
                    ? { state: "done" }
                    : { state: "pending", runAt: next },
            at: at.toISOString(),
        });
        if (next !== null) {
            logger.info(
                `job ${job.id} "${job.label}" declined (the check found nothing changed); next ${next}`,
            );
        } else {
            logger.info(
                `job ${job.id} "${job.label}" declined (the check found nothing changed); nothing left to run`,
            );
        }
        ledger.pruneJobs(job.userId, maxPerUser);
        ledger.pruneJobRuns(job.id, runsToKeep);
        return { kind: "declined", reason: "the check found nothing changed" };
    }

    /**
     * The default-level line for one firing that reached its payload.
     *
     * "Running" followed by silence is exactly the "nothing happened" reading
     * this whole area exists to remove, and a failed job is a line an operator
     * should see without turning on debug. A decline logs its own line in
     * {@link settleDeclined} instead — it is a decision, not an attempt.
     */
    function report(
        job: AppJob,
        startedAt: Date,
        outcome: RunOutcome,
    ): RunOutcome {
        const elapsed = now().getTime() - startedAt.getTime();
        const line = `job ${job.id} "${job.label}" ${outcome.kind} in ${elapsed}ms${
            outcome.kind === "failed" ? `: ${outcome.error}` : ""
        }`;
        if (outcome.kind === "failed") {
            logger.warn(line);
        } else {
            logger.info(line);
        }
        return outcome;
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
                    // A series is not over because one of its slots passed: it
                    // moves to its next occurrence, silently — nothing was ever
                    // promised for a moment nobody saw — and only a series with
                    // no occurrences left is settled `missed`. The slot does not
                    // count as a firing, so `ends.after` is measured without it.
                    const next = nextFiring(job, at, job.attempts);
                    if (next !== null) {
                        ledger.rescheduleJob(job.id, next);
                        logger.info(
                            `job ${job.id} "${job.label}" missed its slot (${formatDelay(latenessMs)} late); next ${next}`,
                        );
                        return { kind: "deferred", until: next };
                    }
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
                if (job.kind === "prompt") {
                    // The one payload that spends the model. Checked before the
                    // claim, so a budget skip leaves the row pending — no
                    // attempt, no run row — and the account's other work (a
                    // timer, a tool job) is untouched.
                    const day = localDay(at);
                    if (
                        ledger.countModelRuns(job.userId, day) >=
                        modelRunsPerDay
                    ) {
                        return await skipForBudget(job, at, day);
                    }
                }
                if (!ledger.claimJob(job.id)) {
                    return {
                        kind: "skipped",
                        reason: "claimed by another tick",
                    };
                }
                // The gate compares against the **previous** firing, so the
                // baseline is read before this one records its own start:
                // `listJobRuns` is newest-first, so the newest row at this
                // instant is the last firing that finished.
                const previousRun =
                    ledger.listJobRuns(job.id, { limit: 1 })[0] ?? null;
                const runId = newId();
                ledger.startJobRun({
                    id: runId,
                    jobId: job.id,
                    startedAt: at.toISOString(),
                });
                const signal = AbortSignal.timeout(turnTimeoutMs);
                const gate = gateOf(job);
                let observed: GateObservation | null = null;
                let gateError: string | null = null;
                if (gate !== null) {
                    const check = await checkGate(job, gate, signal);
                    if ("error" in check) {
                        // The condition this job was created under cannot be
                        // evaluated, so its payload does not run: "only if it
                        // changed" is not a request to run regardless. The
                        // reason is what the run row and the failure both say.
                        gateError = check.error;
                    } else if (gateDeclined(check.observation, previousRun)) {
                        return await settleDeclined(
                            job,
                            runId,
                            check.observation,
                        );
                    } else {
                        observed = check.observation;
                    }
                }
                let payloadRan = false;
                let result: { output: string } | { error: string };
                if (gateError !== null) {
                    result = { error: gateError };
                } else {
                    logger.info(
                        `job ${job.id} "${job.label}" running (${job.kind}, attempt ${job.attempts + 1})`,
                    );
                    result = await execute(job, signal);
                    payloadRan = true;
                }
                // Only a prompt reaches the model, and only when its payload
                // actually ran — a tool or message job spends nothing, and
                // neither does a firing a gate declined or one whose gate could
                // not read.
                if (job.kind === "prompt" && payloadRan) {
                    ledger.recordModelRun(job.userId, localDay(at));
                }
                const outcome =
                    "error" in result
                        ? await settle(
                              job,
                              runId,
                              "failed",
                              {
                                  error: result.error,
                              },
                              observed,
                          )
                        : await settle(
                              job,
                              runId,
                              "ok",
                              {
                                  output: result.output,
                              },
                              observed,
                          );
                return report(job, at, outcome);
            } finally {
                locks.release(key);
            }
        },

        async recover(job: AppJob): Promise<RunOutcome> {
            const at = now();
            const reason =
                "the server restarted while this run was in progress";
            // The attempt is closed as `failed` either way: the process that
            // made it died mid-run, and that is what happened to *it*. What
            // differs for a series is the job: it is owed again at its next
            // occurrence, because one interrupted firing does not end a
            // schedule. The firing did claim the job, so it counts toward
            // `ends.after`. A re-arm cannot resurrect a job the user cancelled
            // mid-run: the row is `cancelled` by then, and `rearmJob` requires
            // `running`.
            const next = nextFiring(job, at, job.attempts);
            ledger.failOpenJobRuns(job.id, reason, at.toISOString());
            if (next !== null) {
                ledger.rearmJob(job.id, next);
                logger.warn(
                    `job ${job.id} "${job.label}" was interrupted by a restart; the series continues at ${next}`,
                );
                return { kind: "failed", error: reason };
            }
            ledger.settleJob(
                job.id,
                "failed",
                { error: reason },
                at.toISOString(),
            );
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
