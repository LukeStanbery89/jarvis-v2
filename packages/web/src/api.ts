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

/** REST failure carrying the server's `{ error }` message on a non-2xx body. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
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
            try {
                message = (await res.json()).error ?? message;
            } catch {
                // non-JSON error body; keep the statusText message
            }
            throw new ApiError(res.status, message);
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
    };
}

/** The default API instance used by the app (global `fetch`). */
export const api = createApi();
