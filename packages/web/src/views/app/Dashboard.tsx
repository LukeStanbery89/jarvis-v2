/**
 * The dashboard at `/` (#90 phase 6b): the clock, the work coming up, and what
 * is waiting to be read.
 *
 * The clock ticks **here** rather than in the shell: a 1 Hz state change in the
 * composition root would re-render the whole app every second, and keeping the
 * tick in the leaf is the whole reason the shell exists as a boundary.
 *
 * Coming up is the same individual job widget the Timers and Reminders pages
 * use (`JobRow`), not the old compact one-line list inside a card: the dashboard
 * shows the job panes themselves, with their own actions, so a timer can be
 * edited or cancelled without leaving the front door. Everything it shows is
 * already owned by the shell (`useJobs`, the notification hook), and the edit
 * form is the shared `useJobPage`/`JobForm` pair those pages use.
 */
import { AppLink } from "../../AppLink";
import { clockParts, formatDate } from "../../clock";
import { upcomingJobs } from "../../jobs";
import { snoozeReminder } from "../../snooze";
import { useClock } from "../../hooks/useClock";
import { useJobPage } from "../../hooks/useJobPage";
import type { JobsState } from "../../hooks/useJobs";
import type { NotificationsState } from "../../hooks/useNotifications";
import { JobForm } from "./JobForm";
import { JobRow } from "./JobRow";

/** How many jobs "coming up" lists before the pages take over. */
const UPCOMING_LIMIT = 5;

/** Props for {@link Dashboard}. */
export interface DashboardProps {
    /** The signed-in account name. */
    username: string;
    /** The job list the shell already reads (see `useJobs`). */
    jobs: JobsState;
    /** The notification state, for a reminder's snooze and the unread count. */
    notifications: NotificationsState;
    /** The device credential, for each job's own runs. */
    token: string;
    /** Notifications neither read nor dismissed. */
    unread: number;
}

/**
 * The dashboard.
 *
 * @param props - See {@link DashboardProps}.
 */
export function Dashboard({
    username,
    jobs,
    notifications,
    token,
    unread,
}: DashboardProps) {
    const now = useClock();
    const page = useJobPage();
    const upcoming = upcomingJobs(jobs.jobs, { limit: UPCOMING_LIMIT });
    const at = clockParts(now);
    return (
        <main className="dashboard">
            <header className="dashboard-head">
                {/* The colon is its own span so it can blink (#90 phase 6b) —
                    the classic clock face, and the reason this is drawn from
                    `clockParts` rather than the joined string. */}
                <p className="dashboard-time">
                    {at.hour}
                    <span className="clock-colon">:</span>
                    {at.minute} {at.suffix}
                </p>
                <p className="dashboard-date">{formatDate(now)}</p>
                <p className="dashboard-account">{username}</p>
            </header>
            <section
                className="dashboard-coming"
                aria-labelledby="dashboard-upcoming"
            >
                <h2 id="dashboard-upcoming" className="page-section-head">
                    Coming up
                </h2>
                {jobs.error !== null && (
                    <p className="dashboard-error" role="alert">
                        {jobs.error}
                    </p>
                )}
                {page.note !== null && (
                    <p className="page-status" role="status">
                        {page.note}
                    </p>
                )}
                {!jobs.loaded ? (
                    <p className="dashboard-empty">Loading…</p>
                ) : upcoming.length === 0 ? (
                    <p className="dashboard-empty">Nothing scheduled.</p>
                ) : (
                    <ul className="job-list dashboard-jobs">
                        {upcoming.map((job) => (
                            <JobRow
                                key={job.id}
                                job={job}
                                now={now}
                                token={token}
                                onCancel={(id) => {
                                    void jobs.cancel(id);
                                }}
                                onEdit={page.edit}
                                onSnooze={
                                    job.class === "reminder"
                                        ? (target, minutes) =>
                                              snoozeReminder(
                                                  { notifications, jobs },
                                                  {
                                                      jobId: target.id,
                                                      minutes,
                                                  },
                                              )
                                        : undefined
                                }
                            />
                        ))}
                    </ul>
                )}
                <p className="dashboard-links">
                    <AppLink to="timers">Timers</AppLink>
                    {" · "}
                    <AppLink to="reminders">Reminders</AppLink>
                </p>
            </section>
            <div className="dashboard-widgets">
                <section
                    className="dashboard-card"
                    aria-labelledby="dashboard-unread"
                >
                    <h2 id="dashboard-unread">Notifications</h2>
                    <p className="dashboard-empty">
                        {unread === 0 ? "All caught up." : `${unread} unread`}
                    </p>
                    <p className="dashboard-links">
                        <AppLink to="notifications">Open notifications</AppLink>
                    </p>
                </section>
            </div>
            {page.form !== null && (
                <JobForm
                    jobClass={page.form.job?.class ?? "timer"}
                    editing={page.form.job}
                    jobs={jobs}
                    onClose={page.close}
                    onSaved={page.saved}
                />
            )}
        </main>
    );
}
