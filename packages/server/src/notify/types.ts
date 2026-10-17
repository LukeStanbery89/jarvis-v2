/**
 * Notification types and the delivery-channel seam (#139 phase 1).
 *
 * The shapes here are the vocabulary the rest of the server speaks: a
 * producer (a tool, the scheduler, a background job) builds a
 * {@link NotificationInput}, the service turns it into a persisted
 * `AppNotification` in the auth package, and one or more
 * {@link NotificationChannel}s try to hand it to the user.
 *
 * The channel seam is deliberately narrow and *declarative*: a channel states
 * what it can do ({@link NotificationChannelCapabilities}) rather than being
 * asked, so a satellite speaker (audible, no screen), a phone (native push,
 * can reply), an email address (text, reply by link) and a desktop (all of the
 * above) all fit the same interface. Phase 1 ships exactly one implementation,
 * {@link createInAppChannel} — the seam exists now because the *shape* of the
 * router is the hard part, not the number of adapters.
 */
import type {
    AppNotification,
    NotificationPriority,
} from "@lukestanbery/jarvis-auth";
import {
    MAX_NOTIFICATION_ANSWER_LENGTH,
    MAX_NOTIFICATION_BODY_LENGTH,
    MAX_NOTIFICATION_KIND_LENGTH,
    MAX_NOTIFICATION_TITLE_LENGTH,
    NOTIFICATION_CLASSES,
} from "@lukestanbery/jarvis-protocol";
import type { NotificationClass } from "@lukestanbery/jarvis-protocol";

export type { AppNotification, NotificationClass, NotificationPriority };

/**
 * What a producer asks for when it raises a notification.
 *
 * Every string is bounded by the protocol's own limits
 * ({@link MAX_NOTIFICATION_TITLE_LENGTH} and friends) so a value that reaches
 * the store can always be put on the wire — a record the server cannot render
 * would be a record the client silently drops.
 */
export interface NotificationInput {
    /**
     * Producer-defined category ("job.finished", "reminder", …). Free-form so
     * a new feature needs no protocol change, bounded so it stays a token.
     */
    kind: string;
    /**
     * What kind of attention this asks for (#90); defaults to the quiet
     * `notification`.
     *
     * Set by the thing that was *asked for* — a scheduled reminder or timer —
     * never by the model: the class decides whether quiet hours may hold the
     * notification back, so exposing it to a tool would be a way to pierce
     * them by naming one.
     */
    class?: NotificationClass;
    /** How much this may disturb the user; defaults to `"normal"`. */
    priority?: NotificationPriority;
    /** One-line headline, already written for display. */
    title: string;
    /** Optional detail. */
    body?: string;
    /** Whether the user's reply (not an acknowledgement) retires this. */
    requiresAnswer?: boolean;
    /**
     * Coalescing key: while an unsettled notification with the same key
     * exists for the user, this one replaces it instead of stacking.
     */
    dedupeKey?: string;
}

/** What one delivery attempt achieved, for the caller and the tests. */
export interface NotifyOutcome {
    /** The persisted record, as stored (state is the store's, not the request's). */
    notification: AppNotification;
    /** How many live clients received it (0 when nobody was connected). */
    delivered: number;
    /**
     * Why delivery did not happen, when it did not. `null` means it was
     * delivered. Kept explicit rather than derived from `delivered === 0` so
     * a caller can tell "the user turned notifications off" from "nobody was
     * connected" — the two need different follow-ups.
     */
    suppressed: NotificationSuppression;
}

/** Why a notification was recorded but not pushed. */
export type NotificationSuppression =
    | null
    /** The user's `notify.enabled` pref is off. */
    | "disabled"
    /**
     * Inside the user's quiet hours, for a class that respects them — every
     * class but `timer`, which pierces (#90).
     */
    | "quiet-hours"
    /** Nobody had a live socket, so there was nothing to push to. */
    | "absent"
    /** The per-user delivery budget for this window was already spent. */
    | "cap";

/**
 * What a channel can do with a notification.
 *
 * Read by the (future) routing policy, not by phase 1's single-hub delivery,
 * so it is populated honestly per channel now rather than assumed.
 */
export interface NotificationChannelCapabilities {
    /** Can say it out loud. */
    canSpeak: boolean;
    /** Can display the text. */
    canShowText: boolean;
    /** Can display an image. */
    canShowImage: boolean;
    /** Can collect the user's reply to an answerable notification. */
    canAcceptReply: boolean;
    /** Belongs to one device (so it can be addressed) rather than a user. */
    isAddressable: boolean;
}

/** One way of reaching the user. */
export interface NotificationChannel {
    /** Stable id, used in logs and (later) routing config. */
    readonly id: string;
    readonly capabilities: NotificationChannelCapabilities;
    /**
     * Attempts delivery, returning how many recipients it reached.
     *
     * A channel never throws: a delivery failure is a failed delivery, not a
     * broken producer — the record is already persisted, and the next channel
     * (or the user's next list fetch) is the fallback.
     */
    deliver(notification: AppNotification): number | Promise<number>;
}

/**
 * Longest producer coalescing key.
 *
 * Mirrors the REST schema's bound (`NotificationInput.dedupeKey`); it is not a
 * protocol constant because the wire never carries it — it is bookkeeping
 * between a producer and the store, so the server owns the limit.
 */
const MAX_DEDUPE_KEY_LENGTH = 64;

/**
 * Rejected producer input: an over-long field, or an empty kind/title.
 *
 * Thrown rather than truncated, because a notification whose text was silently
 * cut short is a notification the producer did not write. The REST layer maps
 * it to a 400; a tool caller sees it as a failed tool call.
 */
export class NotificationInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NotificationInputError";
    }
}

/**
 * Validates producer input, returning the normalized request.
 *
 * Bounds mirror the protocol constants so anything accepted here can be
 * rendered by any client. Optional fields are normalized (absent, not empty
 * strings) so the store never holds two spellings of "nothing".
 */
export function normalizeNotificationInput(
    input: NotificationInput,
): Required<
    Pick<
        NotificationInput,
        "kind" | "class" | "priority" | "title" | "requiresAnswer"
    >
> &
    Pick<NotificationInput, "body" | "dedupeKey"> {
    const kind = input.kind?.trim() ?? "";
    const title = input.title?.trim() ?? "";
    const notificationClass = input.class ?? "notification";
    if (
        !(NOTIFICATION_CLASSES as readonly string[]).includes(notificationClass)
    ) {
        throw new NotificationInputError(
            `class must be one of ${NOTIFICATION_CLASSES.join(", ")}`,
        );
    }
    if (kind.length === 0) {
        throw new NotificationInputError("kind must be a non-empty string");
    }
    if (kind.length > MAX_NOTIFICATION_KIND_LENGTH) {
        throw new NotificationInputError(
            `kind must be at most ${MAX_NOTIFICATION_KIND_LENGTH} characters`,
        );
    }
    if (title.length === 0) {
        throw new NotificationInputError("title must be a non-empty string");
    }
    if (title.length > MAX_NOTIFICATION_TITLE_LENGTH) {
        throw new NotificationInputError(
            `title must be at most ${MAX_NOTIFICATION_TITLE_LENGTH} characters`,
        );
    }
    const body = input.body?.trim();
    if (body !== undefined && body.length > MAX_NOTIFICATION_BODY_LENGTH) {
        throw new NotificationInputError(
            `body must be at most ${MAX_NOTIFICATION_BODY_LENGTH} characters`,
        );
    }
    const dedupeKey = input.dedupeKey?.trim();
    if (dedupeKey !== undefined && dedupeKey.length > MAX_DEDUPE_KEY_LENGTH) {
        throw new NotificationInputError(
            `dedupeKey must be at most ${MAX_DEDUPE_KEY_LENGTH} characters`,
        );
    }
    return {
        kind,
        class: notificationClass,
        priority: input.priority ?? "normal",
        title,
        requiresAnswer: input.requiresAnswer === true,
        ...(body !== undefined && body.length > 0 ? { body } : {}),
        ...(dedupeKey !== undefined && dedupeKey.length > 0
            ? { dedupeKey }
            : {}),
    };
}

/** Bounds an answer the way {@link normalizeNotificationInput} bounds a title. */
export function validateAnswer(answer: unknown): string {
    if (typeof answer !== "string" || answer.trim().length === 0) {
        throw new NotificationInputError("answer must be a non-empty string");
    }
    const trimmed = answer.trim();
    if (trimmed.length > MAX_NOTIFICATION_ANSWER_LENGTH) {
        throw new NotificationInputError(
            `answer must be at most ${MAX_NOTIFICATION_ANSWER_LENGTH} characters`,
        );
    }
    return trimmed;
}
