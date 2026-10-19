/**
 * The two job lists (#90 phases 6c, 7): Timers at `/timers`, Reminders at
 * `/reminders`.
 *
 * They are one file because they are one list twice — the same rows, the same
 * cancellation, the same words for a moment, the same form — differing only in
 * which class they show and whether a deferral is offered (a timer is a
 * countdown: the only things to do with it are edit it and cancel it). Two files
 * would be two places for the rows to drift apart. The row itself and the form
 * lifecycle are shared with the Notifications page's scheduled section (see
 * `JobRow.tsx` and `hooks/useJobPage.ts`), so this file is the two pages that
 * differ, not the parts they have in common.
 *
 * Phase 7 gave them hands. **New** and **Edit** open the shared `JobForm` (the
 * class is the page's, so a form cannot turn a reminder into a timer), a save
 * lands the server's quiet-hours forecast in one line under the head — "it will
 * wait until 7:00 AM" is not something the user should discover by waiting — and
 * a collapsed **Recent** section carries the settled rows of that class. A
 * cancelled job is in that history on purpose: it leaves no notification record
 * anywhere else, so this is the only place a row that quietly vanished explains
 * itself.
 *
 * The rows come from the shell's `useJobs` (one list for the whole app, polled
 * while the tab is visible), so a timer that fires while the page is open leaves
 * the list within a tick — and the announcement arrives through the toast or the
 * ring, not through here.
 */
import type { ReactNode } from "react";
import {
    describeMoment,
    recentJobs,
    repeatText,
    upcomingJobs,
} from "../../jobs";
import { snoozeReminder } from "../../snooze";
import { useClock } from "../../hooks/useClock";
import { useJobPage } from "../../hooks/useJobPage";
import type { JobClass } from "../../jobs";
import type { JobsState } from "../../hooks/useJobs";
import type { NotificationsState } from "../../hooks/useNotifications";
import type { Job } from "../../api";
import { JobForm } from "./JobForm";
import { JobRow } from "./JobRow";
import { JobRuns } from "./JobRuns";

/** How many owed rows a list shows before the dashboard's glance takes over. */
const JOB_PAGE_LIMIT = 50;

/** How many settled rows the history keeps on screen. */
const RECENT_LIMIT = 8;

/** Props for {@link TimersPage} and {@link RemindersPage}. */
export interface JobsPageProps {
    /** The caller's jobs and what the pages do with them (the shell's). */
    jobs: JobsState;
    /** The notification list, so a deferral settles the row it answered. */
    notifications: NotificationsState;
    /** The device credential, for the runs a row can show (#90 phase 8f). */
    token: string;
}

/**
 * One settled job: how it ended, when it was due, and — when it went wrong —
 * why. This is the half of a job's life that no notification necessarily
 * records (a cancellation records nothing at all).
 *
 * It offers the runs too (#90 phase 8f), and for one shape of row it is the only
 * place the whole truth exists: a one-shot a gate declined ends `done` having
 * announced nothing, so the reason it produced nothing is its run history and
 * nowhere else.
 */
function RecentRow({
    job,
    now,
    token,
}: {
    job: Job;
    now: Date;
    token: string;
}) {
    return (
        <li className={`job-item job-${job.class} job-settled`}>
            <div className="job-text">
                <span className="job-eyebrow">{job.state}</span>
                <strong>{job.label}</strong>
                {job.lastError !== undefined && (
                    <span className="job-error"> {job.lastError}</span>
                )}
                {repeatText(job) !== null && (
                    <span className="job-repeat">
                        repeats {repeatText(job)}
                    </span>
                )}
                <JobRuns token={token} jobId={job.id} />
            </div>
            <div className="job-actions">
                <span className="job-when">
                    {describeMoment(job.runAt, now)}
                </span>
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
    token,
    onEdit,
}: {
    jobs: JobsState;
    notifications: NotificationsState;
    jobClass: JobClass;
    empty: string;
    token: string;
    onEdit(job: Job): void;
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
                    token={token}
                    onCancel={(id) => {
                        void jobs.cancel(id);
                    }}
                    onEdit={onEdit}
                    // A reminder is the one class a deferral applies to, and the
                    // prop's presence is how the row is told (`JobRow`).
                    onSnooze={
                        jobClass === "reminder"
                            ? (target, minutes) =>
                                  snoozeReminder(
                                      { notifications, jobs },
                                      { jobId: target.id, minutes },
                                  )
                            : undefined
                    }
                />
            ))}
        </ul>
    );
}

/**
 * The settled rows of the page's class, collapsed (#90 phase 7).
 *
 * A `<details>` rather than a permanent list: the history is what a user checks
 * after the fact, and leaving it open would push the work still owed off the
 * screen. Nothing renders when there is no history — an empty disclosure is a
 * promise of something to find.
 */
function RecentJobs({
    jobs,
    jobClass,
    token,
}: {
    jobs: JobsState;
    jobClass: JobClass;
    token: string;
}) {
    const now = useClock();
    const rows = recentJobs(jobs.settled, { limit: RECENT_LIMIT, jobClass });
    if (rows.length === 0) {
        return null;
    }
    return (
        <details className="job-history">
            <summary>Recent</summary>
            <ul className="job-list">
                {rows.map((job) => (
                    <RecentRow key={job.id} job={job} now={now} token={token} />
                ))}
            </ul>
        </details>
    );
}

/** The heading, the new-job button, and the error/status slots both pages share. */
function JobsPageFrame({
    title,
    note,
    error,
    status,
    newLabel,
    onNew,
    children,
}: {
    title: string;
    note: string;
    error: string | null;
    status: string | null;
    newLabel: string;
    onNew(): void;
    children: ReactNode;
}) {
    return (
        <main className="page">
            <header className="page-head">
                <div>
                    <h1>{title}</h1>
                    <p className="page-note">{note}</p>
                </div>
                <button type="button" className="page-new" onClick={onNew}>
                    {newLabel}
                </button>
            </header>
            {error !== null && (
                <p className="page-error" role="alert">
                    {error}
                </p>
            )}
            {status !== null && (
                <p className="page-status" role="status">
                    {status}
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
export function TimersPage({ jobs, notifications, token }: JobsPageProps) {
    const page = useJobPage();
    const count = upcomingJobs(jobs.jobs, {
        limit: JOB_PAGE_LIMIT,
        jobClass: "timer",
    }).length;
    return (
        <>
            <JobsPageFrame
                title="Timers"
                note={
                    count === 0 ? "Nothing counting down." : `${count} running`
                }
                error={jobs.error}
                status={page.note}
                newLabel="New timer"
                onNew={page.create}
            >
                <JobList
                    jobs={jobs}
                    notifications={notifications}
                    jobClass="timer"
                    empty="Set one by asking: “set a timer for ten minutes”, or here."
                    token={token}
                    onEdit={page.edit}
                />
                <RecentJobs jobs={jobs} jobClass="timer" token={token} />
            </JobsPageFrame>
            {page.form !== null && (
                <JobForm
                    jobClass="timer"
                    editing={page.form.job}
                    jobs={jobs}
                    onClose={page.close}
                    onSaved={page.saved}
                />
            )}
        </>
    );
}

/**
 * `/reminders`: what the assistant owes the caller, and when.
 *
 * @param props - See {@link JobsPageProps}.
 */
export function RemindersPage({ jobs, notifications, token }: JobsPageProps) {
    const page = useJobPage();
    const count = upcomingJobs(jobs.jobs, {
        limit: JOB_PAGE_LIMIT,
        jobClass: "reminder",
    }).length;
    return (
        <>
            <JobsPageFrame
                title="Reminders"
                note={count === 0 ? "Nothing coming up." : `${count} waiting`}
                error={jobs.error}
                status={page.note}
                newLabel="New reminder"
                onNew={page.create}
            >
                <JobList
                    jobs={jobs}
                    notifications={notifications}
                    jobClass="reminder"
                    empty="Ask for one: “remind me to change the AC filter tomorrow”, or here."
                    token={token}
                    onEdit={page.edit}
                />
                <RecentJobs jobs={jobs} jobClass="reminder" token={token} />
            </JobsPageFrame>
            {page.form !== null && (
                <JobForm
                    jobClass="reminder"
                    editing={page.form.job}
                    jobs={jobs}
                    onClose={page.close}
                    onSaved={page.saved}
                />
            )}
        </>
    );
}
