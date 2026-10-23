/**
 * The notifications page (#90 phases 6c, 7): the notification class, whole.
 *
 * Two halves, because the class has two halves in time. **Scheduled** is work of
 * this class that has not arrived yet — the model's `scheduleTask` jobs and any
 * note written here by hand. **Recorded** is everything the server has filed,
 * with the actions each row allows: mark read, dismiss, snooze. A thing that is
 * scheduled stops being scheduled when it fires and becomes a record, so the
 * same item never shows in both lists.
 *
 * Both halves render through the shared presentation components (#156): the
 * scheduled rows through `JobRow`/`JobCard` (the same row the Timers and
 * Reminders pages use) and the records through `NotificationCard`, so a
 * notification says the same thing here as it does in the toast. The page keeps
 * the list-page chrome (`page page-rows`), which is where its gutters and
 * centred measure come from.
 *
 * "Snoozed until 7:00 PM" is assembled from the row **and its job**
 * (`snoozeUntil`): the notification records the deferral, the job holds the
 * moment, and the link between them is the reason `jobId` exists. A row whose job
 * has since been pruned says plain "snoozed" — the honest half of the truth, not a
 * guess at a time.
 *
 * State and I/O are the shell's (`useNotifications`, `useJobs`); this is a reading
 * of them, plus the form every job page opens (`useJobPage`, `JobForm`) and the
 * run disclosure a record can open (`JobRuns`, reading through its `jobId`). The
 * class here is fixed — `notification` — because a page that could write any of
 * the three would be a way to turn a reminder into a timer.
 */
import { debugEnabled } from "../../debug";
import { describeSnooze, snoozeUntil, upcomingJobs } from "../../jobs";
import { snoozeReminder, snoozeRequestFor } from "../../snooze";
import { useClock } from "../../hooks/useClock";
import { useJobPage } from "../../hooks/useJobPage";
import {
    describeDelivery,
    describeNotificationState,
    isSettled,
} from "../../notifications";
import type { ClientNotification } from "../../notifications";
import type { JobsState } from "../../hooks/useJobs";
import type { NotificationsState } from "../../hooks/useNotifications";
import { JobForm } from "./JobForm";
import { JobRow } from "./JobRow";
import { JobRuns } from "./JobRuns";
import { SnoozeMenu } from "./SnoozeMenu";
import { NotificationCard } from "./Row/NotificationCard";
import { RowActions } from "./Row/RowActions";

/** How many scheduled rows the section shows (the dashboard is the glance). */
const SCHEDULED_LIMIT = 50;

/** Props for {@link NotificationsPage}. */
export interface NotificationsPageProps {
    /** The notification list and its actions (the shell's). */
    notifications: NotificationsState;
    /** The caller's jobs: the scheduled half, and what a snoozed row's moment
     * is read from. */
    jobs: JobsState;
    /** The device credential, for the runs a recorded row can show (7d). */
    token: string;
}

/** Props for one row. */
interface NotificationRowProps {
    item: ClientNotification;
    jobs: JobsState;
    now: Date;
    /** The device credential, for the run disclosure. */
    token: string;
    onMarkRead(id: string): void;
    onDismiss(id: string): void;
    onSnooze(item: ClientNotification, minutes: number): void;
}

/**
 * One notification, with the actions its state and class allow.
 *
 * A settled row offers nothing but its runs: read, answered, dismissed and
 * snoozed are final, and offering an action the server would refuse is worse
 * than offering none. The actions live behind a `⋯` (`RowActions`), so the
 * message keeps the row's width; a reminder's deferral keeps its own menu,
 * because it is a choice of offset rather than a single action.
 */
function NotificationRow({
    item,
    jobs,
    now,
    token,
    onMarkRead,
    onDismiss,
    onSnooze,
}: NotificationRowProps) {
    const settled = isSettled(item.state);
    // The state column holds a sentence for a snoozed row, because "snoozed"
    // alone is the half of it the user did not ask about.
    const state =
        item.state === "snoozed"
            ? describeSnooze(snoozeUntil(item.jobId, jobs.jobs), now)
            : describeNotificationState(item.state);

    return (
        <NotificationCard
            notification={item}
            now={now}
            state={state}
            runs={
                item.jobId !== undefined ? (
                    <JobRuns token={token} jobId={item.jobId} />
                ) : undefined
            }
            actions={
                <>
                    {!settled &&
                        item.class === "reminder" &&
                        item.jobId !== undefined && (
                            <SnoozeMenu
                                onSnooze={(minutes) => onSnooze(item, minutes)}
                            />
                        )}
                    <RowActions
                        actions={
                            settled
                                ? []
                                : [
                                      {
                                          label: "Mark read",
                                          onClick: () => onMarkRead(item.id),
                                      },
                                      {
                                          label: "Dismiss",
                                          onClick: () => onDismiss(item.id),
                                      },
                                  ]
                        }
                    />
                </>
            }
        />
    );
}

/**
 * The recorded half: everything the server has filed, in the order it sent it.
 *
 * One component rather than two copies, because the list is the same whether or
 * not the scheduled half is showing a heading above it.
 */
function RecordedList({
    notifications,
    jobs,
    now,
    token,
    onSnooze,
}: {
    notifications: NotificationsState;
    jobs: JobsState;
    now: Date;
    token: string;
    onSnooze(item: ClientNotification, minutes: number): void;
}) {
    return (
        <ul className="notification-list">
            {notifications.notifications.length === 0 && (
                <li className="notification-empty">Nothing to report.</li>
            )}
            {notifications.notifications.map((item) => (
                <NotificationRow
                    key={item.id}
                    item={item}
                    jobs={jobs}
                    now={now}
                    token={token}
                    onMarkRead={notifications.markRead}
                    onDismiss={notifications.dismiss}
                    onSnooze={onSnooze}
                />
            ))}
        </ul>
    );
}

/**
 * The notifications page.
 *
 * @param props - See {@link NotificationsPageProps}.
 */
export function NotificationsPage({
    notifications,
    jobs,
    token,
}: NotificationsPageProps) {
    const now = useClock();
    const page = useJobPage();
    // Development only, and gated on the debug flag as well: a shipped bundle
    // carries neither the branch nor the button (Vite folds `import.meta.env.DEV`
    // to `false`), because a real producer exists to exercise the channel.
    const showTest = import.meta.env.DEV && debugEnabled();
    const { lastTest } = notifications;

    // The class this page owns, still owed: the model's scheduled tasks and any
    // note written here. Sorted by moment, like the job pages' lists.
    const scheduled = upcomingJobs(jobs.jobs, {
        limit: SCHEDULED_LIMIT,
        jobClass: "notification",
    });

    /**
     * Snoozes the reminder a row came from (#90 phase 6c).
     *
     * The join lives in `snoozeReminder` because the toast offers the same action:
     * one request settles both halves, and the row is only settled locally once
     * that reported success.
     */
    function snooze(item: ClientNotification, minutes: number): void {
        const request = snoozeRequestFor(item, minutes);
        if (request !== null) {
            snoozeReminder({ notifications, jobs }, request);
        }
    }

    return (
        <>
            <main className="page page-rows">
                <header className="page-head">
                    <div>
                        <h1>Notifications</h1>
                        <p className="page-note">
                            {notifications.unread === 0
                                ? "Nothing waiting to be read."
                                : `${notifications.unread} unread`}
                            {scheduled.length > 0 &&
                                ` · ${scheduled.length} scheduled`}
                            {notifications.loading ? " · loading…" : ""}
                        </p>
                    </div>
                    <button
                        type="button"
                        className="page-new"
                        onClick={page.create}
                    >
                        New note
                    </button>
                </header>
                {page.note !== null && (
                    <p className="page-status" role="status">
                        {page.note}
                    </p>
                )}
                {notifications.error !== null && (
                    <p className="page-error" role="alert">
                        {notifications.error}
                    </p>
                )}
                {jobs.error !== null && (
                    <p className="page-error" role="alert">
                        {jobs.error}
                    </p>
                )}
                {showTest && (
                    <p className="notification-test">
                        <button
                            type="button"
                            onClick={() => notifications.sendTest()}
                        >
                            Send a test notification
                        </button>
                        {lastTest !== null && (
                            <span role="status">
                                {" "}
                                {describeDelivery(
                                    lastTest.delivered,
                                    lastTest.suppressed,
                                )}
                            </span>
                        )}
                    </p>
                )}
                {/* The headings only appear when there is something scheduled: the
                page is one list on a normal day, and the split is worth naming
                exactly when it matters. */}
                {scheduled.length > 0 ? (
                    <>
                        <section
                            className="page-section"
                            aria-labelledby="scheduled-heading"
                        >
                            <h2
                                id="scheduled-heading"
                                className="page-section-head"
                            >
                                Scheduled
                            </h2>
                            <ul className="job-list">
                                {scheduled.map((job) => (
                                    <JobRow
                                        key={job.id}
                                        job={job}
                                        now={now}
                                        token={token}
                                        onCancel={(id) => {
                                            void jobs.cancel(id);
                                        }}
                                        onEdit={page.edit}
                                    />
                                ))}
                            </ul>
                        </section>
                        <section
                            className="page-section"
                            aria-labelledby="recorded-heading"
                        >
                            <h2
                                id="recorded-heading"
                                className="page-section-head"
                            >
                                Recorded
                            </h2>
                            <RecordedList
                                notifications={notifications}
                                jobs={jobs}
                                now={now}
                                token={token}
                                onSnooze={snooze}
                            />
                        </section>
                    </>
                ) : (
                    <RecordedList
                        notifications={notifications}
                        jobs={jobs}
                        now={now}
                        token={token}
                        onSnooze={snooze}
                    />
                )}
            </main>
            {page.form !== null && (
                <JobForm
                    jobClass="notification"
                    editing={page.form.job}
                    jobs={jobs}
                    onClose={page.close}
                    onSaved={page.saved}
                />
            )}
        </>
    );
}
