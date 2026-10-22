/**
 * Shared notification card (#156). For records and scheduled items.
 */
import type { ReactNode } from "react";
import { presentNotification } from "../../../presentation";
import type { ClientNotification } from "../../../notifications";
import { ClassChip } from "./ClassChip";

export interface NotificationCardProps {
    notification: ClientNotification;
    now: Date;
    variant?: "normal" | "compact";
    showKind?: boolean;
    actions?: ReactNode | null;
    className?: string;
}

export function NotificationCard({
    notification,
    now,
    variant = "normal",
    showKind = true,
    actions = null,
    className = "",
}: NotificationCardProps) {
    const presented = presentNotification(notification, now);
    const isCompact = variant === "compact";

    return (
        <li
            className={`notification-card notification-card-${notification.class} notification-card-${variant} ${className}`.trim()}
        >
            <div className="notification-card-main">
                <div className="notification-card-header">
                    {showKind && <ClassChip kind={presented.kind} />}
                </div>
                <div className="notification-card-primary">
                    {presented.primary}
                </div>
                {presented.title !== presented.primary && (
                    <div className="notification-card-title">
                        {presented.title}
                    </div>
                )}
                {presented.details.length > 0 && (
                    <div className="notification-card-details">
                        {presented.details.map((d, i) => (
                            <div key={i} className="notification-card-detail">
                                {d}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {!isCompact && actions !== undefined && (
                <div className="notification-card-actions">{actions}</div>
            )}
        </li>
    );
}
