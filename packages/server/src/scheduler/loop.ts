/**
 * The scheduler's clock (#90 phase 1): when to look, and what a look covers.
 *
 * Deliberately small. The runner owns what happens to *one* job; this owns the
 * three things that are about time and process rather than about a job:
 *
 * 1. **A coarse tick.** A short interval scans for due work. Coarse rather than
 *    a timer per job because a restart has to rebuild nothing: the queue is the
 *    `jobs` table, and a scan finds whatever is due *now*, however the process
 *    got here. The cost is that a job can be up to one tick late.
 * 2. **The claim feed's bound.** One tick takes on at most `maxConcurrent`
 *    jobs, so a backlog of a hundred cannot pin the process (and its interval)
 *    for an hour. The default is 1, and the runs go through `Promise.all`:
 *    raising it really does run turns concurrently, against one model.
 * 3. **Boot recovery.** Any `running` row belongs to a process that died — a
 *    claim lives in memory — so the first thing a scheduler does is hand those
 *    to the runner, which fails them and says so. Otherwise a job that was
 *    mid-turn when the power went out would sit `running` forever.
 *
 * Overlapping ticks are refused rather than queued: a tick that is still
 * running when the next interval fires means the previous work is still in
 * flight, and the claim (`pending` in the WHERE clause) would make a second
 * pass over the same rows a no-op anyway. Skipping says so in the summary
 * instead of pretending a pass happened.
 */
import type { AppJob, JobLedger } from "@lukestanbery/jarvis-auth";
import { logger } from "../logger";
import type { JobRunner, RunOutcome } from "./runner";

/** What one pass over the queue did, for logs and tests. */
export interface TickSummary {
    /** How many due jobs the scan found (may exceed what was taken on). */
    considered: number;
    /** What became of each job this tick took on. */
    outcomes: RunOutcome[];
    /** True when the previous tick was still running, so this one did nothing. */
    skippedTick: boolean;
}

/** The scheduler seam the process root starts and stops. */
export interface Scheduler {
    /** Fails interrupted work, then ticks on an interval until stopped. */
    start(): void;
    /** Stops ticking. A tick already in flight finishes. */
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
    /** Jobs one tick takes on (`JARVIS_JOB_MAX_PER_TICK`), run together. */
    maxConcurrent: number;
    /** How many due jobs a scan looks at, so the query stays bounded. */
    maxPerScan?: number;
    /** Reads "now"; injectable so due-ness is testable without waiting. */
    now?: () => Date;
}

/** The widest scan a single tick makes when the caller does not say. */
const DEFAULT_MAX_PER_SCAN = 100;

/** Builds the scheduler (see the module doc for the four things it owns). */
export function createScheduler(options: SchedulerOptions): Scheduler {
    const { ledger, runner, tickMs, maxConcurrent } = options;
    const maxPerScan = Math.max(1, options.maxPerScan ?? DEFAULT_MAX_PER_SCAN);
    const now = options.now ?? (() => new Date());
    /** Whether a tick is in flight — the overlap guard. */
    let ticking = false;
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
        if (ticking) {
            return { considered: 0, outcomes: [], skippedTick: true };
        }
        ticking = true;
        try {
            const due = ledger.listDueJobs(now().toISOString(), maxPerScan);
            const taking = due.slice(0, Math.max(1, maxConcurrent));
            const outcomes = await Promise.all(
                taking.map((job) => runner.run(job)),
            );
            if (outcomes.length > 0) {
                logger.debug(
                    `scheduler tick: ${due.length} due, ${outcomes.length} taken on (${summarize(outcomes)})`,
                );
            }
            return { considered: due.length, outcomes, skippedTick: false };
        } finally {
            ticking = false;
        }
    }

    return {
        async start(): Promise<void> {
            await recover();
            interval = setInterval(() => {
                void tick().catch((err: unknown) => {
                    // A tick must never take the process down: an unexpected
                    // failure is logged and the next interval tries again.
                    logger.error(
                        `scheduler tick failed: ${err instanceof Error ? err.stack : String(err)}`,
                    );
                });
            }, tickMs);
            // Do not hold the event loop open for a timer nobody is waiting on.
            interval.unref?.();
            logger.info(
                `Scheduler active: every ${tickMs}ms, up to ${maxConcurrent} job(s) per tick`,
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
