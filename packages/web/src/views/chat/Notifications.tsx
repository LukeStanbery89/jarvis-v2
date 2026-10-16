/**
 * The in-app notification surface (#139): a banner for the newest unsettled
 * notification, and a collapsible list of the rest.
 *
 * Presentational only — every action is a prop — so the merge/settle logic
 * stays in `notifications.ts` and the I/O in `useNotifications.ts`. Kept
 * inside the conversation column rather than the sidebar so a notification
 * cannot be missed while the sidebar is collapsed, and so phase 1 needs no
 * sidebar changes at all.
 *
 * Priority drives the styling, not the visibility: phase 1 has exactly one
 * channel, so suppressing a `low` notification would mean never showing it.
 * What `high`/`urgent` buy here is emphasis.
 */
import { Bell, X } from "lucide-react";
import { debugEnabled } from "../../debug";
import {
    describeDelivery,
    describeNotificationState,
} from "../../notifications";
import type {
    ClientNotification,
    NotificationSuppression,
} from "../../notifications";

/** Props for {@link Notifications}. */
export interface NotificationsProps {
    /** Newest unsettled notification, or `null` when nothing wants attention. */
    banner: ClientNotification | null;
    /** The whole list, newest first (for the expanded panel). */
    notifications: ClientNotification[];
    /** Count of notifications neither read nor dismissed. */
    unread: number;
    /** Whether the expanded list is showing. */
    open: boolean;
    /** Toggles the expanded list. */
    onToggle(): void;
    /** Marks one notification read. */
    onMarkRead(id: string): void;
    /** Dismisses one notification. */
    onDismiss(id: string): void;
    /**
     * Raises a test notification with this browser's own credential (#139).
     * Development only — the button is rendered under `import.meta.env.DEV`
     * as well as the `jarvis.debug` flag, so a production bundle has no trace
     * of it. A shipped build tests this path by asking the assistant
     * ("send me a test notification"), which exercises a real producer rather
     * than a debug affordance.
     */
    onSendTest(): void;
    /** The last test outcome, so the panel can say what happened to it. */
    lastTest: {
        delivered: number;
        suppressed: NotificationSuppression | null;
    } | null;
}

/**
 * Renders the badge, the banner, and the list.
 *
 * The badge is always present once there is anything unread, so a user who
 * dismisses the banner still has a way back to the list — dismissing is a
 * courtesy, not a data loss.
 */
export function Notifications({
    banner,
    notifications,
    unread,
    open,
    onToggle,
    onMarkRead,
    onDismiss,
    onSendTest,
    lastTest,
}: NotificationsProps) {
    // Development only: a shipped bundle carries neither the branch nor the
    // button (Vite folds `import.meta.env.DEV` to `false`), because a real
    // producer now exists to exercise the channel in production.
    const showTest = import.meta.env.DEV && debugEnabled();
    return (
        <>
            {banner && (
                <div
                    className={`notification-banner notification-${banner.priority}`}
                    role="status"
                >
                    <div className="notification-text">
                        <strong>{banner.title}</strong>
                        {banner.body !== undefined && (
                            <span> {banner.body}</span>
                        )}
                        {banner.requiresAnswer === true && (
                            <em className="notification-needs-answer">
                                {" "}
                                (waiting for your answer)
                            </em>
                        )}
                    </div>
                    <div className="notification-actions">
                        <button
                            type="button"
                            onClick={() => onMarkRead(banner.id)}
                        >
                            Mark read
                        </button>
                        <button
                            type="button"
                            onClick={() => onDismiss(banner.id)}
                        >
                            <X size={14} aria-hidden="true" /> Dismiss
                        </button>
                    </div>
                </div>
            )}
            <button
                type="button"
                className="notification-toggle"
                onClick={onToggle}
                aria-expanded={open}
            >
                <Bell size={14} aria-hidden="true" />
                Notifications
                {unread > 0 && (
                    <span className="notification-count">{unread}</span>
                )}
            </button>
            {open && showTest && (
                <p className="notification-test">
                    <button type="button" onClick={onSendTest}>
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
            {open && (
                <ul className="notification-list">
                    {notifications.length === 0 && (
                        <li className="notification-empty">
                            Nothing to report.
                        </li>
                    )}
                    {notifications.map((item) => (
                        <li
                            key={item.id}
                            className={`notification-item notification-${item.priority}${
                                item.state === "dismissed" ? " dismissed" : ""
                            }`}
                        >
                            <div className="notification-text">
                                <strong>{item.title}</strong>
                                {item.body !== undefined && (
                                    <span> {item.body}</span>
                                )}
                            </div>
                            <div className="notification-actions">
                                <span className="notification-state">
                                    {describeNotificationState(item.state)}
                                </span>
                                {item.state === "pending" ||
                                item.state === "delivered" ? (
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
                                ) : null}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}
