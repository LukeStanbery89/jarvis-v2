/**
 * One owed job, as every page that lists them shows it (#90 phase 7).
 *
 * It lives on its own because three surfaces render the same row: the Timers
 * page, the Reminders page, and the Notifications page's scheduled section
 * (where the notification class is managed). The row's *words* and hierarchy
 * are `JobCard`'s (`presentJob`); this file owns only what a job's state and
 * class allow — which actions, and whether a deferral is offered.
 *
 * It also carries the job's **runs** (#90 phase 8f), which is what makes a
 * frequently declining job legible: a gated firing that found nothing changed
 * announces nothing, so its `skipped` run row is the only trace it leaves. The
 * run disclosure sits in the row's text column, where it was before, so the
 * collapsed `⋯` menu holds only the buttons.
 *
 * The controls are a single `⋯` (`RowActions`) rather than a button bar, so the
 * primary fact keeps the row's width (#156) — and a class with no deferral
 * simply offers fewer menu items: `onSnooze` is present only where the class has
 * one, so its presence is the caller's statement about the class.
 */
import type { Job } from "../../api";
import { JobCard } from "./Row/JobCard";
import { RowActions } from "./Row/RowActions";
import { JobRuns } from "./JobRuns";
import { SnoozeMenu } from "./SnoozeMenu";

/** Props for {@link JobRow}. */
export interface JobRowProps {
    /** The job to render. */
    job: Job;
    /** The clock the moment is compared against (injected, for the tests). */
    now: Date;
    /** The device credential, for the job's own runs (8f). */
    token: string;
    /** Cancels the job. */
    onCancel(id: string): void;
    /** Opens the form for this job. */
    onEdit(job: Job): void;
    /**
     * Defers the job by `minutes`. Omitted for a class that cannot be deferred,
     * which is what keeps the Snooze item off a timer and a notification.
     */
    onSnooze?(job: Job, minutes: number): void;
}

/**
 * One owed job, with the actions its state and class allow.
 *
 * @param props - See {@link JobRowProps}.
 */
export function JobRow({
    job,
    now,
    token,
    onCancel,
    onEdit,
    onSnooze,
}: JobRowProps) {
    return (
        <JobCard
            job={job}
            now={now}
            actions={
                <>
                    {onSnooze !== undefined && (
                        <SnoozeMenu
                            onSnooze={(minutes) => onSnooze(job, minutes)}
                        />
                    )}
                    <RowActions
                        actions={[
                            // A running job cannot be changed, and the server
                            // says so rather than the button failing.
                            ...(job.state === "pending"
                                ? [
                                      {
                                          label: "Edit",
                                          onClick: () => onEdit(job),
                                      },
                                  ]
                                : []),
                            {
                                label: "Cancel",
                                onClick: () => onCancel(job.id),
                            },
                        ]}
                    />
                </>
            }
            runs={
                <JobRuns token={token} jobId={job.id} attempts={job.attempts} />
            }
        />
    );
}
