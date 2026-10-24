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
import { NOTIFICATION_TERMINAL_STATES } from "@lukestanbery/jarvis-auth";
import type {
    AppNotification,
    NotificationLedger,
} from "@lukestanbery/jarvis-auth";
import { FixedWindowQuota } from "../rate/fixedWindowQuota";
import { logger } from "../logger";
import type {
    NotificationChannel,
    NotificationClass,
    NotificationInput,
    NotifyOutcome,
    NotificationSuppression,
} from "./types";
import { normalizeNotificationInput, validateAnswer } from "./types";
import type { NotificationHub } from "./hub";
import { NOTIFY_ENABLED_PREF, quietHoursHold } from "./prefs";

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

/** The result of a state-changing call, so the route can answer precisely. */
export type SettlementResult =
    | { ok: true; notification: AppNotification }
    | { ok: false; reason: "missing" | "not-answerable" | "settled" };

/** The notification service. */
export interface NotificationService {
    /** Records a notification and attempts delivery. */
    notify(userId: number, input: NotificationInput): Promise<NotifyOutcome>;
    /**
     * One notification, or `null` for a missing or foreign id.
     *
     * The answer route reads it before settling: the coding-job link lives on
     * the record, and a client only sends the id and the reply.
     */
    get(userId: number, id: string): AppNotification | null;
    /** A page of the user's notifications, plus the unread count for a badge. */
    list(
        userId: number,
        options?: { limit?: number },
    ): { notifications: AppNotification[]; unread: number };
    /** Marks a notification read (from any unsettled state). */
    markRead(userId: number, id: string): SettlementResult;
    /**
     * Dismisses a notification without reading it — which **deletes** it (#90
     * phase 9c).
     *
     * The row comes back as it was, so a caller can say what it took away; the
     * length of time a dismissal was a state (a tombstone in the list) was a
     * phase-1 choice, and a row the user is finished with is a row nobody needs.
     */
    dismiss(userId: number, id: string): SettlementResult;
    /** Answers an answerable notification: a hybrid of read and dismissed. */
    answer(userId: number, id: string, answer: unknown): SettlementResult;
    /**
     * Retires the question notifications linked to a coding job (#94).
     *
     * Called when the job resumes, whichever channel answered it: the GitHub
     * comment path and the chat tool do not pass through the REST answer route,
     * so without this the in-app row would keep asking a question the job has
     * already moved past. `read` rather than `answered` because no answer text
     * reached this record — the reply lives where it was written.
     *
     * @param userId - The job's owner.
     * @param codingJobId - The job that resumed.
     * @param options.exceptId - A row to leave alone (the REST answer's own).
     * @returns How many rows were settled.
     */
    settleCodingQuestion(
        userId: number,
        codingJobId: string,
        options?: { exceptId?: string },
    ): number;
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

    const settle = (userId: number, id: string): SettlementResult => {
        const existing = store.getNotification(userId, id);
        if (existing === null) {
            return { ok: false, reason: "missing" };
        }
        if (isTerminal(existing)) {
            // Already settled — idempotent, and the caller gets the row it
            // asked about rather than an error for something that is done.
            return { ok: true, notification: existing };
        }
        const updated = store.setNotificationState(userId, id, "read");
        return updated === null
            ? { ok: false, reason: "missing" }
            : { ok: true, notification: updated };
    };

    return {
        get(userId: number, id: string): AppNotification | null {
            return store.getNotification(userId, id);
        },

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
            // the table's size, not about this notification's fate. Settled
            // rows are evicted first, so an undelivered notification is the
            // last thing a prune takes — but it is not exempt, because a
            // client that is repeatedly offline would otherwise grow the table
            // without bound (see `pruneNotifications`).
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

            // Charged before the channels run, so the budget bounds delivery
            // *attempts*: a socket that closes between the presence check and
            // the write still costs a token. That is the conservative
            // direction — the budget exists to bound interruptions, and an
            // attempt is one.
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

        list(userId: number, listOptions: { limit?: number } = {}) {
            return {
                notifications: store.listNotifications(userId, listOptions),
                unread: store.countUnreadNotifications(userId),
            };
        },

        markRead(userId: number, id: string): SettlementResult {
            return settle(userId, id);
        },

        dismiss(userId: number, id: string): SettlementResult {
            // Deleting is idempotent in the way a settlement is not: a row that
            // is already gone is exactly what the caller asked for, so a repeat
            // dismissal is `missing` rather than an error about a settled row.
            const removed = store.deleteNotification(userId, id);
            return removed === null
                ? { ok: false, reason: "missing" }
                : { ok: true, notification: removed };
        },

        settleCodingQuestion(
            userId: number,
            codingJobId: string,
            options: { exceptId?: string } = {},
        ): number {
            return store.settleCodingQuestionNotifications(
                userId,
                codingJobId,
                options.exceptId ?? null,
                now().toISOString(),
            );
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
 * One live row per key is the whole point — a series that repeats every minute
 * must not stack a thousand rows (#90 phase 9a) — so the superseded row is
 * **deleted**, which is also what dismissing it would now do (#90 phase 9c).
 * Only unsettled rows count as supersedable: a notification the user has already
 * read or answered is history, and a producer re-raising the same key is not
 * asking to have it retracted.
 *
 * The scan is bounded by the list page rather than an index: a producer's key
 * is only ever matched against recent notifications, and adding a partial index
 * over an unsettled predicate would cost schema for a lookup this size.
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
        store.deleteNotification(userId, existing.id);
    }
}

/**
 * Whether the notification's authority is already spent.
 *
 * The list is the ledger's own ({@link NOTIFICATION_TERMINAL_STATES}) rather than
 * a second opinion kept here: the store refuses to move a row out of a terminal
 * state, so this predicate only exists to answer "did you already settle this?"
 * *before* the store has to — and a local copy had already drifted, missing
 * `snoozed`, which let an answer to a deferred reminder look recorded when the
 * store had quietly refused it.
 */
function isTerminal(notification: AppNotification): boolean {
    return (NOTIFICATION_TERMINAL_STATES as readonly string[]).includes(
        notification.state,
    );
}

/**
 * The quiet path, evaluated before any channel is consulted.
 *
 * Returns the reason delivery is suppressed, or `null` when the notification
 * may go out. Reads prefs defensively: an unparseable value is ignored rather
 * than fatal, so a hand-edited pref cannot silently stop all notifications —
 * except `notify.enabled: false`, which is a literal and therefore honoured.
 *
 * **The class decides quiet hours, and nothing else does** (#90). A `timer`
 * pierces them: it is the class the user chose for a moment they chose, and a
 * timer that waits until morning is not a timer. Every other class waits —
 * including a *prioritised* one — because two fields answering "may this
 * interrupt" is two ways to be wrong, and the priority is model-chosen on the
 * `sendNotification` path (which is how an assistant used to be able to pierce
 * quiet hours by naming `urgent`). Priority keeps ordering and emphasis; the
 * class keeps the policy.
 *
 * A timer does **not** pierce the master switch. `notify.enabled: false` is a
 * kill switch the user threw, and a class named by a producer must not be a
 * way around it — the flow that schedules a timer warns when it is off, so the
 * silence is announced at the moment of scheduling rather than discovered at
 * the moment of ringing.
 */
function suppressionFor(
    store: { getPrefs(userId: number): Record<string, unknown> },
    userId: number,
    normalized: { class: NotificationClass },
    at: Date,
): NotificationSuppression {
    const prefs = safePrefs(store, userId);
    if (prefs[NOTIFY_ENABLED_PREF] === false) {
        return "disabled";
    }
    if (normalized.class === "timer") {
        return null;
    }
    // One home for the window arithmetic and for which class is exempt
    // (`prefs.ts`), because the scheduler asks the same question when it decides
    // whether a reminder should defer itself out of the window.
    if (quietHoursHold(prefs, normalized.class, at)) {
        return "quiet-hours";
    }
    return null;
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
 * Whether `at` falls in the window, handling the wrap-past-midnight case.
 *
 * `22:00`–`07:00` is the common shape and spans midnight, so the comparison is
 * a wrap check (`at >= start || at < end`) when `start > end`, and a plain
 * range when it does not (`12:00`–`13:00`).
 */
/**
 * Trims a user's notifications to `maxPerUser`.
 *
 * Prefers settled rows, which is what makes the common case lossless — but the
 * ceiling applies to the table (see the ledger's `pruneNotifications`), since
 * the rows that pile up most easily are the `pending` ones nobody was online
 * to receive.
 */
function prune(
    store: NotificationLedger,
    userId: number,
    maxPerUser: number,
): number {
    return store.pruneNotifications(userId, maxPerUser);
}
