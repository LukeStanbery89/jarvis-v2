/**
 * The notifications page (#90 phase 6c): everything the server has recorded, with
 * the actions each row allows.
 *
 * It takes over from the chat's inline list, which only existed while the
 * conversation was on screen — the wrong home for the reading surface, now that
 * the toast carries the interrupting half and the nav badge carries the count.
 * What is left here is the list: mark read, dismiss, snooze, and the
 * development-only affordance that raises a test notification.
 *
 * "Snoozed until 7:00 PM" is assembled from the row **and its job**
 * (`snoozeUntil`): the notification records the deferral, the job holds the
 * moment, and the link between them is the reason `jobId` exists. A row whose job
 * has since been pruned says plain "snoozed" — the honest half of the truth, not a
 * guess at a time.
 *
 * State and I/O are the shell's (`useNotifications`, `useJobs`); this is a reading
 * of them, which is why it renders the list and nothing else.
 */
import { debugEnabled } from "../../debug";
import { describeSnooze, snoozeUntil } from "../../jobs";
import { snoozeReminder } from "../../snooze";
import { useClock } from "../../hooks/useClock";
import {
    describeDelivery,
    describeNotice,
    describeNotificationState,
    isSettled,
} from "../../notifications";
import type { ClientNotification } from "../../notifications";
import type { JobsState } from "../../hooks/useJobs";
import type { NotificationsState } from "../../hooks/useNotifications";
import { SnoozeMenu } from "./SnoozeMenu";

/** Props for {@link NotificationsPage}. */
export interface NotificationsPageProps {
    /** The notification list and its actions (the shell's). */
    notifications: NotificationsState;
    /** The caller's jobs: what a snoozed row's moment is read from. */
    jobs: JobsState;
}

/** Props for one row. */
interface NotificationRowProps {
    item: ClientNotification;
    jobs: JobsState;
    now: Date;
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
    onMarkRead,
    onDismiss,
    onSnooze,
}: NotificationRowProps) {
    const settled = isSettled(item.state);
    // The state column holds a sentence for a snoozed row, because "snoozed" alone
    // is the half of it the user did not ask about.
    const state =
        item.state === "snoozed"
            ? describeSnooze(snoozeUntil(item.jobId, jobs.jobs), now)
            : describeNotificationState(item.state);
    return (
        <li
            className={`notification-item notification-${item.priority} notification-${item.class}${
                item.state === "dismissed" ? " dismissed" : ""
            }`}
        >
            <div className="notification-text">
                <span className="notification-eyebrow">
                    {describeNotice(item)}
                </span>
                <strong>{item.title}</strong>
                {item.body !== undefined && <span> {item.body}</span>}
                {item.requiresAnswer === true && (
                    <em className="notification-needs-answer">
                        {" "}
                        (waiting for your answer)
                    </em>
                )}
            </div>
            <div className="notification-actions">
                <span className="notification-state">{state}</span>
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
 * The notifications page.
 *
 * @param props - See {@link NotificationsPageProps}.
 */
export function NotificationsPage({
    notifications,
    jobs,
}: NotificationsPageProps) {
    const now = useClock();
    // Development only, and gated on the debug flag as well: a shipped bundle
    // carries neither the branch nor the button (Vite folds `import.meta.env.DEV`
    // to `false`), because a real producer exists to exercise the channel.
    const showTest = import.meta.env.DEV && debugEnabled();
    const { lastTest } = notifications;

    /**
     * Snoozes the reminder a row came from (#90 phase 6c).
     *
     * The join lives in `snoozeReminder` because the toast offers the same action:
     * one request settles both halves, and the row is only settled locally once
     * that reported success.
     */
    function snooze(item: ClientNotification, minutes: number): void {
        snoozeReminder({ notifications, jobs }, item, minutes);
    }

    return (
        <main className="page">
            <header className="page-head">
                <h1>Notifications</h1>
                <p className="page-note">
                    {notifications.unread === 0
                        ? "Nothing waiting to be read."
                        : `${notifications.unread} unread`}
                    {notifications.loading ? " · loading…" : ""}
                </p>
            </header>
            {notifications.error !== null && (
                <p className="page-error" role="alert">
                    {notifications.error}
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
                        onMarkRead={notifications.markRead}
                        onDismiss={notifications.dismiss}
                        onSnooze={snooze}
                    />
                ))}
            </ul>
        </main>
    );
}
