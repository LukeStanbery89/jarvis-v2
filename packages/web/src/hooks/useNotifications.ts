/**
 * Notification state for the chat view: the fetched page, the live frames, and
 * the two settle actions (#139).
 *
 * Deliberately plain React state rather than the transcript's reducer: a
 * notification list has no turn semantics, and its merge rules already live in
 * the pure `notifications.ts`. What is left here is I/O — one page fetch on
 * mount, one optimistic local settle followed by the REST call, and a rollback
 * if the server refuses.
 *
 * The token is the component's device credential; a 401 is the caller's
 * problem (the app drops to login), so failures here are surfaced as a short
 * message rather than swallowed or thrown.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { debugLog } from "../debug";
import {
    mergeNotification,
    mergeNotificationPage,
    selectBanner,
    settleNotification,
    unreadCount,
} from "../notifications";
import type {
    ClientNotification,
    NotificationState,
    NotificationSuppression,
} from "../notifications";
import type { NotificationFrame } from "@lukestanbery/jarvis-protocol";

/** One live frame as the client stores it: state is the record's, not the wire's. */
export function fromFrame(
    frame: NotificationFrame["notification"],
): ClientNotification {
    return {
        id: frame.id,
        kind: frame.kind,
        priority: frame.priority,
        title: frame.title,
        ...(frame.body !== undefined ? { body: frame.body } : {}),
        createdAt: frame.createdAt,
        ...(frame.requiresAnswer === true ? { requiresAnswer: true } : {}),
        // A pushed notification is by definition delivered; the record may
        // later say it was read on another device, which the next fetch wins.
        state: "delivered",
    };
}

/** What {@link useNotifications} exposes to the view. */
export interface NotificationsState {
    /** Newest first, bounded (see `NOTIFICATION_LIMIT`). */
    notifications: ClientNotification[];
    /** The newest unsettled notification, for the prominent surface. */
    banner: ClientNotification | null;
    /** Count of notifications neither read nor dismissed. */
    unread: number;
    /** Whether a fetch is in flight (the list can render empty meanwhile). */
    loading: boolean;
    /** Why the last call failed, if it did. */
    error: string | null;
    /** Feeds one live `/ws` frame into the list. */
    acceptFrame(frame: NotificationFrame["notification"]): void;
    /** Marks one read, optimistically. */
    markRead(id: string): void;
    /** Dismisses one, optimistically. */
    dismiss(id: string): void;
    /** Re-reads the page (after a reconnect, or from a manual retry). */
    refresh(): void;
    /**
     * Raises a test notification through this browser's own credential
     * (#139 debug affordance), so the whole path can be exercised without a
     * device token: the answer says whether it was pushed or held back.
     */
    sendTest(): void;
    /** The last {@link sendTest} outcome, or `null` before the first one. */
    lastTest: {
        delivered: number;
        suppressed: NotificationSuppression | null;
    } | null;
}

/**
 * Owns the notification list for one signed-in device token.
 *
 * @param token - The device credential the REST calls authenticate with.
 */
export function useNotifications(token: string): NotificationsState {
    const [notifications, setNotifications] = useState<ClientNotification[]>(
        [],
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastTest, setLastTest] = useState<{
        delivered: number;
        suppressed: NotificationSuppression | null;
    } | null>(null);

    const refresh = useCallback(() => {
        setLoading(true);
        api.listNotifications(token)
            .then((page) => {
                debugLog(
                    "notify",
                    `list loaded (${page.notifications.length} row(s), ${page.unread} unread)`,
                );
                setNotifications((current) =>
                    mergeNotificationPage(
                        current,
                        page.notifications.map(toClientNotification),
                    ),
                );
                setError(null);
            })
            .catch((err: unknown) => {
                // A 401 means the credential is dead: the app is about to
                // drop to login, so a notification error would be noise.
                if (err instanceof ApiError && err.status === 401) {
                    return;
                }
                setError(
                    err instanceof Error
                        ? err.message
                        : "could not load notifications",
                );
            })
            .finally(() => setLoading(false));
    }, [token]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const acceptFrame = useCallback(
        (frame: NotificationFrame["notification"]) => {
            // The one line that answers "did the server actually push it?":
            // if this never appears, the socket or the server's delivery gate
            // is the story, not the UI.
            debugLog(
                "notify",
                `frame received id=${frame.id} kind=${frame.kind} priority=${frame.priority}`,
            );
            setNotifications((current) =>
                mergeNotification(current, fromFrame(frame)),
            );
        },
        [],
    );

    const settle = useCallback(
        (
            id: string,
            state: NotificationState,
            call: () => Promise<unknown>,
        ) => {
            const before = notifications;
            setNotifications((current) =>
                settleNotification(current, id, state),
            );
            call().catch((err: unknown) => {
                // Roll back to what the server still believes: an optimistic
                // dismissal that never landed is a lie the next fetch would
                // expose anyway, so it is undone immediately and reported.
                setNotifications(before);
                setError(
                    err instanceof Error
                        ? err.message
                        : "could not update the notification",
                );
            });
        },
        [notifications],
    );

    const markRead = useCallback(
        (id: string) => {
            settle(id, "read", () => api.markNotificationRead(token, id));
        },
        [settle, token],
    );

    const dismiss = useCallback(
        (id: string) => {
            settle(id, "dismissed", () => api.dismissNotification(token, id));
        },
        [settle, token],
    );

    const sendTest = useCallback(() => {
        setLastTest(null);
        api.createNotification(token, {
            kind: "test",
            title: "Test notification",
            body: "Raised from this browser's own session.",
            priority: "high",
        })
            .then((outcome) => {
                setLastTest({
                    delivered: outcome.delivered,
                    // The REST schema types this as a plain string; the union
                    // is asserted here so the renderer can be exhaustive over
                    // the four gates instead of printing a raw token.
                    suppressed: (outcome.suppressed ??
                        null) as NotificationSuppression | null,
                });
                debugLog(
                    "notify",
                    `test push: delivered=${outcome.delivered} suppressed=${String(outcome.suppressed)}`,
                );
                // Re-read either way: a suppressed notification is not pushed,
                // and the list is the only place it becomes visible.
                refresh();
            })
            .catch((err: unknown) => {
                setError(
                    err instanceof Error
                        ? err.message
                        : "could not create the test notification",
                );
            });
    }, [refresh, token]);

    const banner = useMemo(() => selectBanner(notifications), [notifications]);
    const unread = useMemo(() => unreadCount(notifications), [notifications]);

    return {
        notifications,
        banner,
        unread,
        loading,
        error,
        acceptFrame,
        markRead,
        dismiss,
        refresh,
        sendTest,
        lastTest,
    };
}

/** Maps a REST record onto the client shape (state included). */
function toClientNotification(record: {
    id: string;
    kind: string;
    priority: string;
    title: string;
    body?: string;
    state: string;
    requiresAnswer?: boolean;
    answer?: string;
    createdAt: string;
}): ClientNotification {
    return {
        id: record.id,
        kind: record.kind,
        priority: record.priority,
        title: record.title,
        ...(record.body !== undefined ? { body: record.body } : {}),
        createdAt: record.createdAt,
        ...(record.requiresAnswer === true ? { requiresAnswer: true } : {}),
        ...(record.answer !== undefined ? { answer: record.answer } : {}),
        state: record.state as NotificationState,
    };
}
