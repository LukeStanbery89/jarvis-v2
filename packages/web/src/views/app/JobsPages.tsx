/**
 * The two job lists (#90 phase 6c): Timers at `/timers`, Reminders at
 * `/reminders`.
 *
 * They are one file because they are one list twice — the same rows, the same
 * cancellation, the same words for a moment — differing only in which class they
 * show and whether a deferral is offered (a timer is a countdown: the only thing
 * to do with it is cancel it). Two files would be two places for the rows to
 * drift apart.
 *
 * Read-only on purpose: creating and editing are phase 7's forms, and a list that
 * works is worth more than a form that half-works. The rows come from the shell's
 * `useJobs` (one list for the whole app, polled while the tab is visible), so a
 * timer that fires while the page is open leaves the list within a tick — and the
 * announcement arrives through the toast or the ring, not through here.
 */
import { describeRunAt, upcomingJobs } from "../../jobs";
import { snoozeReminder } from "../../snooze";
import { useClock } from "../../hooks/useClock";
import type { ReactNode } from "react";
import type { JobsState } from "../../hooks/useJobs";
import type { NotificationsState } from "../../hooks/useNotifications";
import type { Job } from "../../api";
import { SnoozeMenu } from "./SnoozeMenu";

/** How many rows a list shows before the dashboard's glance takes over. */
const JOB_PAGE_LIMIT = 50;

/** Props for {@link TimersPage} and {@link RemindersPage}. */
export interface JobsPageProps {
    /** The caller's jobs and the two actions a list offers (the shell's). */
    jobs: JobsState;
    /** The notification list, so a deferral settles the row it answered. */
    notifications: NotificationsState;
}

/** Props for one row. */
interface JobRowProps {
    job: Job;
    now: Date;
    /** Whether to offer the deferral (a reminder's, not a countdown's). */
    snoozable: boolean;
    onCancel(id: string): void;
    onSnooze(job: Job, minutes: number): void;
}

/**
 * One job, with the actions it allows.
 *
 * `running now` replaces the moment while the scheduler holds the row: a countdown
 * that says "in 0 minutes" while the work is happening would be a worse answer
 * than saying so.
 */
function JobRow({ job, now, snoozable, onCancel, onSnooze }: JobRowProps) {
    return (
        <li className={`job-item job-${job.class}`}>
            <div className="job-text">
                <span className="job-eyebrow">
                    {job.class === "timer" ? "Timer" : "Reminder"}
                </span>
                <strong>{job.label}</strong>
                {job.message !== undefined && <span> {job.message}</span>}
            </div>
            <div className="job-actions">
                <span className="job-when">
                    {job.state === "running"
                        ? "running now"
                        : describeRunAt(job.runAt, now)}
                </span>
                {snoozable && (
                    <SnoozeMenu
                        onSnooze={(minutes) => onSnooze(job, minutes)}
                    />
                )}
                <button type="button" onClick={() => onCancel(job.id)}>
                    Cancel
                </button>
            </div>
        </li>
    );
}

/**
 * The rows shared by both pages: soonest first, with a note when the list is
 * empty rather than a blank space.
 */
function JobList({
    jobs,
    notifications,
    jobClass,
    empty,
}: {
    jobs: JobsState;
    notifications: NotificationsState;
    jobClass: Job["class"];
    empty: string;
}) {
    const now = useClock();
    const rows = upcomingJobs(jobs.jobs, {
        limit: JOB_PAGE_LIMIT,
        jobClass,
    });
    return (
        <ul className="job-list">
            {rows.length === 0 && <li className="job-empty">{empty}</li>}
            {rows.map((job) => (
                <JobRow
                    key={job.id}
                    job={job}
                    now={now}
                    snoozable={jobClass === "reminder"}
                    onCancel={(id) => {
                        void jobs.cancel(id);
                    }}
                    onSnooze={(target, minutes) =>
                        snoozeReminder(
                            { notifications, jobs },
                            { jobId: target.id, minutes },
                        )
                    }
                />
            ))}
        </ul>
    );
}

/** The heading and the error slot both pages share. */
function JobsPageFrame({
    title,
    note,
    error,
    children,
}: {
    title: string;
    note: string;
    error: string | null;
    children: ReactNode;
}) {
    return (
        <main className="page">
            <header className="page-head">
                <h1>{title}</h1>
                <p className="page-note">{note}</p>
            </header>
            {error !== null && (
                <p className="page-error" role="alert">
                    {error}
                </p>
            )}
            {children}
        </main>
    );
}

/**
 * `/timers`: the countdowns still running.
 *
 * @param props - See {@link JobsPageProps}.
 */
export function TimersPage({ jobs, notifications }: JobsPageProps) {
    const count = upcomingJobs(jobs.jobs, {
        limit: JOB_PAGE_LIMIT,
        jobClass: "timer",
    }).length;
    return (
        <JobsPageFrame
            title="Timers"
            note={count === 0 ? "Nothing counting down." : `${count} running`}
            error={jobs.error}
        >
            <JobList
                jobs={jobs}
                notifications={notifications}
                jobClass="timer"
                empty="Set one by asking: “set a timer for ten minutes”."
            />
        </JobsPageFrame>
    );
}

/**
 * `/reminders`: what the assistant owes the caller, and when.
 *
 * @param props - See {@link JobsPageProps}.
 */
export function RemindersPage({ jobs, notifications }: JobsPageProps) {
    const count = upcomingJobs(jobs.jobs, {
        limit: JOB_PAGE_LIMIT,
        jobClass: "reminder",
    }).length;
    return (
        <JobsPageFrame
            title="Reminders"
            note={count === 0 ? "Nothing coming up." : `${count} waiting`}
            error={jobs.error}
        >
            <JobList
                jobs={jobs}
                notifications={notifications}
                jobClass="reminder"
                empty="Ask for one: “remind me to change the AC filter tomorrow”."
            />
        </JobsPageFrame>
    );
}
