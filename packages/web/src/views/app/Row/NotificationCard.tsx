/**
 * The one notification record card (#156), used by the Notifications page's
 * recorded half.
 *
 * It renders {@link presentNotification}'s parts. A notification's **message is
 * primary**: the title is the loud line, the body renders under it through
 * {@link Markdown} (so a link in a body survives instead of showing as raw
 * text), and the class chip plus the lifecycle state share the top line. The
 * state string is the caller's — the page knows which job a snoozed row came
 * from and can say "until 7:00 PM", which the record alone cannot.
 *
 * It emits the app's existing classes (`.notification-item .notification-text
 * …`), so a record is a pane on the notification list exactly as it was before
 * the presentation module existed.
 */
import type { ReactNode } from "react";
import { Markdown } from "../../../Markdown";
import { presentNotification } from "../../../presentation";
import type { ClientNotification } from "../../../notifications";
import { ClassChip } from "./ClassChip";

/** Props for {@link NotificationCard}. */
export interface NotificationCardProps {
    /** The record to render. */
    notification: ClientNotification;
    /** The clock the moment is compared against (injected, for the tests). */
    now: Date;
    /** The lifecycle line for the top row ("new", "until 7:00 PM", …). */
    state?: string;
    /** The row's actions, in a `⋯` menu (`RowActions`). */
    actions?: ReactNode;
    /** The run disclosure, when the record knows its job. */
    runs?: ReactNode;
    /** Extra classes for the row. */
    className?: string;
}

/**
 * One notification record.
 *
 * @param props - See {@link NotificationCardProps}.
 */
export function NotificationCard({
    notification,
    now,
    state,
    actions,
    runs,
    className = "",
}: NotificationCardProps) {
    const presented = presentNotification(notification, now);
    // `delivered` is the one state that means "you have not seen this", so it is
    // the one that gets the emphasis (#90 phase 7d) — keyed off the state rather
    // than the word, so rewording the label cannot silently drop it.
    const isNew = notification.state === "delivered";

    return (
        <li
            className={`notification-item notification-${notification.priority} notification-${notification.class} ${className}`.trim()}
        >
            <div className="notification-text">
                <div className="notification-head">
                    <ClassChip kind={presented.kind} />
                    {state !== undefined && (
                        <span
                            className={`notification-state${
                                isNew ? " notification-state-new" : ""
                            }`}
                        >
                            {state}
                        </span>
                    )}
                </div>
                <strong>{presented.title}</strong>
                {presented.body !== null && (
                    <div className="row-body">
                        <Markdown text={presented.body} />
                    </div>
                )}
                {presented.details.map((detail) => (
                    <span key={detail} className="notification-detail">
                        {" "}
                        {detail}
                    </span>
                ))}
                {runs}
            </div>
            {actions !== undefined && (
                <div className="notification-actions">{actions}</div>
            )}
        </li>
    );
}
