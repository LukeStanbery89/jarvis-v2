/**
 * The boot reaper (#141): reconcile the store's rows with the daemon's
 * containers.
 *
 * A coding job's claim lives in the memory of the process supervising it, so at
 * boot every `running` row belongs to a process that died. The container,
 * however, is a separate process and may still be running — which is why this
 * module exists instead of "fail everything that says running": the row and the
 * container can disagree, and each disagreement means something different.
 *
 * The full matrix, and the only policy this module implements:
 *
 * | row       | container | policy   | action                                      |
 * | --------- | --------- | -------- | ------------------------------------------- |
 * | `running` | running   | `resume` | adopt it and let the supervisor carry on    |
 * | `running` | running   | `prune`  | read its tail, remove it, record a failure  |
 * | `running` | exited    | either   | read its tail, remove it, record a failure  |
 * | `running` | absent    | either   | record a failure                            |
 * | terminal  | present   | either   | remove it — an orphan nothing owns          |
 * | missing   | present   | either   | remove it — an orphan nothing can describe  |
 *
 * Adopting a container whose process already ended would be worse than
 * pruning: `resume` means "carry on", and a stopped process cannot. So an
 * ended container is a failure under both policies, with the reason naming
 * what was actually found rather than claiming the server restarted.
 *
 * The module owns *classification*; the caller's handlers own what each class
 * means (read the logs, settle the row, announce it). That split is what lets
 * this be tested against the fake runner with no Docker and no service.
 */
import type { AppCodingJob, CodingJobLedger } from "@lukestanbery/jarvis-auth";
import { logger } from "../logger";
import type { SandboxHandle, SandboxRunner } from "./types";

/**
 * The reasons a recovered job records, exported so a test (and, later, a page)
 * reads the same sentence the reaper writes.
 */
export const RECOVERY_REASONS = {
    /** A container that was still running, under a `prune` job. */
    restarted: "the server restarted while this job was running",
    /** A row whose container cannot be found at all. */
    gone: "the job's container is gone",
    /** A container found already stopped while the row still said running. */
    stopped: "the job's container stopped while the server was down",
} as const;

/**
 * What the caller does about one recovered job.
 *
 * Two methods rather than a state machine, because the two outcomes genuinely
 * differ: `resume` continues supervising a live container, while `fail` must
 * first salvage what it can (a log tail) before removing the container and
 * settling the row.
 */
export interface CodingJobRecoveryHandlers {
    /**
     * Takes over a container that is still running. The handler is expected to
     * keep supervising it — stream its logs, wait for it, settle the row.
     */
    resume(job: AppCodingJob, handle: SandboxHandle): Promise<void>;
    /**
     * Settles a job whose run cannot continue.
     *
     * `handle` is the container when one still exists (so the handler can read
     * its tail before removing it), or `null` when it is gone.
     */
    fail(
        job: AppCodingJob,
        handle: SandboxHandle | null,
        reason: string,
    ): Promise<void>;
    /**
     * Called for a container no row owns, before it is removed.
     *
     * The container is the only source of the job id, and the workspace lives
     * at a path derived from that id — so this is the one hook that can clean
     * up the *directory* of a job whose row is already gone. Optional: a caller
     * with no workspace to manage ignores it.
     */
    discard?(jobId: string, containerId: string): Promise<void>;
}

/** What one boot-time reconciliation did, for logs and tests. */
export interface RecoverySummary {
    /** Jobs whose container was adopted and handed back to the supervisor. */
    adopted: number;
    /** Running containers removed under a `prune` job. */
    pruned: number;
    /** Jobs settled as failed (gone, stopped, or unadoptable). */
    failed: number;
    /** Orphan containers removed with no job that owns them. */
    removed: number;
    /** Handler failures, counted rather than thrown so one bad job cannot stop the boot. */
    errors: number;
}

/** How many rows and containers one boot looks at. */
const DEFAULT_RECOVERY_LIMIT = 100;

/**
 * Reconciles every container and every `running` row, once, at boot.
 *
 * Per-job failures are counted and logged rather than thrown: a boot reaper
 * that aborts on the first unreadable row would leave every later job claiming
 * to run, which is the state this module exists to clear.
 *
 * @param options - The ledger, the runner, the caller's handlers and a limit.
 * @returns What was adopted, pruned, failed and removed.
 */
export async function reconcileCodingJobs(options: {
    ledger: Pick<CodingJobLedger, "getCodingJobById" | "listRunningCodingJobs">;
    runner: SandboxRunner;
    handlers: CodingJobRecoveryHandlers;
    limit?: number;
}): Promise<RecoverySummary> {
    const { ledger, runner, handlers } = options;
    const limit = Math.max(1, options.limit ?? DEFAULT_RECOVERY_LIMIT);
    const summary: RecoverySummary = {
        adopted: 0,
        pruned: 0,
        failed: 0,
        removed: 0,
        errors: 0,
    };

    /** Job ids a container already accounted for, so the row pass skips them. */
    const seen = new Set<string>();

    for (const container of await runner.list()) {
        seen.add(container.jobId);
        const job = ledger.getCodingJobById(container.jobId);

        if (job === null || job.state !== "running") {
            // Nothing owns this container: no row, a row that already settled,
            // or a row parked on a question. It is an orphan whichever way, and
            // removing it is the only safe act — leaving it running would spend
            // resources for a result nobody will read. A parked job's workspace
            // is the *next* attempt's tree, so only its container is dropped.
            try {
                if (job === null || job.state !== "awaiting-answer") {
                    await handlers.discard?.(
                        container.jobId,
                        container.containerId,
                    );
                }
                await runner.remove(container.containerId);
                summary.removed++;
            } catch (err) {
                summary.errors++;
                logger.error(
                    `sandbox recovery: could not remove orphan container ${container.containerId}: ${describe(err)}`,
                );
            }
            continue;
        }

        try {
            if (container.running && job.crashPolicy === "resume") {
                const handle = await runner.adopt(container.containerId);
                if (handle !== null) {
                    await handlers.resume(job, handle);
                    summary.adopted++;
                    continue;
                }
                // It vanished between the listing and the adopt; the row still
                // says running, so it is a failure rather than a silent skip.
                await handlers.fail(job, null, RECOVERY_REASONS.gone);
                summary.failed++;
                continue;
            }

            // `prune`, or a container that already stopped: salvage the logs
            // (if the container still exists) and record the ending.
            const handle = await runner.adopt(container.containerId);
            await handlers.fail(
                job,
                handle,
                container.running
                    ? RECOVERY_REASONS.restarted
                    : RECOVERY_REASONS.stopped,
            );
            if (container.running) {
                summary.pruned++;
            } else {
                summary.failed++;
            }
        } catch (err) {
            summary.errors++;
            logger.error(
                `sandbox recovery: job ${job.id} could not be reconciled: ${describe(err)}`,
            );
        }
    }

    for (const job of ledger.listRunningCodingJobs(limit)) {
        if (seen.has(job.id)) {
            continue;
        }
        try {
            await handlers.fail(job, null, RECOVERY_REASONS.gone);
            summary.failed++;
        } catch (err) {
            summary.errors++;
            logger.error(
                `sandbox recovery: job ${job.id} could not be failed: ${describe(err)}`,
            );
        }
    }

    if (
        summary.adopted > 0 ||
        summary.pruned > 0 ||
        summary.failed > 0 ||
        summary.removed > 0
    ) {
        logger.warn(
            `sandbox recovery: adopted=${summary.adopted} pruned=${summary.pruned} failed=${summary.failed} removed=${summary.removed}` +
                (summary.errors > 0 ? ` errors=${summary.errors}` : ""),
        );
    }

    return summary;
}

/**
 * Renders an unknown throw for a log line.
 *
 * @param err - Whatever was caught.
 * @returns Its stack when it is an `Error`, its string form otherwise.
 */
function describe(err: unknown): string {
    return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
