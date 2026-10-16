/**
 * The notification service (#139 phase 1): record, then route.
 *
 * One entry point for producers (`notify`), one for the REST layer
 * (`list`/`markRead`/`dismiss`/`answer`), and one place where the *policy*
 * lives — presence-first delivery, quiet hours, and the per-user delivery
 * budget. Everything else in the pipeline is mechanism: the auth package owns
 * the rows, the hub owns the sockets, a channel owns one way of reaching a
 * person.
 *
 * Policy, in the order it applies (each step can only make delivery quieter):
 *
 * 1. **The user's own switch.** `notify.enabled: false` records the
 *    notification and pushes nothing. A user who turned notifications off
 *    still finds them in the list, so nothing is lost — this is "don't
 *    interrupt me", not "don't tell me".
 * 2. **Quiet hours.** Inside `notify.quietHours` a `low` or `normal`
 *    notification waits; `high` and `urgent` go through. Quiet hours are
 *    evaluated in the **server's local time** — JARVIS is a home server that
 *    normally shares its user's clock — with a per-user timezone noted as
 *    future work.
 * 3. **Presence.** Nobody connected means nothing to push to, so the
 *    notification is left `pending` for the next list fetch and the delivery
 *    budget is not spent on it.
 * 4. **The delivery budget.** A per-user, per-minute cap on pushes, so a
 *    broken producer cannot turn a chat client into a firehose. Over budget
 *    is again `pending`, not dropped: the record survives, the interruption
 *    does not.
 *
 * Consequence worth naming: `pending` is not an error state. It is the normal
 * outcome for an offline user, and `deliveredAt` on a record is therefore a
 * signal about *interruption*, never about whether the user will see it.
 */
import { randomBytes } from "node:crypto";
import type {
    AppNotification,
    NotificationLedger,
    NotificationPriority,
} from "@lukestanbery/jarvis-auth";
import { FixedWindowQuota } from "../rate/fixedWindowQuota";
import { logger } from "../logger";
import type {
    NotificationChannel,
    NotificationInput,
    NotifyOutcome,
    NotificationSuppression,
} from "./types";
import { normalizeNotificationInput, validateAnswer } from "./types";
import type { NotificationHub } from "./hub";

/** Pref keys this service reads. Undocumented keys are ignored. */
export const NOTIFY_ENABLED_PREF = "notify.enabled";
export const NOTIFY_QUIET_HOURS_PREF = "notify.quietHours";

/** How the service is configured for this process. */
export interface NotificationServiceOptions {
    store: NotificationLedger & {
        /** Reads the user's prefs (the auth app database provides both). */
        getPrefs(userId: number): Record<string, unknown>;
    };
    hub: NotificationHub;
    /** Channels to attempt, in order. Phase 1: the in-app push alone. */
    channels: NotificationChannel[];
    /** Ceiling on the user's stored notifications; oldest settled go first. */
    maxPerUser: number;
    /** Pushes allowed per user per window. */
    deliveriesPerWindow: number;
    /** Injectable clock, so quiet hours and the budget window are testable. */
    now?: () => Date;
}

/** A quiet-hours window in the server's local time, `"HH:MM"` to `"HH:MM"`. */
interface QuietHours {
    start: string;
    end: string;
}

/** The result of a state-changing call, so the route can answer precisely. */
export type SettlementResult =
    | { ok: true; notification: AppNotification }
    | { ok: false; reason: "missing" | "not-answerable" | "settled" };

/** The notification service. */
export interface NotificationService {
    /** Records a notification and attempts delivery. */
    notify(userId: number, input: NotificationInput): Promise<NotifyOutcome>;
    /** A page of the user's notifications, plus the unread count for a badge. */
    list(
        userId: number,
        options?: { limit?: number; includeDismissed?: boolean },
    ): { notifications: AppNotification[]; unread: number };
    /** Marks a notification read (from any unsettled state). */
    markRead(userId: number, id: string): SettlementResult;
    /** Dismisses a notification without reading it. */
    dismiss(userId: number, id: string): SettlementResult;
    /** Answers an answerable notification: a hybrid of read and dismissed. */
    answer(userId: number, id: string, answer: unknown): SettlementResult;
}

/**
 * Builds the service.
 *
 * The delivery budget is a {@link FixedWindowQuota} rather than the credential
 * `RateLimiter`: the failure mode here is *successful* work that must stay
 * counted (see the rate-limiting section of the package README), which is the
 * quota primitive's shape and the opposite of admit-then-clear.
 */
export function createNotificationService(
    options: NotificationServiceOptions,
): NotificationService {
    const { store, hub, channels, maxPerUser, deliveriesPerWindow } = options;
    const now = options.now ?? (() => new Date());
    const deliveryQuota = new FixedWindowQuota(deliveriesPerWindow);

    const settle = (
        userId: number,
        id: string,
        state: "read" | "dismissed",
    ): SettlementResult => {
        const existing = store.getNotification(userId, id);
        if (existing === null) {
            return { ok: false, reason: "missing" };
        }
        if (isTerminal(existing)) {
            // Already settled — idempotent, and the caller gets the row it
            // asked about rather than an error for something that is done.
            return { ok: true, notification: existing };
        }
        const updated = store.setNotificationState(userId, id, state);
        return updated === null
            ? { ok: false, reason: "missing" }
            : { ok: true, notification: updated };
    };

    return {
        async notify(
            userId: number,
            input: NotificationInput,
        ): Promise<NotifyOutcome> {
            const normalized = normalizeNotificationInput(input);
            const at = now();
            // Coalesce first: a superseded notification must be out of the way
            // before the new one lands, or the list shows both for a moment.
            if (normalized.dedupeKey !== undefined) {
                supersedeDedupeKey(store, userId, normalized.dedupeKey);
            }
            const record = store.createNotification(userId, {
                ...normalized,
                id: randomBytes(18).toString("base64url"),
                createdAt: at.toISOString(),
            });
            // Housekeeping happens once, on the way in: the ceiling is about
            // the table's size, not about this notification's fate, and a
            // notification that never gets delivered is exactly the one a
            // later prune must not be able to evict first. Only settled rows
            // are eligible.
            const pruned = prune(store, userId, maxPerUser);
            if (pruned > 0) {
                logger.debug(
                    `pruned ${pruned} settled notification(s) for user ${userId}`,
                );
            }

            const suppression = suppressionFor(store, userId, normalized, at);
            if (suppression !== null) {
                logger.debug(
                    `notification ${record.id} recorded but not delivered (${suppression})`,
                );
                return {
                    notification: record,
                    delivered: 0,
                    suppressed: suppression,
                };
            }

            if (!hub.isPresent(userId)) {
                return {
                    notification: record,
                    delivered: 0,
                    suppressed: "absent",
                };
            }

            if (!deliveryQuota.tryAcquire(userId).ok) {
                logger.warn(
                    `notification delivery budget reached for user ${userId}; recorded as pending`,
                );
                return {
                    notification: record,
                    delivered: 0,
                    suppressed: "cap",
                };
            }

            let delivered = 0;
            for (const channel of channels) {
                if (
                    normalized.requiresAnswer &&
                    !channel.capabilities.canAcceptReply
                ) {
                    continue;
                }
                delivered += await channel.deliver(record);
            }
            if (delivered === 0) {
                // A channel was asked and nobody took it (a socket closed
                // between the presence check and the write). Same outcome as
                // "absent", so report it the same way.
                return {
                    notification: record,
                    delivered: 0,
                    suppressed: "absent",
                };
            }
            const deliveredRecord =
                store.setNotificationState(userId, record.id, "delivered") ??
                record;
            return {
                notification: deliveredRecord,
                delivered,
                suppressed: null,
            };
        },

        list(
            userId: number,
            listOptions: { limit?: number; includeDismissed?: boolean } = {},
        ) {
            return {
                notifications: store.listNotifications(userId, listOptions),
                unread: store.countUnreadNotifications(userId),
            };
        },

        markRead(userId: number, id: string): SettlementResult {
            return settle(userId, id, "read");
        },

        dismiss(userId: number, id: string): SettlementResult {
            return settle(userId, id, "dismissed");
        },

        answer(userId: number, id: string, answer: unknown): SettlementResult {
            const existing = store.getNotification(userId, id);
            if (existing === null) {
                return { ok: false, reason: "missing" };
            }
            if (!existing.requiresAnswer) {
                return { ok: false, reason: "not-answerable" };
            }
            if (isTerminal(existing)) {
                return { ok: false, reason: "settled" };
            }
            const text = validateAnswer(answer);
            const updated = store.setNotificationState(userId, id, "answered", {
                answer: text,
            });
            return updated === null
                ? { ok: false, reason: "missing" }
                : { ok: true, notification: updated };
        },
    };
}

/**
 * Retires the notifications a new one is replacing (its `dedupeKey`).
 *
 * The superseded row is **dismissed, not deleted**: the user may already have
 * seen it, and a notification that silently vanished from history would be
 * worse than one that says it was replaced. Only unsettled rows count as
 * supersedable — a notification the user has already read or answered is
 * history, and a producer re-raising the same key is not asking to have it
 * retracted.
 *
 * The scan is bounded by the list page rather than an index: a producer's key
 * is only ever matched against recent notifications, and adding a partial
 * index over an unsettled predicate would cost schema for a lookup this size.
 */
function supersedeDedupeKey(
    store: NotificationLedger,
    userId: number,
    dedupeKey: string,
): void {
    for (const existing of store.listNotifications(userId)) {
        if (existing.dedupeKey !== dedupeKey) {
            continue;
        }
        if (existing.state !== "pending" && existing.state !== "delivered") {
            continue;
        }
        store.setNotificationState(userId, existing.id, "dismissed");
    }
}

/**
 * Whether the notification's authority is already spent.
 *
 * `read` and `dismissed` are the user's own acts; `answered` is a reply. All
 * three are terminal, and the store refuses to move a row out of them, so this
 * predicate exists to answer "did you already settle this?" before the store
 * has to.
 */
function isTerminal(notification: AppNotification): boolean {
    return (
        notification.state === "read" ||
        notification.state === "dismissed" ||
        notification.state === "answered"
    );
}

/**
 * The quiet path, evaluated before any channel is consulted.
 *
 * Returns the reason delivery is suppressed, or `null` when the notification
 * may go out. Reads prefs defensively: an unparseable value is ignored rather
 * than fatal, so a hand-edited pref cannot silently stop all notifications —
 * except `notify.enabled: false`, which is a literal and therefore honoured.
 */
function suppressionFor(
    store: { getPrefs(userId: number): Record<string, unknown> },
    userId: number,
    normalized: { priority: NotificationPriority },
    at: Date,
): NotificationSuppression {
    const prefs = safePrefs(store, userId);
    if (prefs[NOTIFY_ENABLED_PREF] === false) {
        return "disabled";
    }
    if (!priorityRespectsQuietHours(normalized.priority)) {
        return null;
    }
    const quietHours = parseQuietHours(prefs[NOTIFY_QUIET_HOURS_PREF]);
    if (quietHours !== null && withinQuietHours(quietHours, at)) {
        return "quiet-hours";
    }
    return null;
}

/** Highest priority still suppressed by quiet hours. */
const QUIET_HOURS_CEILING: readonly NotificationPriority[] = ["low", "normal"];

/**
 * Whether this priority is subject to quiet hours.
 *
 * A rank comparison (not an equality check) so a priority added to the
 * protocol between `low` and `urgent` inherits the sensible behaviour rather
 * than silently becoming unsuppressable.
 */
function priorityRespectsQuietHours(priority: NotificationPriority): boolean {
    return QUIET_HOURS_CEILING.includes(priority);
}

/** Reads prefs, treating an unexpected store failure as "no prefs set". */
function safePrefs(
    store: { getPrefs(userId: number): Record<string, unknown> },
    userId: number,
): Record<string, unknown> {
    try {
        return store.getPrefs(userId);
    } catch (err) {
        logger.warn(
            `could not read notification prefs for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {};
    }
}

/**
 * Parses a quiet-hours pref: `{ start: "22:00", end: "07:30" }`.
 *
 * Returns `null` for anything unrecognized — a malformed window must not
 * silence the user for the rest of the day, so the failure direction is
 * "no quiet hours".
 */
function parseQuietHours(value: unknown): QuietHours | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const { start, end } = value as { start?: unknown; end?: unknown };
    if (!isClockTime(start) || !isClockTime(end)) {
        return null;
    }
    if (start === end) {
        // A zero-length window is meaningless; treat it as "not configured"
        // rather than as "always quiet".
        return null;
    }
    return { start, end };
}

/** True for a `"HH:MM"` 24-hour clock string. */
function isClockTime(value: unknown): value is string {
    return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * Whether `at` falls in the window, handling the wrap-past-midnight case.
 *
 * `22:00`–`07:00` is the common shape and spans midnight, so the comparison is
 * a wrap check (`at >= start || at < end`) when `start > end`, and a plain
 * range when it does not (`12:00`–`13:00`).
 */
function withinQuietHours(window: QuietHours, at: Date): boolean {
    const minutes = at.getHours() * 60 + at.getMinutes();
    const start = clockMinutes(window.start);
    const end = clockMinutes(window.end);
    return start < end
        ? minutes >= start && minutes < end
        : minutes >= start || minutes < end;
}

/** `"HH:MM"` → minutes past midnight. */
function clockMinutes(value: string): number {
    const [hours, minutes] = value.split(":");
    return Number(hours) * 60 + Number(minutes);
}

/**
 * Trims a user's settled notifications to `maxPerUser`.
 *
 * Only settled rows are eligible: an undelivered notification is something the
 * user has not seen yet, and dropping it to save space would lose exactly the
 * thing the store exists for.
 */
function prune(
    store: NotificationLedger,
    userId: number,
    maxPerUser: number,
): number {
    return store.pruneNotifications(userId, maxPerUser);
}
