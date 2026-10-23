/**
 * One owed job, as every page that lists them shows it (#90 phase 7).
 */
import type { Job } from "../../api";
import { JobCard } from "./Row/JobCard";
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
     * which is what keeps the Snooze menu off a timer and a notification.
     */
    onSnooze?(job: Job, minutes: number): void;
}

/**
 * One owed job, with the actions its state and class allow.
 */
export function JobRow({
    job,
    now,
    token,
    onCancel,
    onEdit,
    onSnooze,
}: JobRowProps) {
    const actions = (
        <div
            style={{
                display: "flex",
                gap: "0.25rem",
                alignItems: "center",
                flexWrap: "wrap",
            }}
        >
            {onSnooze !== undefined && (
                <SnoozeMenu onSnooze={(minutes) => onSnooze(job, minutes)} />
            )}
            {job.state === "pending" && (
                <button type="button" onClick={() => onEdit(job)}>
                    Edit
                </button>
            )}
            <button type="button" onClick={() => onCancel(job.id)}>
                Cancel
            </button>
            <JobRuns token={token} jobId={job.id} attempts={job.attempts} />
        </div>
    );

    return (
        <JobCard
            job={job}
            now={now}
            variant="normal"
            showKind={false}
            actions={actions}
        />
    );
}
