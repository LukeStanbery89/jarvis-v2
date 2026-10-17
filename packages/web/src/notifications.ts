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
 *
 * The **delivery class** (#90) is carried through as well, because it decides
 * which surface a notification gets: a fired `timer` rings in a modal overlay
 * until it is stopped, a `reminder` waits as a banner, and everything else is
 * informational. {@link selectAlerts} is the single place that decision is
 * made, so the overlay and the banner can never disagree about which row is
 * the one demanding attention.
 */
import type {
    NotificationClass,
    NotificationFrame,
} from "@lukestanbery/jarvis-protocol";
import type { Notification } from "./api";
import { clockText, describeSpan } from "./clock";

export type { NotificationClass };

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
    /**
     * What kind of attention this asks for (#90), as the server decided it.
     * Carried into the client rather than inferred from `kind`, because the
     * ring/banner split must not depend on string-matching a producer's token.
     */
    class: NotificationClass;
    priority: string;
    title: string;
    body?: string;
    createdAt: string;
    requiresAnswer?: boolean;
    answer?: string;
    state: NotificationState;
    /**
     * The job this notification is about (#90), when a scheduler announcement
     * produced it — the id `GET /api/jobs/{id}` answers for.
     *
     * Carried so an action on a *reminder* has something to write to: snoozing
     * touches the job, not the notification row, and without the link the
     * client could only guess which reminder a banner was about.
     */
    jobId?: string;
}

/**
 * One live `notification` frame as the client stores it.
 *
 * A pushed notification is by definition delivered; the record may later say it
 * was read on another device, which the next fetch wins ({@link mergeNotification}
 * refuses to un-settle it). Pure and exported so class propagation is tested
 * here rather than inferred in the React hook.
 */
export function fromFrame(
    frame: NotificationFrame["notification"],
): ClientNotification {
    return {
        id: frame.id,
        kind: frame.kind,
        class: frame.class,
        priority: frame.priority,
        title: frame.title,
        ...(frame.body !== undefined ? { body: frame.body } : {}),
        createdAt: frame.createdAt,
        ...(frame.requiresAnswer === true ? { requiresAnswer: true } : {}),
        ...(frame.jobId !== undefined ? { jobId: frame.jobId } : {}),
        state: "delivered",
    };
}

/** One REST record as the client stores it (state and answer included). */
export function fromRecord(record: Notification): ClientNotification {
    return {
        id: record.id,
        kind: record.kind,
        class: record.class,
        priority: record.priority,
        title: record.title,
        ...(record.body !== undefined ? { body: record.body } : {}),
        createdAt: record.createdAt,
        ...(record.requiresAnswer === true ? { requiresAnswer: true } : {}),
        ...(record.answer !== undefined ? { answer: record.answer } : {}),
        ...(record.jobId !== undefined ? { jobId: record.jobId } : {}),
        state: record.state,
    };
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
 * Whether a notification is worth interrupting for (#90 phase 6b).
 *
 * Two cases, and the reasoning is the whole policy:
 *
 * - A **reminder** exists for a moment, so one that has arrived is exactly what
 *   the user asked to be told. It waits out quiet hours and it never rings,
 *   which leaves the badge — too quiet for something a person deliberately
 *   scheduled — so it toasts.
 * - A timer that **failed or was missed** is the one timer that does not ring
 *   (it has no moment to acknowledge) and it is still news: a countdown the user
 *   set did not happen.
 *
 * Everything else deliberately does not toast. An informational notification is
 * a record to read, and interrupting whatever page the user is on with it would
 * make every tool that says something a popup; it has the badge and the list.
 *
 * @param notification - The row, or the fields that decide (so a frame can be
 *   asked before it is stored).
 * @returns True when this row should reach the floating toast.
 */
export function shouldToast(
    notification: Pick<ClientNotification, "class" | "kind">,
): boolean {
    if (notification.class === "reminder") {
        return true;
    }
    if (notification.class !== "timer") {
        return false;
    }
    return (
        notification.kind === "job.failed" || notification.kind === "job.missed"
    );
}

/**
 * The row the floating toast shows, or `null` (#90 phase 6b).
 *
 * One at a time — the newest, because the list is newest-first by
 * {@link mergeNotification}'s contract and the toast is an interruption rather
 * than a list. Anything older is still in the notification list and still
 * counted by the badge.
 *
 * The account's master switch turns it off entirely: that switch means "do not
 * interrupt me", and a toast is an interruption. The records still exist and
 * still count; only the shouting stops.
 *
 * A ringing timer needs no exclusion here — it is structurally impossible for
 * one to qualify (only a fired `timer` rings, and only a failed or missed one
 * toasts), which the tests pin so the guarantee survives a change to either
 * rule.
 *
 * @param list - The client's notifications, newest first.
 * @param context - The account's master switch.
 * @returns The newest notification worth toasting, or `null`.
 */
export function selectToast(
    list: ClientNotification[],
    context: { enabled: boolean },
): ClientNotification | null {
    if (!context.enabled) {
        return null;
    }
    for (const item of list) {
        if (!isSettled(item.state) && shouldToast(item)) {
            return item;
        }
    }
    return null;
}

/**
 * How long a fired timer keeps the right to ring on next open.
 *
 * "Rings until acknowledged" is about the moment, not about a browser that was
 * closed for a week: a timer that fired within a day still greets the user with
 * the overlay (and says how late it is), while an older one stays unsettled in
 * the list so the record is never lost — it just does not start shouting when
 * the app opens.
 */
export const RING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Whether a notification asks for the ring overlay. */
export function isRinging(
    notification: ClientNotification,
    context: { enabled: boolean; now: Date },
): boolean {
    // The master switch silences everything, a timer included: a row that
    // reached this client through the list rather than a push was recorded
    // *because* the server's gates said "not now".
    if (!context.enabled) {
        return false;
    }
    if (notification.class !== "timer") {
        return false;
    }
    // Only a timer that actually fired is due. One that failed or was missed
    // belongs in the list: an overlay whose Stop button stops nothing would be
    // a lie about what the user is acknowledging.
    if (notification.kind !== "job.finished") {
        return false;
    }
    if (isSettled(notification.state)) {
        return false;
    }
    const createdAt = Date.parse(notification.createdAt);
    // An unreadable timestamp cannot be trusted to be "just now", and a timer
    // is an interruption: fail closed rather than ring for something unknowable.
    if (Number.isNaN(createdAt)) {
        return false;
    }
    return context.now.getTime() - createdAt <= RING_MAX_AGE_MS;
}

/** What wants attention right now: the ringing timer and the banner row. */
export interface AlertSelection {
    /** The fired timer that should be ringing, or `null`. */
    ring: ClientNotification | null;
    /** What the in-app banner shows — never the ring target as well. */
    banner: ClientNotification | null;
}

/**
 * Splits the list into what rings and what reads.
 *
 * The ring target is the **oldest** ringing timer, so two timers that fired
 * minutes apart queue: the one that has been waiting longest is acknowledged
 * first, and the next takes over when it is stopped. The banner is the newest
 * unsettled row that is not the ring target, so a firing timer appears in
 * exactly one place — the thing this split exists to guarantee.
 */
export function selectAlerts(
    list: ClientNotification[],
    context: { enabled: boolean; now: Date },
): AlertSelection {
    let ring: ClientNotification | null = null;
    for (const item of list) {
        if (!isRinging(item, context)) {
            continue;
        }
        if (
            ring === null ||
            Date.parse(item.createdAt) < Date.parse(ring.createdAt)
        ) {
            ring = item;
        }
    }
    const banner = selectBanner(
        ring === null ? list : list.filter((item) => item.id !== ring.id),
    );
    return { ring, banner };
}

/**
 * When the notification fired, in the user's own clock, plus how late it is:
 * `due at 2:20 AM` or `due at 2:20 AM, 3 minutes ago`.
 *
 * The instant is rendered in the browser's local zone — a notification's
 * `createdAt` is a real moment, so "when did this fire" is a local question
 * even though the server's scheduling rules use its own clock.
 */
export function describeDue(
    notification: Pick<ClientNotification, "createdAt">,
    now: Date,
): string {
    const at = new Date(notification.createdAt);
    if (Number.isNaN(at.getTime())) {
        return "due now";
    }
    const clock = clockText(at);
    const lateMs = now.getTime() - at.getTime();
    if (lateMs < 60_000) {
        return `due at ${clock}`;
    }
    return `due at ${clock}, ${describeSpan(lateMs)} ago`;
}

/**
 * The short label a notification shows above its title: what kind of thing it
 * is, plus how a scheduled one ended.
 *
 * The class is the server's decision and the outcome is the producer's `kind`,
 * so this is presentation only — but it is the line that makes a banner say
 * "Timer failed" rather than leaving the user to infer it from a body that
 * mentions a tool. Pure and exported for tests.
 */
export function describeNotice(
    notification: Pick<ClientNotification, "class" | "kind">,
): string {
    const outcome =
        notification.kind === "job.failed"
            ? "failed"
            : notification.kind === "job.missed"
              ? "missed"
              : null;
    const noun =
        notification.class === "timer"
            ? "Timer"
            : notification.class === "reminder"
              ? "Reminder"
              : "Notification";
    return outcome === null ? noun : `${noun} ${outcome}`;
}

/**
 * A lifecycle state in plain language, for the list.
 *
 * The distinction that matters to a user asking "why did nothing pop up?" is
 * `pending` versus `delivered`: a pending notification was *recorded* while no
 * announcement was pushed — because no client was listening, or because a gate
 * held it back (quiet hours, the delivery budget, the user's own switch). Which
 * of those it was is not stored on the record, so this says only what is true
 * in every case: it was recorded, and it was not announced. The old wording
 * named one cause ("while you were away") and was therefore wrong for the rest
 * — and quietly wrong copy is the exact failure this area exists to remove.
 * The gate that refused a push is reported to whoever raised it (the tool
 * result, the test button's outcome line).
 *
 * Bare `pending` reads as an error; this says what actually happened.
 */
export function describeNotificationState(state: NotificationState): string {
    switch (state) {
        case "pending":
            return "recorded — not announced";
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

/**
 * A delivery outcome in plain language, for the debug affordance.
 *
 * This is the sentence that ends the "nothing happened" ambiguity: it says
 * whether the server pushed the notification to a live client, and if not,
 * which gate held it — so a missing banner is attributable instead of
 * mysterious.
 */
export function describeDelivery(
    delivered: number,
    suppressed: NotificationSuppression | null,
): string {
    if (suppressed === null) {
        return `pushed to ${delivered} connected client${delivered === 1 ? "" : "s"}`;
    }
    switch (suppressed) {
        case "absent":
            return "recorded only — no client was connected at that moment";
        case "quiet-hours":
            return "held back by quiet hours (priority below high)";
        case "cap":
            return "held back by the per-minute delivery budget";
        case "disabled":
            return "held back — notifications are switched off for this account";
    }
}

/** The gates a delivery can be suppressed by, mirroring the REST schema. */
export type NotificationSuppression =
    "disabled" | "quiet-hours" | "absent" | "cap";

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
