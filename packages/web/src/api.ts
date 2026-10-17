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
            options: { limit?: number; includeDismissed?: boolean } = {},
        ): Promise<NotificationList> {
            const params = new URLSearchParams();
            if (options.limit !== undefined) {
                params.set("limit", String(options.limit));
            }
            if (options.includeDismissed === true) {
                params.set("includeDismissed", "true");
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
        /** Dismisses one notification (idempotent; 404 for a foreign id). */
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
