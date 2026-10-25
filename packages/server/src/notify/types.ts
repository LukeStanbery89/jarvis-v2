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
    CodingAnswer,
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
    /**
     * The job this notification is about (#90 phase 5), when a producer has
     * one — the scheduler's announcement of a run. It is what lets a reminder
     * banner offer *snooze* rather than only *dismiss*: the row names the
     * reminder it came from instead of the client guessing from the title.
     */
    jobId?: string;
    /**
     * The coding job this notification asks a question about (#94), when the
     * answer should resume it.
     *
     * Distinct from {@link jobId}, which names a scheduler job: a coding job
     * lives in the sandbox ledger. The answer route resolves this link; the
     * client never has to send it back.
     */
    codingJobId?: string;
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
    /**
     * Needs a live in-app socket to deliver. The in-app channel does; a push
     * or email channel does not.
     */
    requiresPresence: boolean;
    /**
     * Only delivers when the user has **no** live socket. Web Push uses this
     * to avoid a second OS banner for a page that is already open; when the
     * socket is absent, the push is the only channel that can reach the phone.
     */
    onlyWhenAbsent: boolean;
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
    Pick<NotificationInput, "body" | "dedupeKey" | "jobId" | "codingJobId"> {
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
    // A coding-job id is a UUID-shaped token, not display text: bound it so a
    // caller cannot store an essay under a column the answer route trusts.
    const codingJobId = input.codingJobId?.trim();
    if (
        codingJobId !== undefined &&
        (codingJobId.length === 0 || codingJobId.length > 64)
    ) {
        throw new NotificationInputError(
            "codingJobId must be a non-empty string of at most 64 characters",
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
        ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
        ...(codingJobId !== undefined && codingJobId.length > 0
            ? { codingJobId }
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

/** The most structured answers one submission may carry (#180). */
const MAX_STRUCTURED_ANSWERS = 20;

/** The most choices one multiple-choice answer may carry. */
const MAX_STRUCTURED_VALUES = 20;

/** Longest question id accepted from a client. */
const MAX_QUESTION_ID_LENGTH = 128;

/**
 * Validates the structured answer half of an answer request (#180).
 *
 * Shape and bounds only: whether a question is required, whether an option id
 * exists, and whether **Other** is allowed are the coding service's checks,
 * because only it has the stored question set. A malformed body is a 400 here.
 *
 * @param answers - The `answers` array from the request.
 * @returns The normalized answers.
 */
export function validateStructuredAnswers(answers: unknown): CodingAnswer[] {
    if (!Array.isArray(answers) || answers.length === 0) {
        throw new NotificationInputError("answers must be a non-empty array");
    }
    if (answers.length > MAX_STRUCTURED_ANSWERS) {
        throw new NotificationInputError(
            `answers must have at most ${MAX_STRUCTURED_ANSWERS} entries`,
        );
    }
    return answers.map((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
            throw new NotificationInputError(
                `answers[${index}] must be an object`,
            );
        }
        const record = entry as {
            questionId?: unknown;
            value?: unknown;
            other?: unknown;
        };
        if (
            typeof record.questionId !== "string" ||
            record.questionId.trim().length === 0
        ) {
            throw new NotificationInputError(
                `answers[${index}].questionId must be a non-empty string`,
            );
        }
        const questionId = record.questionId.trim();
        if (questionId.length > MAX_QUESTION_ID_LENGTH) {
            throw new NotificationInputError(
                `answers[${index}].questionId is too long`,
            );
        }
        let value: string | string[];
        if (typeof record.value === "string") {
            if (record.value.length > MAX_NOTIFICATION_ANSWER_LENGTH) {
                throw new NotificationInputError(
                    `answers[${index}].value is too long`,
                );
            }
            value = record.value.trim();
        } else if (Array.isArray(record.value)) {
            if (record.value.length > MAX_STRUCTURED_VALUES) {
                throw new NotificationInputError(
                    `answers[${index}].value has too many choices`,
                );
            }
            value = record.value.map((choice, position) => {
                if (typeof choice !== "string") {
                    throw new NotificationInputError(
                        `answers[${index}].value[${position}] must be a string`,
                    );
                }
                if (choice.length > MAX_NOTIFICATION_ANSWER_LENGTH) {
                    throw new NotificationInputError(
                        `answers[${index}].value[${position}] is too long`,
                    );
                }
                return choice.trim();
            });
        } else {
            throw new NotificationInputError(
                `answers[${index}].value must be a string or an array of strings`,
            );
        }
        if (record.other !== undefined && typeof record.other !== "string") {
            throw new NotificationInputError(
                `answers[${index}].other must be a string`,
            );
        }
        if (
            typeof record.other === "string" &&
            record.other.length > MAX_NOTIFICATION_ANSWER_LENGTH
        ) {
            throw new NotificationInputError(
                `answers[${index}].other is too long`,
            );
        }
        return {
            questionId,
            value,
            ...(typeof record.other === "string"
                ? { other: record.other.trim() }
                : {}),
        };
    });
}

/**
 * Renders structured answers as the notification's short reply summary (#180).
 *
 * The full Q/A block lives on the job's question view; this is only what the
 * notification row keeps in its single `answer` field, so it is clamped to the
 * protocol's answer length.
 *
 * @param answers - The validated answers.
 * @returns One `questionId: value` line per answer, bounded.
 */
export function describeCodingAnswers(
    answers: readonly CodingAnswer[],
): string {
    return answers
        .map((answer) => {
            const value = Array.isArray(answer.value)
                ? answer.value.join(", ")
                : answer.value;
            const other =
                answer.other !== undefined && answer.other.trim().length > 0
                    ? ` (${answer.other.trim()})`
                    : "";
            return `${answer.questionId}: ${value}${other}`;
        })
        .join("\n")
        .slice(0, MAX_NOTIFICATION_ANSWER_LENGTH);
}
