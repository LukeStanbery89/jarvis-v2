/**
 * REST surface for scheduled jobs (#90 phase 5): `/api/jobs`.
 *
 * The endpoints a page needs to manage what the assistant has been asked to do
 * later, and what those runs did. Mounted at `/api` by `createApp` **only when
 * the scheduler is wired** — `JARVIS_SCHEDULER=off` (or `JARVIS_NOTIFY=off`,
 * which unmounts the loop) leaves no endpoint at all rather than one that
 * quietly does nothing, the same posture as `/api/notifications`.
 *
 * Auth mirrors the management API exactly: `requireAuth` (device token *or*
 * cookie session) on every route, `requireCsrf` on the state-changing ones.
 * Every route is scoped to the caller, so a job id belonging to somebody else
 * is indistinguishable from one that does not exist (404) — which is why there
 * is no ownership check to forget.
 *
 * **This router holds no policy.** What a job may be, what an edit may touch
 * and what a snooze means live in `scheduler/create.ts`, shared with the model's
 * tools so the two doors cannot answer differently. All this file does is read
 * a request, hand the decision over, and turn the outcome into a status code —
 * the one place `code` is translated into HTTP.
 */
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { createCookieSessionProvider } from "@lukestanbery/jarvis-auth";
import type {
    AppDatabase,
    AppJob,
    AppJobRun,
    JobLedger,
} from "@lukestanbery/jarvis-auth";
import { MAX_NOTIFICATION_ID_LENGTH } from "@lukestanbery/jarvis-protocol";
import type { JobGate, JobRepeat } from "@lukestanbery/jarvis-protocol";
import { authed, requireAuth, requireCsrf } from "../http/middleware";
import { sessionCookieName } from "../http/cookies";
import { parseBoolean, parseLimit } from "../http/params";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import type {
    CreateOutcome,
    CreateRefusal,
    EditOutcome,
    JobCreator,
    QuietForecast,
    SnoozeOutcome,
} from "./create";

/** Default page size for a list call. */
const DEFAULT_LIMIT = 50;
/** Largest page a caller may ask for. */
const MAX_LIMIT = 200;

/**
 * A job as the REST surface exposes it.
 *
 * The stored row minus `userId` (the caller *is* the user) and with the payload
 * flattened to the one field its kind uses, so a page renders a job without
 * having to know the table's shape. `toolArgs` is deliberately absent: a page
 * shows what a job will do through its label, and echoing a stored call's
 * arguments adds a surface with no reader.
 */
export interface JobResponse {
    id: string;
    label: string;
    class: string;
    kind: string;
    state: string;
    runAt: string;
    attempts: number;
    createdAt: string;
    settledAt?: string;
    lastError?: string;
    /** The text a `message` job will deliver. */
    message?: string;
    /** The tool a `tool` job will run. */
    toolName?: string;
    /** The prompt a `prompt` job will run. */
    prompt?: string;
}

/** One attempt at a job. */
export interface JobRunResponse {
    id: string;
    state: string;
    startedAt: string;
    finishedAt?: string;
    output?: string;
    error?: string;
}

/** A job and its history — what the detail route answers. */
export interface JobDetailResponse {
    job: JobResponse;
    runs: JobRunResponse[];
}

/**
 * The quiet-hours prediction, as a page reads it.
 *
 * The same forecast the model is told in words (`scheduler/create.ts`), with the
 * instant it comes back on: a form that creates a reminder at 23:00 should say
 * "that will wait until 07:00" before the user walks away.
 */
export interface QuietResponse {
    state: "clear" | "disabled" | "held";
    /** Present when `held`: the instant the announcement comes back. */
    until?: string;
    /** Present when `held`: the window as the user set it (`22:00–07:00`). */
    window?: string;
}

/** A job stored by a request, and what quiet hours will do to its announcement. */
export interface JobCreatedResponse {
    job: JobResponse;
    quiet: QuietResponse;
}

/** A snooze's outcome: which of the two things happened, and the new moment. */
export interface JobSnoozedResponse extends JobCreatedResponse {
    action: "moved" | "recreated";
    /** Present when `recreated`: the moment the settled reminder was owed. */
    previousRunAt?: string;
}

/** Maps a stored job onto the wire shape (absent keys stay absent). */
export function toJobResponse(job: AppJob): JobResponse {
    return {
        id: job.id,
        label: job.label,
        class: job.class,
        kind: job.kind,
        state: job.state,
        runAt: job.runAt,
        attempts: job.attempts,
        createdAt: job.createdAt,
        ...(job.settledAt !== null ? { settledAt: job.settledAt } : {}),
        ...(job.lastError !== null ? { lastError: job.lastError } : {}),
        ...(job.message !== null ? { message: job.message } : {}),
        ...(job.toolName !== null ? { toolName: job.toolName } : {}),
        ...(job.prompt !== null ? { prompt: job.prompt } : {}),
        // The stored rule, or absent for a one-shot: it is already the wire
        // shape (the same object a caller sent), so nothing re-renders it.
        ...(job.repeat !== null && job.repeat !== undefined
            ? { repeat: job.repeat as JobRepeat }
            : {}),
        // The check the job was created with (#90 phase 8f), on the same terms
        // — the stored value is already the wire shape. It is a *response*
        // field: no create or update request accepts one, because a gate is
        // chosen in the conversation (a read the model validated) rather than
        // drawn on a page.
        ...(job.gate !== null && job.gate !== undefined
            ? { gate: job.gate as JobGate }
            : {}),
    };
}

/** Maps a stored run onto the wire shape. */
export function toJobRunResponse(run: AppJobRun): JobRunResponse {
    return {
        id: run.id,
        state: run.state,
        startedAt: run.startedAt,
        ...(run.finishedAt !== null ? { finishedAt: run.finishedAt } : {}),
        ...(run.output !== null ? { output: run.output } : {}),
        ...(run.error !== null ? { error: run.error } : {}),
        // What the gate read, when the job has one (#90 phase 8f): the answer a
        // declined firing is defined by, and the baseline a payload run leaves
        // for the next comparison.
        ...(run.gateOutput !== null ? { gateOutput: run.gateOutput } : {}),
    };
}

/** Maps a forecast onto the wire shape. */
export function toQuietResponse(forecast: QuietForecast): QuietResponse {
    if (forecast.state === "held") {
        return {
            state: "held",
            until: forecast.until.toISOString(),
            window: forecast.window,
        };
    }
    return { state: forecast.state };
}

/**
 * A malformed request body or field.
 *
 * Distinct from a policy refusal because the caller did not get as far as a
 * decision: a `class` that is not a class is a 400 with the field named,
 * whereas a label too long is the creation policy's refusal to relay.
 */
export class JobInputError extends Error {}

/**
 * The status a creation refusal implies.
 *
 * One translation, for both the create route and a snooze that had to
 * re-create: the request was about inputs (400), the queue is what is full
 * (409), or the store itself failed (500).
 */
function createStatus(code: CreateRefusal): number {
    if (code === "too-many") {
        // The queue is full, not the request malformed: cancel something.
        return 409;
    }
    if (code === "store-failed") {
        return 500;
    }
    if (code === "timer-needs-device") {
        // A credential capability, not a malformed field: the same request
        // works from a device-token caller.
        return 403;
    }
    return 400;
}

/**
 * Builds the jobs router.
 *
 * @param store - The app database: the ledger these reads go through, plus the
 * auth middleware's token/cookie resolution.
 * @param creator - The creation policy (#90 phase 5). Refusals come back as
 * codes; this router is the one place they become status codes.
 * @param appConfig - Configuration, for the cookie-session TTL and TLS posture.
 */
export function createJobRouter(
    store: AppDatabase,
    creator: JobCreator,
    appConfig: AppConfig,
): Router {
    const router = Router();
    const ledger: JobLedger = store;
    const secure = Boolean(appConfig.tlsCertPath && appConfig.tlsKeyPath);
    const authenticated = requireAuth(store, {
        provider: createCookieSessionProvider(store, {
            ttlMs: appConfig.sessionTtlMs,
        }),
        cookieName: sessionCookieName(secure),
    });

    /** The uniform outermost try/catch, as in `authRouter`. */
    const route =
        (
            handler: (req: Request, res: Response) => Promise<void> | void,
        ): RequestHandler =>
        (req, res) => {
            void Promise.resolve()
                .then(() => handler(req, res))
                .catch((err) => handleError(res, err));
        };

    /** Answers a creation outcome — a 201 with its forecast, or its refusal. */
    const sendCreated = (
        res: Response,
        outcome: CreateOutcome,
        userId: number,
    ): void => {
        if (!outcome.ok) {
            res.status(createStatus(outcome.code)).json({
                error: outcome.reason,
            });
            return;
        }
        res.status(201).json({
            job: toJobResponse(outcome.job),
            quiet: toQuietResponse(
                creator.forecast(
                    userId,
                    outcome.job.class,
                    new Date(outcome.job.runAt),
                ),
            ),
        } satisfies JobCreatedResponse);
    };

    router.get(
        "/jobs",
        authenticated,
        route((req, res) => {
            const jarv = authed(req).jarv;
            const jobs = ledger.listJobs(jarv.user.id, {
                limit: parseLimit(req.query.limit, {
                    fallback: DEFAULT_LIMIT,
                    max: MAX_LIMIT,
                }),
                includeSettled: parseBoolean(req.query.includeSettled),
            });
            res.status(200).json({ jobs: jobs.map(toJobResponse) });
        }),
    );

    router.get(
        "/jobs/:id",
        authenticated,
        route((req, res) => {
            const jarv = authed(req).jarv;
            const job = ledger.getJob(jarv.user.id, jobId(req.params.id));
            if (job === null) {
                res.status(404).json({ error: "job not found" });
                return;
            }
            res.status(200).json({
                job: toJobResponse(job),
                runs: ledger.listJobRuns(job.id).map(toJobRunResponse),
            } satisfies JobDetailResponse);
        }),
    );

    router.post(
        "/jobs",
        authenticated,
        requireCsrf,
        route((req, res) => {
            const jarv = authed(req).jarv;
            const request = createRequestFrom(req.body);
            sendCreated(
                res,
                creator.create(jarv.user.id, {
                    ...request,
                    // #194: the signed-in device is the timer's target. A
                    // cookie-session caller has no device and a timer create
                    // is refused by the policy rather than broadcast.
                    ...(jarv.kind === "authed"
                        ? { originDeviceId: jarv.device.id }
                        : {}),
                }),
                jarv.user.id,
            );
        }),
    );

    router.patch(
        "/jobs/:id",
        authenticated,
        requireCsrf,
        route((req, res) => {
            const jarv = authed(req).jarv;
            const patch = editPatchFrom(req.body);
            const outcome = creator.edit(
                jarv.user.id,
                jobId(req.params.id),
                patch,
            );
            sendEdited(res, outcome, jarv.user.id, creator);
        }),
    );

    router.delete(
        "/jobs/:id",
        authenticated,
        requireCsrf,
        route((req, res) => {
            const jarv = authed(req).jarv;
            const id = jobId(req.params.id);
            const job = ledger.getJob(jarv.user.id, id);
            if (job === null) {
                res.status(404).json({ error: "job not found" });
                return;
            }
            const stoppingASeries =
                job.state === "running" &&
                job.repeat !== null &&
                job.repeat !== undefined;
            if (job.state !== "pending" && !stoppingASeries) {
                // The row was already settled when it was read: cancel is
                // idempotent at the store, so the honest answer comes from the
                // state we saw rather than from a successful-looking re-read.
                // A *repeating* job is the exception (#90 phase 8d): the firing
                // in flight is already paid for and will report when it ends,
                // and what the user is stopping is the series.
                res.status(409).json({
                    error: `the job is ${job.state} — only one that has not started can be cancelled`,
                });
                return;
            }
            const cancelled = ledger.cancelJob(jarv.user.id, id);
            if (cancelled === null || cancelled.state !== "cancelled") {
                // It became running between the read and the write.
                res.status(409).json({
                    error: `the job is ${cancelled?.state ?? job.state} now — it cannot be cancelled`,
                });
                return;
            }
            logger.info(`job ${cancelled.id} cancelled over REST`);
            res.status(200).json({ job: toJobResponse(cancelled) });
        }),
    );

    router.post(
        "/jobs/:id/snooze",
        authenticated,
        requireCsrf,
        route((req, res) => {
            const jarv = authed(req).jarv;
            const minutes = snoozeMinutesFrom(req.body);
            const outcome = creator.snooze(
                jarv.user.id,
                jobId(req.params.id),
                minutes,
            );
            sendSnoozed(res, outcome, jarv.user.id, creator);
        }),
    );

    return router;
}

/**
 * Answers an edit outcome.
 *
 * The status split is the interesting half: a missing job is a 404, a job that
 * is no longer pending is a 409 (it exists, and something else is happening to
 * it), and a bad field is a 400.
 */
function sendEdited(
    res: Response,
    outcome: EditOutcome,
    userId: number,
    creator: JobCreator,
): void {
    if (outcome.ok) {
        res.status(200).json({
            job: toJobResponse(outcome.job),
            quiet: toQuietResponse(
                creator.forecast(
                    userId,
                    outcome.job.class,
                    new Date(outcome.job.runAt),
                ),
            ),
        } satisfies JobCreatedResponse);
        return;
    }
    if (outcome.code === "missing") {
        res.status(404).json({ error: "job not found" });
        return;
    }
    if (outcome.code === "not-pending") {
        res.status(409).json({ error: outcome.reason });
        return;
    }
    res.status(400).json({ error: outcome.reason });
}

/** Answers a snooze outcome — the new moment, and which of the two it was. */
function sendSnoozed(
    res: Response,
    outcome: SnoozeOutcome,
    userId: number,
    creator: JobCreator,
): void {
    if (outcome.ok) {
        res.status(200).json({
            action: outcome.action,
            job: toJobResponse(outcome.job),
            quiet: toQuietResponse(
                creator.forecast(userId, outcome.job.class, outcome.runAt),
            ),
            ...(outcome.previousRunAt !== null
                ? { previousRunAt: outcome.previousRunAt.toISOString() }
                : {}),
        } satisfies JobSnoozedResponse);
        return;
    }
    if (outcome.code === "missing") {
        res.status(404).json({ error: "job not found" });
        return;
    }
    if (
        outcome.code === "cancelled" ||
        outcome.code === "running" ||
        outcome.code === "cannot-move" ||
        outcome.code === "not-repeatable"
    ) {
        // The job exists; its state is what refuses. A page shows the reason.
        res.status(409).json({ error: outcome.reason });
        return;
    }
    if (
        outcome.code === "not-a-reminder" ||
        outcome.code === "invalid-minutes"
    ) {
        res.status(400).json({ error: outcome.reason });
        return;
    }
    // What is left is a creation bound the re-created reminder hit, which is
    // the same answer the create route gives it.
    res.status(createStatus(outcome.code)).json({ error: outcome.reason });
}

/**
 * Validates a create body.
 *
 * Field-level problems are {@link JobInputError}s (a 400 naming the field),
 * because a page sending a `class` that is not a class should be told which
 * field is wrong rather than get a generic failure. The class **is** accepted
 * here, which is the difference between this door and the model's: a page is the
 * user's own hand, while a model that could name a class could pierce quiet
 * hours with it.
 */
function createRequestFrom(body: unknown): {
    label: string;
    class: AppJob["class"];
    payload: { kind: "message"; message: string };
    runAt: Date;
    repeat?: unknown;
} {
    const candidate = objectBody(body);
    const jobClass = candidate.class;
    if (
        typeof jobClass !== "string" ||
        !["notification", "reminder", "timer"].includes(jobClass)
    ) {
        throw new JobInputError(
            "class must be one of notification, reminder, timer",
        );
    }
    const label = requireString(candidate.label, "label");
    const message =
        candidate.message === undefined
            ? label
            : optionalString(candidate.message, "message");
    return {
        label,
        class: jobClass as AppJob["class"],
        // A page-created job is always a message job (#90 phase 5): a stored
        // tool call is a durable capability, and the tool allowlist plus the
        // target tool's own schema are the only door to one.
        payload: {
            kind: "message",
            message: message.length > 0 ? message : label,
        },
        runAt: requireInstant(candidate.runAt, "runAt"),
        // Passed through as it arrived: the *policy* is the door that judges a
        // rule (#90 phase 8d), so a page and a model are held to one reading of
        // what a schedule may be, and the refusal text is written once.
        ...(candidate.repeat !== undefined ? { repeat: candidate.repeat } : {}),
    };
}

/**
 * Validates an edit body.
 *
 * At least one field is required — an edit that changes nothing is a mistake,
 * not a no-op the caller meant to make visible.
 */
function editPatchFrom(body: unknown): {
    label?: string;
    message?: string;
    runAt?: Date;
    repeat?: unknown | null;
} {
    const candidate = objectBody(body);
    if (candidate.class !== undefined || candidate.kind !== undefined) {
        // They are not editable, and saying so beats silently ignoring a field
        // the caller thought would change something: turning a reminder into a
        // timer changes how loudly the user is interrupted, which is a new job.
        throw new JobInputError(
            "class and kind cannot be edited — cancel the job and create another",
        );
    }
    const patch: {
        label?: string;
        message?: string;
        runAt?: Date;
        repeat?: unknown | null;
    } = {};
    // `null` is a value here, not an absence: it is how a request stops a
    // repeating job, and the store reads the difference (#90 phase 8d).
    if ("repeat" in candidate) {
        patch.repeat = candidate.repeat ?? null;
    }
    if (candidate.label !== undefined) {
        patch.label = requireString(candidate.label, "label");
    }
    if (candidate.message !== undefined) {
        patch.message = requireString(candidate.message, "message");
    }
    if (candidate.runAt !== undefined) {
        patch.runAt = requireInstant(candidate.runAt, "runAt");
    }
    if (Object.keys(patch).length === 0) {
        throw new JobInputError("give at least one of label, message or runAt");
    }
    return patch;
}

/**
 * Validates a snooze body.
 *
 * Only `minutes` — a snooze is a human-scale "not now", and the offsets are
 * relative on purpose (no calendar math until recurrence).
 */
function snoozeMinutesFrom(body: unknown): number {
    const candidate = objectBody(body);
    const minutes = candidate.minutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
        throw new JobInputError("minutes must be a number");
    }
    return minutes;
}

/** Requires a JSON object body, naming the failure. */
function objectBody(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new JobInputError("body must be a JSON object");
    }
    return body as Record<string, unknown>;
}

/** Requires a non-empty string field, naming it in the failure. */
function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new JobInputError(`${field} must be a non-empty string`);
    }
    return value.trim();
}

/** Requires a string field, tolerating an empty one. */
function optionalString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new JobInputError(`${field} must be a string`);
    }
    return value.trim();
}

/**
 * Requires an ISO-8601 instant.
 *
 * A page sends what its date picker produced; the policy compares it to now.
 * Whether it is *allowed* (in the past, beyond the horizon) is the policy's
 * decision, not this parser's.
 */
function requireInstant(value: unknown, field: string): Date {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new JobInputError(`${field} must be an ISO-8601 timestamp`);
    }
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) {
        throw new JobInputError(`${field} must be an ISO-8601 timestamp`);
    }
    return at;
}

/**
 * Bounds a job id before it reaches the store.
 *
 * Job ids are the same opaque token as notification ids (the protocol's bound
 * applies to both), so an over-long id cannot exist and answering 400 skips a
 * pointless indexed lookup.
 */
function jobId(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_NOTIFICATION_ID_LENGTH
    ) {
        throw new JobInputError("malformed job id");
    }
    return value;
}

/** Maps a thrown error onto the `{ error }` shape the API promises. */
function handleError(res: Response, err: unknown): void {
    if (err instanceof JobInputError) {
        res.status(400).json({ error: err.message });
        return;
    }
    logger.error(
        `/api/jobs unhandled error: ${err instanceof Error ? err.stack : String(err)}`,
    );
    res.status(500).json({ error: "internal server error" });
}
