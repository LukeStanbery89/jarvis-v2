/**
 * Notification state helpers (pure) — the client's half of #139.
 *
 * Two sources feed one list: `GET /api/notifications` (the durable record,
 * read on load) and the live `notification` frame (best-effort, arriving
 * outside any turn). They carry the *same* `id`, so merging by id is what
 * keeps a pushed notification from being rendered twice — once from the frame
 * and again from the fetched page.
 *
 * The rules live here, as pure functions, for the same reason `threads.ts`
 * and `sidebar.ts` do: the React layer in `hooks/useNotifications.ts` stays a
 * thin state shell, and the behaviour that actually matters (merge, settle,
 * pick what to show) is unit-testable without a DOM.
 *
 * State ownership: the wire frame never carries `state` — the record does —
 * so a frame merged over a record the user already read must not un-read it.
 * {@link mergeNotification} encodes exactly that.
 */

/** Lifecycle states, mirroring the REST schema's `Notification.state`. */
export type NotificationState =
    "pending" | "delivered" | "read" | "answered" | "dismissed";

/**
 * A notification as the client holds it: the live frame's fields, plus the
 * state the REST record adds (defaulted when a frame is all we have).
 */
export interface ClientNotification {
    id: string;
    kind: string;
    priority: string;
    title: string;
    body?: string;
    createdAt: string;
    requiresAnswer?: boolean;
    answer?: string;
    state: NotificationState;
}

/** How many notifications the client keeps in memory (newest first). */
export const NOTIFICATION_LIMIT = 50;

/**
 * Whether a state is final from the user's point of view.
 *
 * `pending` and `delivered` still want attention; the rest are done, and are
 * what {@link mergeNotification} refuses to overwrite.
 */
export function isSettled(state: NotificationState): boolean {
    return state === "read" || state === "answered" || state === "dismissed";
}

/**
 * Merges one notification into the list, newest first.
 *
 * A known id is replaced in place (the freshest content wins) **except** for a
 * settled state, which is preserved: a frame or a re-fetch must never resurrect
 * a notification the user has already read or dismissed. An unknown id is
 * inserted by `createdAt`, so a frame that raced the page fetch lands in the
 * right order rather than always on top.
 */
export function mergeNotification(
    list: ClientNotification[],
    incoming: ClientNotification,
): ClientNotification[] {
    const index = list.findIndex((existing) => existing.id === incoming.id);
    if (index === -1) {
        const merged = [...list, incoming].sort(byNewest);
        return merged.slice(0, NOTIFICATION_LIMIT);
    }
    const existing = list[index];
    const next = [...list];
    next[index] = {
        ...incoming,
        state: isSettled(existing.state) ? existing.state : incoming.state,
        // A settled answer is user data; a later frame cannot drop it.
        ...(existing.answer !== undefined ? { answer: existing.answer } : {}),
    };
    return next.sort(byNewest).slice(0, NOTIFICATION_LIMIT);
}

/**
 * Merges a fetched page into the local list.
 *
 * The page is authoritative for *content*; the local list may hold fresher
 * states (a dismissal that has not been re-fetched), which is why this is a
 * fold over {@link mergeNotification} rather than a replacement. Notifications
 * that exist locally but not in the page (dismissed ones are excluded from the
 * page) are kept, so a dismissal does not make the row vanish and reappear on
 * the next load.
 */
export function mergeNotificationPage(
    list: ClientNotification[],
    page: ClientNotification[],
): ClientNotification[] {
    return page
        .reduce((acc, incoming) => mergeNotification(acc, incoming), list)
        .sort(byNewest)
        .slice(0, NOTIFICATION_LIMIT);
}

/**
 * Locally settles one notification, returning the same list when the id is
 * unknown or already settled (so callers can skip a re-render).
 */
export function settleNotification(
    list: ClientNotification[],
    id: string,
    state: NotificationState,
    options: { answer?: string } = {},
): ClientNotification[] {
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) {
        return list;
    }
    const existing = list[index];
    if (isSettled(existing.state) && existing.state === state) {
        return list;
    }
    const next = [...list];
    next[index] = {
        ...existing,
        state,
        ...(options.answer !== undefined ? { answer: options.answer } : {}),
    };
    return next;
}

/**
 * The notification to surface prominently, or `null` when nothing wants
 * attention: the newest unsettled one.
 *
 * Phase 1 has exactly one channel (in-app), so "the newest unsettled" *is*
 * the banner rule. When priority-based routing arrives, this is the function
 * that gains the priority comparison — not the React layer.
 */
export function selectBanner(
    list: ClientNotification[],
): ClientNotification | null {
    return list.find((item) => !isSettled(item.state)) ?? null;
}

/**
 * A lifecycle state in plain language, for the list.
 *
 * The distinction that matters to a user asking "why did nothing pop up?" is
 * `pending` versus `delivered`: a pending notification was *recorded* while no
 * client was listening (or while quiet hours or the delivery budget held it
 * back), so it is waiting to be read rather than lost. Bare `pending` reads as
 * an error; this says what actually happened.
 */
export function describeNotificationState(state: NotificationState): string {
    switch (state) {
        case "pending":
            return "not announced — recorded while you were away";
        case "delivered":
            return "new";
        case "read":
            return "read";
        case "answered":
            return "answered";
        case "dismissed":
            return "dismissed";
    }
}

/** How many notifications are neither read nor dismissed (the badge count). */
export function unreadCount(list: ClientNotification[]): number {
    return list.filter((item) => !isSettled(item.state)).length;
}

/** Newest first by `createdAt`; equal timestamps keep insertion order. */
function byNewest(a: ClientNotification, b: ClientNotification): number {
    const left = Date.parse(a.createdAt);
    const right = Date.parse(b.createdAt);
    if (Number.isNaN(left) || Number.isNaN(right) || left === right) {
        return 0;
    }
    return right - left;
}
