/**
 * The notifications page (#90 phases 6c, 7): the notification class, whole.
 *
 * Two halves, because the class has two halves in time. **Scheduled** is work of
 * this class that has not arrived yet — the model's `scheduleTask` jobs ("turn
 * the kitchen light on at 8pm", "a weather summary at 8am") and any note written
 * here by hand. They had no page at all before phase 7d: pending, they appeared
 * only on the dashboard and could not be cancelled from the UI. **Recorded** is
 * everything the server has filed, with the actions each row allows: mark read,
 * dismiss, snooze. A thing that is scheduled stops being scheduled when it fires
 * and becomes a record, so the same item never shows in both lists.
 *
 * The page also takes over from the chat's inline notification list, which only
 * existed while the conversation was on screen — the wrong home for the reading
 * surface, now that the toast carries the interrupting half and the nav badge
 * carries the count.
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
    describeBody,
    describeDelivery,
    describeNotice,
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
 * A settled row offers nothing: read, answered, dismissed and snoozed are final,
 * and offering an action the server would refuse is worse than offering none.
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
    // The title says it all for most reminders (#90 phase 6c) — see `describeBody`.
    const body = describeBody(item);
    // The state column holds a sentence for a snoozed row, because "snoozed" alone
    // is the half of it the user did not ask about.
    const state =
        item.state === "snoozed"
            ? describeSnooze(snoozeUntil(item.jobId, jobs.jobs), now)
            : describeNotificationState(item.state);
    return (
        <li
            className={`notification-item notification-${item.priority} notification-${item.class}`}
        >
            <div className="notification-text">
                <span className="notification-eyebrow">
                    {describeNotice(item)}
                </span>
                <strong>{item.title}</strong>
                {body !== null && <span> {body}</span>}
                {item.requiresAnswer === true && (
                    <em className="notification-needs-answer">
                        {" "}
                        (waiting for your answer)
                    </em>
                )}
                {/* What the job actually did, when the record knows which job it
                    was. Absent for a record with no `jobId` (one raised by
                    something other than a job), and for a job since pruned it
                    says so rather than showing nothing. */}
                {item.jobId !== undefined && (
                    <JobRuns token={token} jobId={item.jobId} />
                )}
            </div>
            <div className="notification-actions">
                {/* `delivered` is the one state that means "you have not seen
                    this", so it is the one that gets the amber NEW (#90 phase
                    7d) — keyed off the state rather than the word, so rewording
                    the label cannot silently drop the emphasis. */}
                <span
                    className={`notification-state${
                        item.state === "delivered"
                            ? " notification-state-new"
                            : ""
                    }`}
                >
                    {state}
                </span>
                {!settled && (
                    <>
                        <button
                            type="button"
                            onClick={() => onMarkRead(item.id)}
                        >
                            Mark read
                        </button>
                        <button
                            type="button"
                            onClick={() => onDismiss(item.id)}
                        >
                            Dismiss
                        </button>
                    </>
                )}
                {/* Only a reminder can be deferred, and only while it is still
                    owed (a job row's own Snooze is on the reminder pages). */}
                {!settled &&
                    item.class === "reminder" &&
                    item.jobId !== undefined && (
                        <SnoozeMenu
                            onSnooze={(minutes) => onSnooze(item, minutes)}
                        />
                    )}
            </div>
        </li>
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
            <main className="page">
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
                {/* The headings only appear when there is something scheduled:
                    the page is one list on a normal day, and the split is worth
                    naming exactly when it matters. */}
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
