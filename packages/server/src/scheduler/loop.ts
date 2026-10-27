/**
 * The scheduler's clock (#90 phase 1): when to look, and what a look covers.
 *
 * Deliberately small. The runner owns what happens to *one* job; this owns the
 * three things that are about time and process rather than about a job:
 *
 * 1. **A short scan that does not wait for runs.** A 500 ms interval scans for
 *    due work. The queue is the `jobs` table, so a restart rebuilds nothing and
 *    a scan finds whatever is due *now*. A scan only claims and launches; it
 *    does not await the runs, so a long model turn cannot stop the next scan
 *    (#217). A `message` job — a timer or a reminder, which runs no model and
 *    no tool — is never held behind `maxConcurrent`: an alarm that waits for a
 *    prompt turn is not an alarm. That bound applies to non-message runs.
 * 2. **The claim feed's bound.** One scan takes on at most `maxConcurrent`
 *    non-message jobs *in flight*, so a backlog cannot pin the process or the
 *    model. The default is 1; raising it really does run turns concurrently,
 *    against one model.
 * 3. **Boot recovery.** Any `running` row belongs to a process that died — a
 *    claim lives in memory — so the first thing a scheduler does is hand those
 *    to the runner, which fails them and says so. Otherwise a job that was
 *    mid-turn when the power went out would sit `running` forever.
 *
 * Overlapping *scans* are refused rather than queued. Runs may overlap with a
 * later scan: the atomic claim (`pending` in the WHERE clause) makes a second
 * look at the same rows a no-op, and the scan has no reason to wait for work it
 * already started.
 */
import type { AppJob, JobLedger } from "@lukestanbery/jarvis-auth";
import { logger } from "../logger";
import type { JobRunner, RunOutcome } from "./runner";

/** What one pass over the queue did, for logs and tests. */
export interface TickSummary {
    /** How many due jobs the scan found (may exceed what was taken on). */
    considered: number;
    /** What became of each job this scan took on. */
    outcomes: RunOutcome[];
    /** True when another scan was already in progress. */
    skippedTick: boolean;
}

/** The scheduler seam the process root starts and stops. */
export interface Scheduler {
    /**
     * Fails interrupted work, then scans on an interval until stopped.
     *
     * Resolves once recovery is done and the interval is running — so a caller
     * (and a test) can tell when boot-recovery has finished. Never rejects: a
     * recovery failure is logged and the loop still starts, because the rows
     * it could not settle keep their error for the next boot while due work is
     * still runnable.
     */
    start(): Promise<void>;
    /** Stops scanning. Runs already in flight finish. */
    stop(): void;
    /** One pass: take on due work (bounded), hand it to the runner. */
    tick(): Promise<TickSummary>;
    /** Fail the jobs a dead process left running. Safe to call twice. */
    recover(): Promise<number>;
}

/** Everything the loop needs; all process-level wiring. */
export interface SchedulerOptions {
    ledger: JobLedger;
    runner: JobRunner;
    /** Interval between scans (`JARVIS_JOB_TICK_MS`). */
    tickMs: number;
    /**
     * Non-message jobs allowed in flight at once (`JARVIS_JOB_MAX_PER_TICK`),
     * run together. Message jobs bypass this bound because they spend no model
     * and no tool; a timer must not wait behind a prompt turn (#217).
     */
    maxConcurrent: number;
    /** How many due jobs a scan looks at, so the query stays bounded. */
    maxPerScan?: number;
    /** Reads "now"; injectable so due-ness is testable without waiting. */
    now?: () => Date;
}

/** The widest scan a single pass makes when the caller does not say. */
const DEFAULT_MAX_PER_SCAN = 100;

/** Builds the scheduler (see the module doc for the three things it owns). */
export function createScheduler(options: SchedulerOptions): Scheduler {
    const { ledger, runner, tickMs, maxConcurrent } = options;
    const maxPerScan = Math.max(1, options.maxPerScan ?? DEFAULT_MAX_PER_SCAN);
    const now = options.now ?? (() => new Date());
    /** Whether a scan is in flight — the overlap guard, not a run guard. */
    let scanning = false;
    /** Non-message runs in flight; `maxConcurrent` bounds this, not messages. */
    let activeRuns = 0;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function recover(): Promise<number> {
        // Claims are in-memory, so every `running` row here is a run whose
        // process is gone. Fail them loudly rather than leaving them claiming
        // to be in progress.
        const interrupted = ledger.listRunningJobs(maxPerScan);
        for (const job of interrupted) {
            await runner.recover(job);
        }
        if (interrupted.length > 0) {
            logger.warn(
                `recovered ${interrupted.length} job run(s) interrupted by a restart`,
            );
        }
        return interrupted.length;
    }

    async function tick(): Promise<TickSummary> {
        if (scanning) {
            return { considered: 0, outcomes: [], skippedTick: true };
        }
        scanning = true;
        let considered = 0;
        let outcomes: RunOutcome[] = [];
        try {
            const due = ledger.listDueJobs(now().toISOString(), maxPerScan);
            considered = due.length;
            // Message jobs are the fast lane: they run no model and no tool,
            // so a timer is never queued behind an in-flight prompt turn. The
            // bound stays on the jobs that can pin the process or the model.
            let slots = Math.max(0, Math.max(1, maxConcurrent) - activeRuns);
            const taking: AppJob[] = [];
            for (const job of due) {
                if (job.kind === "message") {
                    taking.push(job);
                    continue;
                }
                if (slots <= 0) {
                    continue;
                }
                slots -= 1;
                taking.push(job);
            }
            const started: Promise<RunOutcome>[] = [];
            for (const job of taking) {
                const message = job.kind === "message";
                if (!message) {
                    activeRuns += 1;
                }
                let run: Promise<RunOutcome>;
                try {
                    run = runner.run(job);
                } catch (err) {
                    if (!message) {
                        activeRuns = Math.max(0, activeRuns - 1);
                    }
                    throw err;
                }
                if (!message) {
                    // Both outcomes release the slot. The returned promise is
                    // ignored, so handle rejection here; the original `run` is
                    // still in `started` and (for `tick`) observed below.
                    void run.then(
                        () => {
                            activeRuns = Math.max(0, activeRuns - 1);
                        },
                        () => {
                            activeRuns = Math.max(0, activeRuns - 1);
                        },
                    );
                }
                started.push(run);
            }
            // The scan itself is over here. Awaiting the runs below must not
            // keep the next scan out: a 30-second prompt turn is exactly what
            // used to delay an alarm (#217).
            scanning = false;
            outcomes = await Promise.all(started);
            if (outcomes.length > 0) {
                logger.debug(
                    `scheduler scan: ${considered} due, ${outcomes.length} taken on (${summarize(outcomes)})`,
                );
            }
            return { considered, outcomes, skippedTick: false };
        } finally {
            scanning = false;
        }
    }

    return {
        async start(): Promise<void> {
            try {
                await recover();
            } catch (err) {
                // A failed recovery must not take the queue with it: whatever is
                // due is still runnable, and the rows it could not settle keep
                // their state for the next boot rather than being forgotten.
                logger.error(
                    `scheduler recovery failed: ${err instanceof Error ? err.stack : String(err)}`,
                );
            }
            interval = setInterval(() => {
                void tick().catch((err: unknown) => {
                    // A scan must never take the process down: an unexpected
                    // failure is logged and the next interval tries again.
                    logger.error(
                        `scheduler scan failed: ${err instanceof Error ? err.stack : String(err)}`,
                    );
                });
            }, tickMs);
            // Do not hold the event loop open for a timer nobody is waiting on.
            interval.unref?.();
            logger.info(
                `Scheduler active: every ${tickMs}ms, up to ${maxConcurrent} non-message job(s) in flight; message jobs run without that bound`,
            );
        },
        stop(): void {
            if (interval !== null) {
                clearInterval(interval);
                interval = null;
            }
        },
        tick,
        recover,
    };
}

/** "done=2 failed=1" — a tick's outcomes in one line for the debug log. */
function summarize(outcomes: RunOutcome[]): string {
    const counts = new Map<string, number>();
    for (const outcome of outcomes) {
        counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
    }
    return [...counts.entries()].map(([kind, n]) => `${kind}=${n}`).join(" ");
}

/** Re-exported for the loop's callers that only need the job shape. */
export type { AppJob };
