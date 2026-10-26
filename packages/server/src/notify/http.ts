/**
 * REST surface for notifications (#139): `/api/notifications`.
 *
 * Mounted at `/api` by `createApp` **only when a notification service is
 * wired** — the same "present only when the surface exists" posture as the
 * attachment routes, so a deployment with `JARVIS_NOTIFY=off` has no endpoint
 * at all rather than one that quietly does nothing.
 *
 * Auth mirrors the management API exactly: `requireAuth` (device token *or*
 * cookie session) on every route, `requireCsrf` on the state-changing ones
 * (a no-op for bearer callers, load-bearing for cookies — see
 * `middleware.ts`). The cookie provider is constructed here rather than shared
 * with `authRoutes`, which is safe because it is a stateless view over the same
 * `web_sessions` ledger; the two routers must agree on the TTL, which both
 * take from `appConfig.sessionTtlMs`.
 *
 * Every route is scoped to the caller: a notification id that belongs to
 * somebody else is indistinguishable from one that does not exist (404), which
 * is why there is no ownership check to forget.
 */
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import {
    createCookieSessionProvider,
    NOTIFICATION_CLASSES,
    NOTIFICATION_PRIORITIES,
} from "@lukestanbery/jarvis-auth";
import type {
    AppDatabase,
    AppNotification,
    CodingAnswer,
} from "@lukestanbery/jarvis-auth";
import { MAX_NOTIFICATION_ID_LENGTH } from "@lukestanbery/jarvis-protocol";
import { authed, requireAuth, requireCsrf } from "../http/middleware";
import { parseLimit } from "../http/params";
import { sessionCookieName } from "../http/cookies";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import {
    describeCodingAnswers,
    NotificationInputError,
    validateAnswer,
    validateStructuredAnswers,
} from "./types";
import type { NotificationService, SettlementResult } from "./service";

/**
 * Called before an answerable notification is settled.
 *
 * The answer has a consumer when the record names a coding job: the reply must
 * resume it. Running the consumer **before** the settlement keeps the two
 * facts in the right order — a job that could not be resumed leaves the
 * notification unanswered, so the user can retry rather than reading
 * "answered" over a job that is still parked. The route knows nothing about
 * coding jobs; the composition root supplies this.
 */
export type NotificationAnswer =
    | { kind: "text"; text: string }
    | { kind: "structured"; answers: readonly CodingAnswer[] };

export type NotificationAnswerHandler = (
    userId: number,
    notification: AppNotification,
    answer: NotificationAnswer,
) =>
    | { ok: true }
    | { ok: false; reason: string }
    | Promise<{ ok: true } | { ok: false; reason: string }>;

/** Default page size for a list call. */
const DEFAULT_LIMIT = 50;
/** Largest page a caller may ask for. */
const MAX_LIMIT = 200;

/**
 * The notification as the REST surface exposes it.
 *
 * Same shape as the stored record minus `userId` — the caller is the user, so
 * echoing their own id back is noise — and minus `dedupeKey`, which is a
 * producer's bookkeeping, not the user's business.
 */
export interface NotificationResponse {
    id: string;
    kind: string;
    class: string;
    priority: string;
    title: string;
    body?: string;
    state: string;
    requiresAnswer?: boolean;
    answer?: string;
    /**
     * The job this notification is about (#90 phase 5), when there is one. A
     * page uses it to act on the notification's subject — a reminder's snooze
     * — rather than on the notification itself.
     */
    jobId?: string;
    /** The coding job an answer resumes (#94), when the notification asks. */
    codingJobId?: string;
    createdAt: string;
    deliveredAt?: string;
    settledAt?: string;
}

/** Maps a stored notification onto the wire shape (absent keys stay absent). */
export function toNotificationResponse(
    notification: AppNotification,
): NotificationResponse {
    return {
        id: notification.id,
        kind: notification.kind,
        class: notification.class,
        priority: notification.priority,
        title: notification.title,
        ...(notification.body !== null ? { body: notification.body } : {}),
        state: notification.state,
        ...(notification.requiresAnswer ? { requiresAnswer: true } : {}),
        ...(notification.answer !== null
            ? { answer: notification.answer }
            : {}),
        ...(notification.jobId !== null ? { jobId: notification.jobId } : {}),
        ...(notification.codingJobId !== null
            ? { codingJobId: notification.codingJobId }
            : {}),
        createdAt: notification.createdAt,
        ...(notification.deliveredAt !== null
            ? { deliveredAt: notification.deliveredAt }
            : {}),
        ...(notification.settledAt !== null
            ? { settledAt: notification.settledAt }
            : {}),
    };
}

/**
 * Builds the notifications router.
 *
 * @param store - The app database, for the auth middleware's token/cookie
 * resolution (the notification rows themselves go through `service`).
 * @param service - The notification service: policy lives there, not here.
 * @param appConfig - Configuration, for the cookie-session TTL and TLS posture.
 */
export function createNotificationRouter(
    store: AppDatabase,
    service: NotificationService,
    appConfig: AppConfig,
    onAnswer?: NotificationAnswerHandler,
): Router {
    const router = Router();
    const secure = Boolean(appConfig.tlsCertPath && appConfig.tlsKeyPath);
    const authenticated = requireAuth(store, {
        provider: createCookieSessionProvider(store, {
            ttlMs: appConfig.sessionTtlMs,
        }),
        cookieName: sessionCookieName(secure),
    });

    /** The uniform outermost try/catch, as in `authRoutes`. */
    const route =
        (
            handler: (req: Request, res: Response) => Promise<void> | void,
        ): RequestHandler =>
        (req, res) => {
            void Promise.resolve()
                .then(() => handler(req, res))
                .catch((err) => handleError(res, err));
        };

    /** Answers a settlement result, or the status its refusal implies. */
    const sendSettlement = (res: Response, result: SettlementResult): void => {
        if (result.ok) {
            res.status(200).json({
                notification: toNotificationResponse(result.notification),
            });
            return;
        }
        if (result.reason === "missing") {
            res.status(404).json({ error: "notification not found" });
            return;
        }
        if (result.reason === "not-answerable") {
            res.status(400).json({
                error: "notification does not require an answer",
            });
            return;
        }
        res.status(409).json({ error: "notification is already settled" });
    };

    router.get(
        "/notifications",
        authenticated,
        route((req, res) => {
            const jarv = authed(req).jarv;
            const { notifications, unread } = service.list(jarv.user.id, {
                limit: parseLimit(req.query.limit, {
                    fallback: DEFAULT_LIMIT,
                    max: MAX_LIMIT,
                }),
                // #194: a timer notification belongs to the device that set
                // it. A bearer caller names that device; a cookie session has
                // no device and sees only account-wide rows.
                deviceId: jarv.kind === "authed" ? jarv.device.id : null,
            });
            res.status(200).json({
                notifications: notifications.map(toNotificationResponse),
                unread,
            });
        }),
    );

    router.post(
        "/notifications",
        authenticated,
        requireCsrf,
        route(async (req, res) => {
            const jarv = authed(req).jarv;
            const outcome = await service.notify(
                jarv.user.id,
                notificationInputFrom(req.body),
            );
            res.status(201).json({
                notification: toNotificationResponse(outcome.notification),
                delivered: outcome.delivered,
                suppressed: outcome.suppressed,
            });
        }),
    );

    router.post(
        "/notifications/:id/read",
        authenticated,
        requireCsrf,
        route((req, res) => {
            const jarv = authed(req).jarv;
            sendSettlement(
                res,
                service.markRead(jarv.user.id, notificationId(req.params.id)),
            );
        }),
    );

    router.post(
        "/notifications/:id/dismiss",
        authenticated,
        requireCsrf,
        route((req, res) => {
            const jarv = authed(req).jarv;
            sendSettlement(
                res,
                service.dismiss(jarv.user.id, notificationId(req.params.id)),
            );
        }),
    );

    router.post(
        "/notifications/:id/answer",
        authenticated,
        requireCsrf,
        route(async (req, res) => {
            const jarv = authed(req).jarv;
            const id = notificationId(req.params.id);
            const body = req.body as
                { answer?: unknown; answers?: unknown } | undefined;
            const answer: NotificationAnswer = Array.isArray(body?.answers)
                ? {
                      kind: "structured",
                      answers: validateStructuredAnswers(body.answers),
                  }
                : { kind: "text", text: validateAnswer(body?.answer) };
            const answerText =
                answer.kind === "structured"
                    ? describeCodingAnswers(answer.answers)
                    : answer.text;
            const existing = service.get(jarv.user.id, id);
            if (existing === null) {
                res.status(404).json({ error: "notification not found" });
                return;
            }
            if (!existing.requiresAnswer) {
                res.status(400).json({
                    error: "notification does not require an answer",
                });
                return;
            }
            if (isSettled(existing)) {
                res.status(409).json({
                    error: "notification is already settled",
                });
                return;
            }
            // The consumer runs first: a job that cannot be resumed must leave
            // the notification unanswered, or the user would read "answered"
            // over a job that never started.
            if (existing.codingJobId !== null && onAnswer !== undefined) {
                const outcome = await onAnswer(jarv.user.id, existing, answer);
                if (!outcome.ok) {
                    res.status(409).json({ error: outcome.reason });
                    return;
                }
            }
            sendSettlement(res, service.answer(jarv.user.id, id, answerText));
        }),
    );

    return router;
}

/**
 * Validates the create body.
 *
 * Field-level bounds are `NotificationInputError`s (a 400 with the reason),
 * because a producer sending an unrenderable title should be told which field
 * is wrong rather than get a generic failure.
 */
function notificationInputFrom(body: unknown): {
    kind: string;
    class?: AppNotification["class"];
    priority?: AppNotification["priority"];
    title: string;
    body?: string;
    requiresAnswer?: boolean;
    dedupeKey?: string;
    codingJobId?: string;
} {
    if (typeof body !== "object" || body === null) {
        throw new NotificationInputError("body must be a JSON object");
    }
    const candidate = body as Record<string, unknown>;
    const notificationClass = candidate.class;
    if (
        notificationClass !== undefined &&
        (typeof notificationClass !== "string" ||
            !(NOTIFICATION_CLASSES as readonly string[]).includes(
                notificationClass,
            ))
    ) {
        throw new NotificationInputError(
            `class must be one of ${NOTIFICATION_CLASSES.join(", ")}`,
        );
    }
    const priority = candidate.priority;
    if (
        priority !== undefined &&
        (typeof priority !== "string" ||
            !(NOTIFICATION_PRIORITIES as readonly string[]).includes(priority))
    ) {
        throw new NotificationInputError(
            `priority must be one of ${NOTIFICATION_PRIORITIES.join(", ")}`,
        );
    }
    return {
        kind: requireString(candidate.kind, "kind"),
        title: requireString(candidate.title, "title"),
        ...(notificationClass !== undefined
            ? { class: notificationClass as AppNotification["class"] }
            : {}),
        ...(priority !== undefined
            ? { priority: priority as AppNotification["priority"] }
            : {}),
        ...(candidate.body !== undefined
            ? { body: optionalString(candidate.body, "body") }
            : {}),
        ...(candidate.requiresAnswer !== undefined
            ? { requiresAnswer: candidate.requiresAnswer === true }
            : {}),
        ...(candidate.dedupeKey !== undefined
            ? { dedupeKey: optionalString(candidate.dedupeKey, "dedupeKey") }
            : {}),
        ...(candidate.codingJobId !== undefined
            ? {
                  codingJobId: optionalString(
                      candidate.codingJobId,
                      "codingJobId",
                  ),
              }
            : {}),
    };
}

/** Requires a non-empty string field, naming it in the failure. */
function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new NotificationInputError(`${field} must be a non-empty string`);
    }
    return value.trim();
}

/**
 * Requires a string, but tolerates an empty one.
 *
 * The spec puts no `minLength` on `body`/`dedupeKey`, and an empty body is a
 * producer saying "no detail" — `normalizeNotificationInput` drops it, so
 * rejecting it here would be a 400 for a request the contract accepts.
 */
function optionalString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new NotificationInputError(`${field} must be a string`);
    }
    return value.trim();
}

/**
 * Bounds a notification id before it reaches the store.
 *
 * An over-long id cannot exist, so answering 400 for it skips a pointless
 * indexed lookup without inventing a second not-found wording.
 */
function notificationId(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_NOTIFICATION_ID_LENGTH
    ) {
        throw new NotificationInputError("malformed notification id");
    }
    return value;
}

/**
 * Maps a thrown error onto the `{ error }` shape the API promises.
 */
/**
 * Whether a notification has already been settled.
 *
 * `pending` and `delivered` still want attention; every other state is final
 * from the user's point of view, so a second answer is a conflict rather than
 * another settlement.
 *
 * @param notification - The stored record.
 * @returns True when it is read, answered or snoozed.
 */
function isSettled(notification: AppNotification): boolean {
    return (
        notification.state === "read" ||
        notification.state === "answered" ||
        notification.state === "snoozed"
    );
}

function handleError(res: Response, err: unknown): void {
    if (err instanceof NotificationInputError) {
        res.status(400).json({ error: err.message });
        return;
    }
    logger.error(
        `/api/notifications unhandled error: ${err instanceof Error ? err.stack : String(err)}`,
    );
    res.status(500).json({ error: "internal server error" });
}
