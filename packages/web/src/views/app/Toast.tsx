/**
 * The floating toast (#90 phase 6b): the notification that follows the user.
 *
 * It replaces the chat's inline banner. A fired reminder arrives while the user
 * may be anywhere — that is the point of the phase — and the ring already owns
 * the case that must be unignorable, so this is the middle: a card in the top
 * corner of whichever page is showing, staying until it is read, dismissed or
 * **snoozed** (the deferral a reminder exists for, #90 phase 6c), with a way into
 * the list.
 *
 * The words are the list's words (`describeNotice`), because a reminder that
 * says "Reminder" here and something else there would be two vocabularies for one
 * thing. Which rows reach it is `selectToast`'s decision, not this component's.
 *
 * The card reuses the banner's classes deliberately: it *is* the banner's
 * content, moved out of the conversation column, and sharing the styles is what
 * keeps them from drifting apart.
 */
import { X } from "lucide-react";
import { AppLink } from "../../AppLink";
import { describeNotice } from "../../notifications";
import type { ClientNotification } from "../../notifications";
import { SnoozeMenu } from "./SnoozeMenu";

/** Props for {@link Toast}. */
export interface ToastProps {
    /** The row to show (never the timer that is ringing). */
    notification: ClientNotification;
    /** Marks it read — it settles, so the toast goes away on its own. */
    onMarkRead(id: string): void;
    /** Dismisses it — the stronger settle, for "I have dealt with this". */
    onDismiss(id: string): void;
    /**
     * Defers the reminder this toast is about (#90 phase 6c), by minutes. Only
     * offered for a `reminder` that still has a job behind it — the whole point of
     * a reminder is that it can be moved rather than read.
     */
    onSnooze(minutes: number): void;
}

/**
 * The corner toast.
 *
 * @param props - See {@link ToastProps}.
 */
export function Toast({
    notification,
    onMarkRead,
    onDismiss,
    onSnooze,
}: ToastProps) {
    return (
        <div className="toast-stack">
            <div
                className={`notification-banner notification-${notification.priority} notification-${notification.class} toast`}
                role="status"
            >
                <div className="notification-text">
                    <span className="notification-eyebrow">
                        {describeNotice(notification)}
                    </span>
                    <strong>{notification.title}</strong>
                    {notification.body !== undefined && (
                        <span> {notification.body}</span>
                    )}
                    {notification.requiresAnswer === true && (
                        <em className="notification-needs-answer">
                            {" "}
                            (waiting for your answer)
                        </em>
                    )}
                </div>
                <div className="notification-actions">
                    <button
                        type="button"
                        onClick={() => onMarkRead(notification.id)}
                    >
                        Mark read
                    </button>
                    <button
                        type="button"
                        onClick={() => onDismiss(notification.id)}
                    >
                        <X size={14} aria-hidden="true" /> Dismiss
                    </button>
                    {/* A reminder's escape hatch is the deferral, so it leads here
                        rather than only on the page that lists it (#90 phase 6c). */}
                    {notification.class === "reminder" &&
                        notification.jobId !== undefined && (
                            <SnoozeMenu onSnooze={onSnooze} />
                        )}
                    <AppLink to="notifications" className="toast-link">
                        All notifications
                    </AppLink>
                </div>
            </div>
        </div>
    );
}
