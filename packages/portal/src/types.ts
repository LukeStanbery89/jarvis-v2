/**
 * JSON shapes returned by the server's REST API.
 *
 * These deliberately mirror the `userJson`/`deviceJson`/session helpers in
 * `packages/server/src/http/authRoutes.ts` — the HTTP contract is the single
 * source of truth between the server and this SPA, so these are *not* imported
 * from the server or auth packages (the portal is served as static assets and
 * has no Node-side dependency on them).
 */

/** Account row as exposed by `/api/users`. */
export interface ApiUser {
    id: number;
    username: string;
    role: "owner" | "user";
    disabled: boolean;
    createdAt: string;
}

/** Device credential row as exposed by `/api/me` and `/api/users/:id/devices`. */
export interface ApiDevice {
    id: number;
    name: string;
    prefix: string;
    createdAt: string;
    lastSeenAt: string | null;
}

/** Chat-thread session as exposed by `/api/sessions`. */
export interface ApiSession {
    threadId: string;
    kind: "text" | "voice";
    userId: number | null;
    createdAt: string;
    lastActiveAt: string;
}

/** `POST /api/session` (login) and `GET /api/session` (session echo). */
export interface SessionUser {
    user: ApiUser;
    /** Present only for cookie sessions; the portal's CSRF nonce. */
    csrfToken?: string;
}

/** `POST /api/auth/login` and `POST /api/bootstrap` device-login response. */
export interface DeviceLogin {
    user: ApiUser;
    device: { id: number; name: string; prefix: string; token: string };
}

/** Free-form per-user integration prefs (`/api/prefs`). */
export type Prefs = Record<string, unknown>;
