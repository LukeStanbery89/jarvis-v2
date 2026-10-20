/**
 * One owed job, as every page that lists them shows it (#90 phase 7).
 *
 * It lives on its own because three surfaces now render the same row: the
 * Timers page, the Reminders page, and the Notifications page's scheduled
 * section (where the notification class is managed). Copying it would be the
 * place the three disagreed about what a job says, how a moment reads, or which
 * actions a `running` job still allows.
 *
 * It also carries the job's **runs** (#90 phase 8f), which is what makes a
 * frequently declining job legible: a gated firing that found nothing changed
 * announces nothing, so its `skipped` run row is the only trace it leaves — and
 * before this, a job's history was reachable only from a notification it had
 * produced. A gated job says so in the row ("checks first"), because a job that
 * may never fire is a different promise from one that will.
 *
 * What the row does **not** decide is the deferral: `onSnooze` is present only
 * where the class has one — a reminder's, since a timer is a countdown and a
 * notification is already filed — so the menu's presence is the caller's
 * statement about the class rather than a second flag to keep in step.
 */
import { describeRunAt, gateText, jobBody, repeatText } from "../../jobs";
import type { Job } from "../../api";
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
 *
 * `running now` replaces the moment while the scheduler holds the row: a
 * countdown that says "in 0 minutes" while the work is happening would be a
 * worse answer than saying so. Edit is offered only while the job is still
 * `pending` — a running one cannot be changed, and the server says so rather
 * than the button failing.
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
    // The detail the row should say — never the label again (see `jobBody`).
    const body = jobBody(job);
    return (
        <li className={`job-item job-${job.class}`}>
            <div className="job-text">
                {/* What and when share the row's top line (#146 phase D): the
                    moment is a detail *of* the job, and moving it here leaves
                    the actions row to be nothing but its buttons. */}
                <div className="job-head">
                    <span className="job-eyebrow">
                        {job.class === "timer"
                            ? "Timer"
                            : job.class === "reminder"
                              ? "Reminder"
                              : "Notification"}
                    </span>
                    <span className="job-when">
                        {job.state === "running"
                            ? "running now"
                            : describeRunAt(job.runAt, now)}
                    </span>
                </div>
                <strong>{job.label}</strong>
                {body !== null && <span> {body}</span>}
                {repeatText(job) !== null && (
                    <span className="job-repeat">
                        repeats {repeatText(job)}
                    </span>
                )}
                {/* The job may not fire at all (#90 phase 8f): its gate decides,
                    and the runs show what the check read. */}
                {job.gate !== undefined && (
                    <span
                        className="job-gate"
                        title={`only runs when ${job.gate.tool} changes`}
                    >
                        {gateText(job)}
                    </span>
                )}
                <JobRuns token={token} jobId={job.id} attempts={job.attempts} />
            </div>
            <div className="job-actions">
                {onSnooze !== undefined && (
                    <SnoozeMenu
                        onSnooze={(minutes) => onSnooze(job, minutes)}
                    />
                )}
                {job.state === "pending" && (
                    <button type="button" onClick={() => onEdit(job)}>
                        Edit
                    </button>
                )}
                <button type="button" onClick={() => onCancel(job.id)}>
                    Cancel
                </button>
            </div>
        </li>
    );
}
