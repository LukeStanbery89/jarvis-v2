/**
 * Typed fetch client for the JARVIS REST API.
 *
 * The portal authenticates with the `jarvis_session` cookie (set by the server
 * on `POST /api/session`) and echoes the per-session CSRF nonce back on every
 * state-changing request as an `x-csrf-token` header. The nonce is held only in
 * memory (never persisted) — `auth.ts` reloads it from `GET /api/session` on
 * boot and clears it on logout.
 *
 * A 401 on any request except login/bootstrap signals a dead session: the
 * registered unauthorized handler (set by the app) redirects to the login
 * screen.
 */
import type {
    ApiDevice,
    ApiSession,
    ApiUser,
    DeviceLogin,
    Prefs,
    SessionUser,
} from "./types";

/** Server error payload: `{ "error": "<message>" }`. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** Replaces the in-memory CSRF nonce (login, boot, logout). */
export function setCsrfToken(token: string | null): void {
    csrfToken = token;
}

/** Returns the current in-memory CSRF nonce. */
export function getCsrfToken(): string | null {
    return csrfToken;
}

/**
 * Registers the handler invoked when the API reports a dead session (401) on a
 * non-login request. The app wires this to navigation back to the login view.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
    onUnauthorized = handler;
}

interface RequestOptions {
    /** Skip the global dead-session redirect (used by login/bootstrap). */
    skipAuthRedirect?: boolean;
    /** Extra headers merged into the request (e.g. `x-bootstrap-token`). */
    headers?: Record<string, string>;
}

const STATE_CHANGING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Low-level request: JSON in/out, CSRF header when a nonce is held, and an
 * `ApiError` carrying the server's `{ error }` message on non-2xx.
 */
async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    if (body !== undefined) {
        headers["content-type"] = "application/json";
    }
    if (csrfToken && STATE_CHANGING.has(method)) {
        headers["x-csrf-token"] = csrfToken;
    }
    const res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
    });
    if (res.status === 401 && !options.skipAuthRedirect) {
        onUnauthorized?.();
    }
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

/**
 * The typed API surface, grouped by resource. One method per REST route the
 * portal uses — no raw fetch calls outside this module.
 */
export const api = {
    bootstrap(
        token: string,
        username: string,
        password: string,
    ): Promise<DeviceLogin> {
        return request<DeviceLogin>(
            "POST",
            "/api/bootstrap",
            { username, password },
            { headers: { "x-bootstrap-token": token }, skipAuthRedirect: true },
        );
    },
    login(username: string, password: string): Promise<SessionUser> {
        return request<SessionUser>(
            "POST",
            "/api/session",
            { username, password },
            {
                skipAuthRedirect: true,
            },
        );
    },
    logout(): Promise<void> {
        return request<void>("DELETE", "/api/session");
    },
    getSession(): Promise<SessionUser> {
        return request<SessionUser>("GET", "/api/session");
    },
    me(): Promise<{ user: ApiUser; devices: ApiDevice[] }> {
        return request("GET", "/api/me");
    },
    listUsers(): Promise<ApiUser[]> {
        return request("GET", "/api/users");
    },
    createUser(
        username: string,
        password: string,
        role: "owner" | "user",
    ): Promise<{ user: ApiUser }> {
        return request("POST", "/api/users", { username, password, role });
    },
    updateUser(
        id: number,
        patch: { role?: "owner" | "user"; disabled?: boolean },
    ): Promise<{ user: ApiUser }> {
        return request("PATCH", `/api/users/${id}`, patch);
    },
    listUserDevices(id: number): Promise<ApiDevice[]> {
        return request("GET", `/api/users/${id}/devices`);
    },
    provisionDevice(name: string): Promise<{
        device: { id: number; name: string; prefix: string; token: string };
    }> {
        return request("POST", "/api/devices", { deviceName: name });
    },
    renameDevice(id: number, name: string): Promise<{ device: ApiDevice }> {
        return request("PATCH", `/api/devices/${id}`, { name });
    },
    revokeDevice(id: number): Promise<void> {
        return request("DELETE", `/api/devices/${id}`);
    },
    listSessions(): Promise<ApiSession[]> {
        return request("GET", "/api/sessions");
    },
    deleteSession(threadId: string): Promise<void> {
        return request("DELETE", `/api/sessions/${threadId}`);
    },
    getPrefs(userId?: number): Promise<Prefs> {
        return request(
            "GET",
            userId === undefined ? "/api/prefs" : `/api/users/${userId}/prefs`,
        );
    },
    setPrefs(userId: number | undefined, prefs: Prefs): Promise<Prefs> {
        return request(
            "PUT",
            userId === undefined ? "/api/prefs" : `/api/users/${userId}/prefs`,
            prefs,
        );
    },
    clearPrefs(userId?: number): Promise<void> {
        return request(
            "DELETE",
            userId === undefined ? "/api/prefs" : `/api/users/${userId}/prefs`,
        );
    },
};
