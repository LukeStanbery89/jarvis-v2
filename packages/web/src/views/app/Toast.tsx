/**
 * The floating toast stack (#90 phases 6b–6c): the notifications that follow the
 * user.
 */
import { X } from "lucide-react";
import { AppLink } from "../../AppLink";
import { describeBody, describeNotice } from "../../notifications";
import type { ClientNotification } from "../../notifications";
import { SnoozeMenu } from "./SnoozeMenu";
import { presentNotification } from "../../presentation";
import { useClock } from "../../hooks/useClock";
import { ClassChip } from "./Row/ClassChip";

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
 */
function ToastCard({
    notification,
    onMarkRead,
    onDismiss,
    onSnooze,
}: ToastCardProps) {
    const now = useClock();
    const presented = presentNotification(notification, now);
    // The title says it all for most reminders, and a body that only restates it
    // reads as a stutter (#90 phase 6c) — see `describeBody`.
    const body = describeBody(notification);
    return (
        <div
            className={`notification-banner notification-${notification.priority} notification-${notification.class} toast`}
            role="status"
        >
            <div className="notification-text">
                <ClassChip kind={presented.kind} />
                <span className="notification-eyebrow">
                    {describeNotice(notification)}
                </span>
                <strong>{presented.primary}</strong>
                {body !== null && body !== notification.title && (
                    <span> {body}</span>
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
