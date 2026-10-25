/**
 * Typed fetch client for the JARVIS REST API (browser side).
 *
 * The web chat client authenticates with a **device token** obtained from
 * `POST /api/auth/login` (the same flow the CLI uses) and sends it as a
 * Bearer credential on every REST call — no cookies, no CSRF. The token is a
 * secret: it lives in localStorage (a deliberate product decision, see
 * `credentials.ts`) and is never logged.
 *
 * REST response shapes come from the generated OpenAPI types in
 * `@lukestanbery/jarvis-contracts` (single source of truth:
 * `spec/openapi.yaml`). Only the *type* level is imported (`import type`),
 * so nothing lands in the bundle.
 *
 * A 401 on any authenticated call means the stored device token is no longer
 * valid (revoked or stale); callers react by dropping back to the login
 * screen, mirroring the portal's dead-session handling.
 */
import type { components } from "@lukestanbery/jarvis-contracts";
import type { CodingAnswer, CodingJobQuestions } from "./notifications";

/** Account row as exposed by the REST API. */
export type ApiUser = components["schemas"]["User"];

/**
 * Device-login response of `POST /api/auth/login`: the user row plus the
 * freshly issued device credential (the one-time `token` included).
 */
export type LoginResult = components["schemas"]["AuthResult"];

/** Chat-thread session row as exposed by `GET /api/sessions`. */
export type SessionSummary = components["schemas"]["SessionSummary"];

/**
 * One stored notification (#139), as the REST API exposes it. The live
 * `/ws` `notification` frame carries a subset of this shape — same `id`, so
 * the two can be merged without rendering anything twice.
 */
export type Notification = components["schemas"]["Notification"];

/** Body of `GET /api/notifications`: the page plus the unread badge count. */
export type NotificationList = components["schemas"]["NotificationList"];

/**
 * One scheduled job (#90), as `GET /api/jobs` exposes it. `state` decides
 * whether it is still owed; `class` decides how loudly it will announce itself.
 */
export type Job = components["schemas"]["Job"];

/** Body of `GET /api/jobs`: the work still owed, newest-created first. */
export type JobList = components["schemas"]["JobList"];

/**
 * Body of `POST /api/jobs` (#90 phase 7): what a page asks for. A page may name
 * the `class` (it is the user's own hand, unlike the model's tools, which own
 * their class) and its jobs are always `message` jobs.
 */
export type JobCreateRequest = components["schemas"]["JobCreateRequest"];

/**
 * Body of `PATCH /api/jobs/{id}` (#90 phase 7): the fields an edit may touch.
 * `class` and `kind` are absent on purpose — changing either is a different job.
 */
export type JobUpdateRequest = components["schemas"]["JobUpdateRequest"];

/**
 * Body of `POST /api/jobs` and `PATCH /api/jobs/{id}`: the stored job and what
 * the caller's quiet hours, as they stand, will do to its announcement.
 */
export type JobSaved = components["schemas"]["JobSaved"];

/** Body of `GET /api/jobs/{id}`: the job and every attempt at it. */
export type JobDetail = components["schemas"]["JobDetail"];

/** One attempt at a job: what it did, or why it failed. */
export type JobRun = components["schemas"]["JobRun"];

/**
 * What quiet hours will do to an announcement: `held` (with the moment it comes
 * back on), `disabled` (the account's master switch is off), or `clear`.
 */
export type QuietForecast = components["schemas"]["QuietForecast"];

/**
 * Body of `POST /api/jobs/{id}/snooze` (#90): the job's new moment, which of the
 * two things happened (`moved` / `recreated`), and what quiet hours will do to the
 * new time.
 */
export type JobSnoozed = components["schemas"]["JobSnoozed"];

/** Body of `DELETE /api/jobs/{id}` (#90): the job as it now stands. */
export type JobCancelled = components["schemas"]["JobCancelled"];

/** Body of `POST /api/notifications`: the record plus what happened to it. */
export type NotificationDelivery =
    components["schemas"]["NotificationDelivery"];

/** Body of `POST /api/notifications`: what the producer asks for. */
export type NotificationInput = components["schemas"]["NotificationInput"];

/**
 * The caller's free-form preferences map (`GET`/`PUT /api/prefs`): string keys
 * to any JSON value. The web client only reads and writes the keys it owns
 * (`notify.*`, see `prefs.ts`); everything else in the map belongs to
 * integrations and is passed through untouched.
 */
export type Prefs = components["schemas"]["Prefs"];

/**
 * Current conditions at the device's coordinates (#186), as `GET
 * /api/weather` exposes them: one normalized OpenWeather reading, never a
 * vendor payload.
 */
export type WeatherNow = components["schemas"]["WeatherNow"];

/** Body of `GET /api/push/key`: the VAPID public key. */
export type PushKey = components["schemas"]["PushKey"];

/** Browser registration posted to `POST /api/push/subscribe`. */
export type PushSubscriptionInput =
    components["schemas"]["PushSubscriptionInput"];

/** REST failure carrying the server's `{ error }` message on a non-2xx body. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
        /**
         * Machine-readable reason from the error body, when the server sends
         * one (the attachment 413's `code` — e.g. `ATTACHMENT_TOO_LARGE`).
         */
        readonly code?: string,
        /** The cap the server reports alongside a size rejection, in bytes. */
        readonly maxBytes?: number,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

/**
 * Builds a device name for this browser's logins.
 *
 * Each login provisions a fresh device credential; a short random suffix
 * keeps repeated web logins distinguishable in the portal's Devices list.
 */
function deviceName(): string {
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    return `web-${suffix}`;
}

/**
 * Builds the typed API surface.
 *
 * `fetchImpl` defaults to the global `fetch` and is injectable so tests can
 * stub HTTP without a server. Every method maps server errors onto
 * {@link ApiError} (message from the `{ error }` body when present).
 */
export function createApi(
    fetchImpl: typeof fetch = (...args) => fetch(...args),
) {
    async function request<T>(
        method: string,
        path: string,
        options: { body?: unknown; token?: string } = {},
    ): Promise<T> {
        const headers: Record<string, string> = {};
        if (options.body !== undefined) {
            headers["content-type"] = "application/json";
        }
        if (options.token !== undefined) {
            headers.authorization = `Bearer ${options.token}`;
        }
        const res = await fetchImpl(path, {
            method,
            headers,
            body:
                options.body === undefined
                    ? undefined
                    : JSON.stringify(options.body),
        });
        if (!res.ok) {
            let message = res.statusText || "request failed";
            let code: string | undefined;
            let maxBytes: number | undefined;
            try {
                const body = (await res.json()) as {
                    error?: string;
                    code?: string;
                    maxBytes?: number;
                };
                message = body.error ?? message;
                code = body.code;
                maxBytes = body.maxBytes;
            } catch {
                // non-JSON error body; keep the statusText message
            }
            throw new ApiError(res.status, message, code, maxBytes);
        }
        if (res.status === 204) {
            return undefined as T;
        }
        return (await res.json()) as T;
    }

    return {
        /**
         * Exchanges username + password for a fresh device token (rotating;
         * shown once by the server). Rejects with {@link ApiError} — 401 for
         * bad credentials, 403 disabled account, 429 rate-limited.
         */
        login(username: string, password: string): Promise<LoginResult> {
            return request("POST", "/api/auth/login", {
                body: { username, password, deviceName: deviceName() },
            });
        },
        /**
         * Lists chat threads visible to the caller. A non-owner sees only
         * their own threads; an owner sees every account's, so callers must
         * filter rows by `userId` against their own id.
         */
        listSessions(token: string): Promise<SessionSummary[]> {
            return request("GET", "/api/sessions", { token });
        },
        /** Deletes one of the caller's own chat threads (204; 404 unknown). */
        async deleteSession(token: string, threadId: string): Promise<void> {
            await request(
                "DELETE",
                `/api/sessions/${encodeURIComponent(threadId)}`,
                { token },
            );
        },
        /**
         * Uploads one base64-encoded image and returns its attachment id
         * (#10) — the id a prompt references in its `attachments` list.
         * Bearer-authenticated, no CSRF token (R8: the web client has no
         * CSRF secret by design). Rejects with {@link ApiError}: 413 carries
         * `code: "ATTACHMENT_TOO_LARGE"` + `maxBytes`, 403 non-image bytes,
         * 503 upload capacity saturated.
         */
        async uploadAttachment(
            token: string,
            base64: string,
        ): Promise<{ attachmentId: string }> {
            return request("POST", "/api/attachments", {
                token,
                body: { data: base64 },
            });
        },
        /**
         * Lists the caller's notifications (#139), newest first, with the
         * unread count for the badge. Dismissed rows are excluded unless
         * asked for; a notification that was never pushed (the user was
         * offline when it was raised) is found here instead, which is why the
         * live `/ws` frame is an optimisation rather than the mechanism.
         */
        listNotifications(
            token: string,
            options: { limit?: number } = {},
        ): Promise<NotificationList> {
            const params = new URLSearchParams();
            if (options.limit !== undefined) {
                params.set("limit", String(options.limit));
            }
            const query = params.size > 0 ? `?${params.toString()}` : "";
            return request("GET", `/api/notifications${query}`, { token });
        },
        /** Marks one notification read (idempotent; 404 for a foreign id). */
        async markNotificationRead(
            token: string,
            id: string,
        ): Promise<Notification> {
            const result = await request<{ notification: Notification }>(
                "POST",
                `/api/notifications/${encodeURIComponent(id)}/read`,
                { token },
            );
            return result.notification;
        },
        /**
         * Answers an answerable notification (#94). When the record names a
         * coding job, the server resumes it before settling the row, so a 409
         * means the job could not be resumed and the row is still answerable.
         */
        async answerNotification(
            token: string,
            id: string,
            answer: string | readonly CodingAnswer[],
        ): Promise<Notification> {
            const result = await request<{ notification: Notification }>(
                "POST",
                `/api/notifications/${encodeURIComponent(id)}/answer`,
                {
                    token,
                    body:
                        typeof answer === "string"
                            ? { answer }
                            : { answers: answer },
                },
            );
            return result.notification;
        },
        /**
         * A coding job's structured questions and answers (#180). The app
         * fetches them when an answerable notification's card opens; the
         * notification itself carries only the job link and a summary.
         */
        getCodingJobQuestions(
            token: string,
            jobId: string,
        ): Promise<CodingJobQuestions> {
            return request(
                "GET",
                `/api/coding-jobs/${encodeURIComponent(jobId)}/questions`,
                { token },
            );
        },
        /**
         * Raises a notification for the caller (#139) and reports what
         * happened to it: `delivered` is how many live clients received the
         * frame, `suppressed` names the gate that held it back (`absent` when
         * no client was connected, then `quiet-hours`/`cap`/`disabled`).
         */
        createNotification(
            token: string,
            input: NotificationInput,
        ): Promise<NotificationDelivery> {
            return request("POST", "/api/notifications", {
                token,
                body: input,
            });
        },
        /**
         * Dismisses one notification: **deletes** it (#90 phase 9c). The row
         * comes back as it was, and a repeat answers 404 like a foreign id.
         */
        async dismissNotification(
            token: string,
            id: string,
        ): Promise<Notification> {
            const result = await request<{ notification: Notification }>(
                "POST",
                `/api/notifications/${encodeURIComponent(id)}/dismiss`,
                { token },
            );
            return result.notification;
        },
        /**
         * Reads the caller's preferences map (possibly empty). The panel needs
         * the *stored* values rather than a projection of them, so it can tell
         * "never set" from "set to something unreadable".
         */
        getPrefs(token: string): Promise<Prefs> {
            return request("GET", "/api/prefs", { token });
        },
        /**
         * Upserts the given pref keys and returns the whole updated map.
         *
         * Only the keys sent are touched; every other key keeps its value, so a
         * caller patches one setting at a time. Bearer-authenticated, no CSRF
         * token (the web client has no CSRF secret by design). A key whose
         * value the server cannot accept is a 400 — never a silent no-op.
         *
         * Note there is **no** `clearPrefs`: `DELETE /api/prefs` drops every
         * key, which would wipe integration preferences the panel knows nothing
         * about. Turning a pref off means writing its off value.
         */
        setPrefs(token: string, patch: Prefs): Promise<Prefs> {
            return request("PUT", "/api/prefs", { token, body: patch });
        },
        /**
         * Reads the VAPID public key for Web Push (#189 follow-up).
         *
         * A deployment without a VAPID pair answers 503; the caller treats
         * that as "push unavailable" and keeps the page notification path.
         */
        getPushKey(token: string): Promise<PushKey> {
            return request("GET", "/api/push/key", { token });
        },
        /** Registers this browser's push endpoint for the signed-in account. */
        async subscribePush(
            token: string,
            subscription: PushSubscriptionInput,
        ): Promise<void> {
            await request("POST", "/api/push/subscribe", {
                token,
                body: subscription,
            });
        },
        /** Removes one browser push endpoint; idempotent (204). */
        async unsubscribePush(token: string, endpoint: string): Promise<void> {
            await request("POST", "/api/push/unsubscribe", {
                token,
                body: { endpoint },
            });
        },
        /**
         * Reads current weather for the device's coordinates (#186).
         *
         * The coordinates are the already-rounded fix the location share sends
         * over `/ws`; the server owns the OpenWeather key and the per-user
         * weather budget. Rejects with {@link ApiError}: 429 when the budget is
         * exhausted, 502 when the provider is unavailable, 503 when the server
         * has no weather key configured.
         */
        getWeather(
            token: string,
            lat: number,
            lon: number,
        ): Promise<WeatherNow> {
            const params = new URLSearchParams({
                lat: String(lat),
                lon: String(lon),
            });
            return request("GET", `/api/weather?${params.toString()}`, {
                token,
            });
        },
        /**
         * Lists the caller's scheduled jobs (#90).
         *
         * Settled jobs (`done`, `failed`, `cancelled`, `missed`) are history and
         * are excluded unless asked for, so the default answer is the work still
         * owed — which is exactly what a dashboard's "coming up" means. As with
         * the notification list, a 401 is the caller's problem: the app is about
         * to drop to login.
         */
        listJobs(
            token: string,
            options: { limit?: number; includeSettled?: boolean } = {},
        ): Promise<JobList> {
            const params = new URLSearchParams();
            if (options.limit !== undefined) {
                params.set("limit", String(options.limit));
            }
            if (options.includeSettled === true) {
                params.set("includeSettled", "true");
            }
            const query = params.size > 0 ? `?${params.toString()}` : "";
            return request("GET", `/api/jobs${query}`, { token });
        },
        /**
         * Reads one job and every attempt at it (#90 phase 7).
         *
         * This is the run history: what a prompt or tool job actually produced,
         * or why it failed. A job a retention pass has pruned is a 404 — the
         * honest answer, and the same one a snoozed row's dead link gets.
         */
        getJob(token: string, id: string): Promise<JobDetail> {
            return request("GET", `/api/jobs/${encodeURIComponent(id)}`, {
                token,
            });
        },
        /**
         * Creates a job from a page (#90 phase 7).
         *
         * A page-created job is always a `message` job — text with nothing to
         * run — because a stored tool call is a durable capability, and the tool
         * allowlist plus the target tool's own schema are the only door to one
         * (see the server README). Everything a page sends is a *request*: the
         * bounds (label/body length, a future moment, the horizon, the timer's
         * day ceiling) live in `scheduler/create.ts`, and a refusal comes back as
         * the server's own `{ error }`.
         */
        createJob(token: string, input: JobCreateRequest): Promise<JobSaved> {
            return request("POST", "/api/jobs", { token, body: input });
        },
        /**
         * Edits a pending job's label, detail or moment (#90 phase 7).
         *
         * `class` and `kind` cannot be edited — that is a different job, and the
         * server says so rather than ignoring the field — and a `message` edit on
         * a job that is not a `message` job is refused too (a tool job has no
         * text to edit). A job that has already started is a 409.
         */
        updateJob(
            token: string,
            id: string,
            patch: JobUpdateRequest,
        ): Promise<JobSaved> {
            return request("PATCH", `/api/jobs/${encodeURIComponent(id)}`, {
                token,
                body: patch,
            });
        },
        /**
         * Snoozes a reminder (#90 phase 6c): a pending one's moment moves, one
         * that already had its moment is set again for the new time with the same
         * payload.
         *
         * The same call also settles the notification that announced it —
         * `snoozed`, server-side, because the deferral *is* the acknowledgement.
         * That is why the client settles its row locally instead of posting a
         * second request: one action, one request, and the row stops asking.
         *
         * @param minutes - How long from now. The short end is the server's
         *   (`MIN_SNOOZE_MINUTES`); the presets the UI offers are `SNOOZE_PRESETS`.
         */
        snoozeJob(
            token: string,
            id: string,
            minutes: number,
        ): Promise<JobSnoozed> {
            return request(
                "POST",
                `/api/jobs/${encodeURIComponent(id)}/snooze`,
                { token, body: { minutes } },
            );
        },
        /**
         * Cancels one of the caller's jobs (#90). Idempotent on the server's side
         * of the ledger (an already-cancelled row is refused rather than
         * rewritten), and a foreign id is a 404.
         *
         * A settled job is history and cannot be cancelled — the caller's
         * `GET /api/jobs` list only carries rows still owed, so the button is only
         * ever offered where it applies.
         */
        cancelJob(token: string, id: string): Promise<JobCancelled> {
            return request("DELETE", `/api/jobs/${encodeURIComponent(id)}`, {
                token,
            });
        },
    };
}

/** The default API instance used by the app (global `fetch`). */
export const api = createApi();
