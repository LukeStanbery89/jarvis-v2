/**
 * The notifications page (#90 phases 6c, 7): the notification class, whole.
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
import { NotificationCard } from "./Row/NotificationCard";
import { JobCard } from "./Row/JobCard";

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
    const state =
        item.state === "snoozed"
            ? describeSnooze(snoozeUntil(item.jobId, jobs.jobs), now)
            : describeNotificationState(item.state);

    const actions = (
        <div style={{ display: "flex", gap: "0.25rem", alignItems: "center", flexWrap: "wrap" }}>
            {!settled && (
                <>
                    <button type="button" onClick={() => onMarkRead(item.id)}>
                        Mark read
                    </button>
                    <button type="button" onClick={() => onDismiss(item.id)}>
                        Dismiss
                    </button>
                </>
            )}
            {!settled &&
                item.class === "reminder" &&
                item.jobId !== undefined && (
                    <SnoozeMenu
                        onSnooze={(minutes) => onSnooze(item, minutes)}
                    />
                )}
            {item.jobId !== undefined && (
                <JobRuns token={token} jobId={item.jobId} />
            )}
            {item.state === "snoozed" && (
                <span className="notification-state-extra">{state}</span>
            )}
        </div>
    );

    return (
        <NotificationCard
            notification={item}
            now={now}
            variant="normal"
            showKind={true}
            actions={actions}
        />
    );
}

/**
 * The recorded half: everything the server has filed, in the order it sent it.
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
 */
export function NotificationsPage({
    notifications,
    jobs,
    token,
}: NotificationsPageProps) {
    const now = useClock();
    const page = useJobPage();
    const showTest = import.meta.env.DEV && debugEnabled();
    const { lastTest } = notifications;

    const scheduled = upcomingJobs(jobs.jobs, {
        limit: SCHEDULED_LIMIT,
        jobClass: "notification",
    });

    function snooze(item: ClientNotification, minutes: number): void {
        const request = snoozeRequestFor(item, minutes);
        if (request !== null) {
            snoozeReminder({ notifications, jobs }, request);
        }
    }

    return (
        <main className="notifications-page">
            <header className="notifications-head">
                <h1>Notifications</h1>
                {showTest && (
                    <button
                        type="button"
                        onClick={() => notifications.sendTest()}
                    >
                        Send test
                    </button>
                )}
            </header>
            {lastTest !== null && (
                <p className="notifications-last-test">
                    {lastTest.ok ? "Test sent." : `Test failed: ${lastTest.error}`}
                </p>
            )}
            <section className="notifications-section">
                <h2>Scheduled</h2>
                {scheduled.length === 0 ? (
                    <p className="notifications-empty">Nothing scheduled.</p>
                ) : (
                    <ul className="job-list">
                        {scheduled.map((job) => (
                            <JobRow
                                key={job.id}
                                job={job}
                                now={now}
                                token={token}
                                onCancel={jobs.cancel}
                                onEdit={page.openEdit}
                            />
                        ))}
                    </ul>
                )}
                <button type="button" onClick={page.openCreate}>
                    New notification
                </button>
            </section>
            <section className="notifications-section">
                <h2>Recorded</h2>
                <RecordedList
                    notifications={notifications}
                    jobs={jobs}
                    now={now}
                    token={token}
                    onSnooze={snooze}
                />
            </section>
            {page.open && (
                <JobForm
                    open={page.open}
                    draft={page.draft}
                    saving={page.saving}
                    error={page.error}
                    quiet={page.quiet}
                    onChange={page.change}
                    onCancel={page.close}
                    onSave={page.save}
                    fixedClass="notification"
                />
            )}
        </main>
    );
}
