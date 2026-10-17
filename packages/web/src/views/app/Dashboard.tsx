/**
 * The dashboard at `/` (#90 phase 6b): the clock, what is coming up, and what is
 * waiting to be read.
 *
 * Three widgets and no more, on purpose. The clock ticks **here** rather than in
 * the shell: a 1 Hz state change in the composition root would re-render the
 * whole app every second, and keeping the tick in the leaf is the whole reason
 * the shell exists as a boundary.
 *
 * Everything it shows is already owned by the shell (`useJobs` for the list, the
 * notification hook for the count), so this component is a reading of state and
 * two links into the pages that manage it. Create and edit forms are phase 7
 * work; this is a dashboard, not a console.
 */
import { useEffect, useState } from "react";
import { AppLink } from "../../AppLink";
import { clockParts, formatDate } from "../../clock";
import { describeRunAt, upcomingJobs } from "../../jobs";
import type { JobsState } from "../../hooks/useJobs";

/** How many jobs "coming up" lists before the pages take over. */
const UPCOMING_LIMIT = 5;

/** Props for {@link Dashboard}. */
export interface DashboardProps {
    /** The signed-in account name. */
    username: string;
    /** The job list the shell already reads (see `useJobs`). */
    jobs: JobsState;
    /** Notifications neither read nor dismissed. */
    unread: number;
}

/**
 * The current time, re-read every second.
 *
 * A leaf-only concern: nothing above this component needs to know the clock
 * moved, and nothing below it needs more than the value.
 */
function useClock(): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

/**
 * The dashboard.
 *
 * @param props - See {@link DashboardProps}.
 */
export function Dashboard({ username, jobs, unread }: DashboardProps) {
    const now = useClock();
    const upcoming = upcomingJobs(jobs.jobs, UPCOMING_LIMIT);
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
                className="dashboard-card"
                aria-labelledby="dashboard-upcoming"
            >
                <h2 id="dashboard-upcoming">Coming up</h2>
                {jobs.error !== null && (
                    <p className="dashboard-error" role="alert">
                        {jobs.error}
                    </p>
                )}
                {!jobs.loaded ? (
                    <p className="dashboard-empty">Loading…</p>
                ) : upcoming.length === 0 ? (
                    <p className="dashboard-empty">Nothing scheduled.</p>
                ) : (
                    <ul className="dashboard-jobs">
                        {upcoming.map((job) => (
                            <li key={job.id} className="dashboard-job">
                                <span
                                    className={`dashboard-class dashboard-class-${job.class}`}
                                >
                                    {job.class}
                                </span>
                                <span className="dashboard-label">
                                    {job.label}
                                </span>
                                <span className="dashboard-when">
                                    {job.state === "running"
                                        ? "running now"
                                        : describeRunAt(job.runAt, now)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <p className="dashboard-links">
                    <AppLink to="timers">Timers</AppLink>
                    {" · "}
                    <AppLink to="reminders">Reminders</AppLink>
                </p>
            </section>
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
        </main>
    );
}
