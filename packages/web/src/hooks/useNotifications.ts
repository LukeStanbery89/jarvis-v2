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
 * The frame path also re-reads the page when a frame arrives **without a
 * `class`**: that is not a server bug but a stale Vite pre-bundle of the shared
 * protocol (its parser copies the shape it was built with), and the record has
 * the field the frame lost. Settling from the record keeps a timer ringing
 * instead of rendering it as an ordinary notification, and the development
 * warning names the cause once.
 *
 * The token is the component's device credential; a 401 is the caller's
 * problem (the app drops to login), so failures here are surfaced as a short
 * message rather than swallowed or thrown.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { debugLog } from "../debug";
import {
    fromFrame,
    fromRecord,
    mergeNotification,
    mergeNotificationPage,
    selectAlerts,
    removeNotification,
    settleNotification,
    unreadCount,
} from "../notifications";
import type {
    ClientNotification,
    NotificationSuppression,
} from "../notifications";
import type { NotificationFrame } from "@lukestanbery/jarvis-protocol";

/** What {@link useNotifications} exposes to the view. */
export interface NotificationsState {
    /** Newest first, bounded (see `NOTIFICATION_LIMIT`). */
    notifications: ClientNotification[];
    /** The fired timer that should be ringing, or `null` (#90 phase 4). */
    ring: ClientNotification | null;
    /** The newest unsettled notification, for the prominent surface. */
    banner: ClientNotification | null;
    /** Count of notifications that are not settled. */
    unread: number;
    /** Whether a fetch is in flight (the list can render empty meanwhile). */
    loading: boolean;
    /** Whether the first page load has completed (see the options doc). */
    loaded: boolean;
    /** Why the last call failed, if it did. */
    error: string | null;
    /** Feeds one live `/ws` frame into the list. */
    acceptFrame(frame: NotificationFrame["notification"]): void;
    /** Marks one read, optimistically. */
    markRead(id: string): void;
    /** Dismisses one, optimistically. */
    dismiss(id: string): void;
    /**
     * Settles one row as `snoozed`, locally (#90 phase 6c).
     *
     * No request of its own, on purpose: the call that *made* it a snooze is the
     * job's (`POST /api/jobs/{id}/snooze`), which settles the row server-side in
     * the same breath — the deferral is the acknowledgement. This is the client's
     * half, applied once that call has succeeded, so there is nothing to roll
     * back and nothing to double-post.
     */
    markSnoozed(id: string): void;
    /**
     * Re-reads the page. Called when the client recovers a dropped connection
     * (`onReconnected`), since a notification raised while the socket was down
     * was pushed to nobody and the list is the only place it can appear.
     */
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
 * @param notifyEnabled - The account's master switch (`notify.enabled`). It
 *   gates the *ring*, not the list: a suppressed notification is still a
 *   record the user can read, but nothing may start shouting on its behalf.
 */
export function useNotifications(options: {
    token: string;
    notifyEnabled?: boolean;
}): NotificationsState {
    const { token, notifyEnabled = true } = options;
    const [notifications, setNotifications] = useState<ClientNotification[]>(
        [],
    );
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
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
                        page.notifications.map(fromRecord),
                    ),
                );
                setLoaded(true);
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

    /** Latest `refresh`, for the frame path (which must not re-subscribe to it). */
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;
    /** Whether the stale-bundle warning has been said (once per session). */
    const warnedStaleBundle = useRef(false);

    const acceptFrame = useCallback(
        (frame: NotificationFrame["notification"]) => {
            // The one line that answers "did the server actually push it?":
            // if this never appears, the socket or the server's delivery gate
            // is the story, not the UI.
            //
            // `class` is read structurally on purpose. A client whose Vite
            // pre-bundle of the protocol predates the field receives frames
            // *without* it (the old parser validates and copies the old
            // shape), so the row is ring-ineligible until a REST fetch
            // replaces it — which looks exactly like "timers never ring". The
            // warning below is what turns that into a one-line diagnosis.
            const frameClass: string | undefined = (frame as { class?: string })
                .class;
            debugLog(
                "notify",
                `frame received id=${frame.id} kind=${frame.kind} class=${frameClass ?? "MISSING"} priority=${frame.priority}`,
            );
            if (frameClass === undefined) {
                // A pre-bundled protocol that predates the field validates and
                // copies the *old* shape, so the frame arrives classless and a
                // timer would render as an ordinary notification. The record
                // has the class, so ask for it rather than guessing; the
                // warning names the actual cause (once, development only).
                if (!warnedStaleBundle.current) {
                    warnedStaleBundle.current = true;
                    if (import.meta.env.DEV) {
                        console.warn(
                            "[jarvis] a notification frame arrived without " +
                                "`class` — this browser's pre-bundled protocol " +
                                "is stale. Run `npm run dev:clean -w " +
                                "@lukestanbery/jarvis-web` and reload.",
                        );
                    }
                }
                debugLog(
                    "notify",
                    "frame carries no class — settling this row from the REST record",
                );
                refreshRef.current();
            }
            setNotifications((current) =>
                mergeNotification(current, fromFrame(frame)),
            );
        },
        [],
    );

    /**
     * Applies one local change optimistically, and undoes it if the call fails.
     *
     * The rollback restores the *row* rather than the list: a notification that
     * arrives between the click and a failure must survive, and nothing refetches
     * mid-session, so dropping it would stay dropped.
     */
    const apply = useCallback(
        (
            id: string,
            label: string,
            update: (list: ClientNotification[]) => ClientNotification[],
            call: () => Promise<unknown>,
        ) => {
            debugLog("notify", `${label} id=${id}`);
            // Snapshot the *row*, not the list: a notification that arrives
            // between this click and a failure must survive the rollback, and
            // restoring a whole-list snapshot would silently discard it — and
            // nothing refetches mid-session, so it would stay gone.
            const before = notifications.find((item) => item.id === id);
            setNotifications((current) => update(current));
            call().catch((err: unknown) => {
                // Roll back to what the server still believes: an optimistic
                // dismissal that never landed is a lie the next fetch would
                // expose anyway, so it is undone immediately and reported.
                setNotifications((current) =>
                    before === undefined
                        ? current
                        : replaceNotification(current, before),
                );
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
            apply(
                id,
                "read",
                (list) => settleNotification(list, id, "read"),
                () => api.markNotificationRead(token, id),
            );
        },
        [apply, token],
    );

    const dismiss = useCallback(
        (id: string) => {
            // A dismissal deletes the row (#90 phase 9c), so the optimistic change
            // is a removal — and `removeNotification` rather than a filter here,
            // because the test suite owns that behaviour.
            apply(
                id,
                "dismiss",
                (list) => removeNotification(list, id),
                () => api.dismissNotification(token, id),
            );
        },
        [apply, token],
    );

    /**
     * Settles one row as `snoozed` (#90 phase 6c).
     *
     * Local only — the request that caused it was the *job's* snooze, which
     * settles this row server-side. Nothing to roll back: it is applied after
     * that call reported success.
     */
    const markSnoozed = useCallback((id: string) => {
        debugLog("notify", `snoozed id=${id}`);
        setNotifications((current) =>
            settleNotification(current, id, "snoozed"),
        );
    }, []);

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

    const { ring, banner } = useMemo(
        () =>
            selectAlerts(notifications, {
                enabled: notifyEnabled,
                now: new Date(),
            }),
        [notifications, notifyEnabled],
    );
    const unread = useMemo(() => unreadCount(notifications), [notifications]);

    return {
        notifications,
        ring,
        banner,
        unread,
        loading,
        loaded,
        error,
        acceptFrame,
        markRead,
        dismiss,
        markSnoozed,
        refresh,
        sendTest,
        lastTest,
    };
}

/**
 * Replaces one row with a known previous version, leaving the rest alone.
 *
 * Used for a failed settle's rollback, where restoring the whole list would
 * drop anything merged in the meantime.
 */
function replaceNotification(
    list: ClientNotification[],
    previous: ClientNotification,
): ClientNotification[] {
    return list.map((item) => (item.id === previous.id ? previous : item));
}
