/**
 * The floating toast stack (#90 phases 6b–6c): the notifications that follow the
 * user.
 *
 * It replaces the chat's inline banner. A fired reminder arrives while the user
 * may be anywhere — that is the point of the phase — and the ring already owns the
 * case that must be unignorable, so this is the middle: cards in the top corner of
 * whichever page is showing, each staying until it is read, dismissed or
 * **snoozed** (the deferral a reminder exists for, #90 phase 6c), with a way into
 * the list.
 *
 * **A stack, not one card** (#90 phase 6c): several reminders landing in the same
 * minute is the normal case, not the edge case, and showing only the newest made
 * the rest look lost. Which rows reach it is `selectToasts`' decision — up to
 * `TOAST_LIMIT`, newest first, never the timer that is ringing — so this component
 * renders what it is handed and decides nothing.
 *
 * The words are the list's words (`describeNotice`), because a reminder that says
 * "Reminder" here and something else there would be two vocabularies for one thing.
 * The card reuses the banner's classes deliberately: it *is* the banner's content,
 * and sharing the styles is what keeps them from drifting apart.
 */
import { X } from "lucide-react";
import { AppLink } from "../../AppLink";
import { describeBody, describeNotice } from "../../notifications";
import type { ClientNotification } from "../../notifications";
import { SnoozeMenu } from "./SnoozeMenu";

/** Props for {@link ToastStack}. */
export interface ToastStackProps {
    /** The rows to show, newest first (never the timer that is ringing). */
    toasts: ClientNotification[];
    /** Marks one read — it settles, so its card goes away on its own. */
    onMarkRead(id: string): void;
    /** Dismisses one — the stronger settle, for "I have dealt with this". */
    onDismiss(id: string): void;
    /**
     * Defers a reminder (#90 phase 6c), by minutes. Only offered for a `reminder`
     * that still has a job behind it — the whole point of a reminder is that it can
     * be moved rather than read.
     */
    onSnooze(notification: ClientNotification, minutes: number): void;
}

/** Props for one card. */
interface ToastCardProps {
    notification: ClientNotification;
    onMarkRead(id: string): void;
    onDismiss(id: string): void;
    onSnooze(notification: ClientNotification, minutes: number): void;
}

/**
 * One card: the words, and the three actions plus the way into the list.
 *
 * Keyed by the notification's id by its caller, so a card that replaces a settled
 * one animates in rather than swapping its text in place.
 */
function ToastCard({
    notification,
    onMarkRead,
    onDismiss,
    onSnooze,
}: ToastCardProps) {
    // The title says it all for most reminders, and a body that only restates it
    // reads as a stutter (#90 phase 6c) — see `describeBody`.
    const body = describeBody(notification);
    return (
        <div
            className={`notification-banner notification-${notification.priority} notification-${notification.class} toast`}
            role="status"
        >
            <div className="notification-text">
                <span className="notification-eyebrow">
                    {describeNotice(notification)}
                </span>
                <strong>{notification.title}</strong>
                {body !== null && <span> {body}</span>}
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
                        <SnoozeMenu
                            onSnooze={(minutes) =>
                                onSnooze(notification, minutes)
                            }
                        />
                    )}
                <AppLink to="notifications" className="toast-link">
                    All notifications
                </AppLink>
            </div>
        </div>
    );
}

/**
 * The corner stack.
 *
 * @param props - See {@link ToastStackProps}.
 */
export function ToastStack({
    toasts,
    onMarkRead,
    onDismiss,
    onSnooze,
}: ToastStackProps) {
    return (
        <div className="toast-stack" role="region" aria-label="Notifications">
            {toasts.map((notification) => (
                <ToastCard
                    key={notification.id}
                    notification={notification}
                    onMarkRead={onMarkRead}
                    onDismiss={onDismiss}
                    onSnooze={onSnooze}
                />
            ))}
        </div>
    );
}
