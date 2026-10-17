/**
 * The floating toast (#90 phase 6b): the notification that follows the user.
 *
 * It replaces the chat's inline banner. A fired reminder arrives while the user
 * may be anywhere — that is the point of the phase — and the ring already owns
 * the case that must be unignorable, so this is the middle: a card in the corner
 * of whichever page is showing, staying until it is read or dismissed, with a way
 * into the list.
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

/** Props for {@link Toast}. */
export interface ToastProps {
    /** The row to show (never the timer that is ringing). */
    notification: ClientNotification;
    /** Marks it read — it settles, so the toast goes away on its own. */
    onMarkRead(id: string): void;
    /** Dismisses it — the stronger settle, for "I have dealt with this". */
    onDismiss(id: string): void;
}

/**
 * The corner toast.
 *
 * @param props - See {@link ToastProps}.
 */
export function Toast({ notification, onMarkRead, onDismiss }: ToastProps) {
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
                    <AppLink to="notifications" className="toast-link">
                        All notifications
                    </AppLink>
                </div>
            </div>
        </div>
    );
}
