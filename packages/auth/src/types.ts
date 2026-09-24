/**
 * Auth domain types: the account/device shapes and the resolution seam.
 *
 * These are the object shapes the REST and WebSocket layers read. `AuthContext`
 * is the discriminated union that `req.jarv` / the WS handshake carry: either
 * a bare `kind: "guest"` or an authenticated `{ kind: "authed" }` identity, so
 * consumers narrow by `kind` and never re-check for null.
 */

/** Account role: the owner manages users; regular users only manage themselves. */
export type Role = "owner" | "user";

/** A user account, as stored in + returned from the app store. */
export interface AppUser {
    id: number;
    username: string;
    role: Role;
    /** Whether the account is disabled; disabled users can't log in and no
     *  kept credential resolves to them (see the store's `resolveTokenHash`). */
    disabled: boolean;
    createdAt: string;
}

/** A registered device belonging to a user. */
export interface AppDevice {
    id: number;
    userId: number;
    name: string;
    prefix: string;
    createdAt: string;
    lastSeenAt: string | null;
}

/** A successfully authenticated identity: the user plus the presenting device. */
export interface ResolvedIdentity {
    user: AppUser;
    device: AppDevice;
}

/**
 * The auth state attached to one request/socket, discriminated by `kind`.
 *
 * Middleware on REST and the WS resolve this once and thread it through, so
 * the endpoint/turn handlers never re-parse tokens. A guest carries no
 * identity; an authed context carries both user and device (the shape of
 * {@link ResolvedIdentity}), so narrowing by `kind` yields non-null fields.
 */
export type AuthContext = GuestContext | AuthenticatedContext | SessionContext;

/** A request/socket with no resolved identity. */
export interface GuestContext {
    kind: "guest";
}

/**
 * A request/socket authenticated as a particular user/device pair.
 */
export interface AuthenticatedContext extends ResolvedIdentity {
    kind: "authed";
}

/**
 * A request authenticated through a browser cookie session (no device).
 *
 * Built by the server's `requireAuth` when a valid `web_sessions` cookie is
 * presented. Carries the per-session CSRF nonce, which the server's
 * `requireCsrf` middleware compares (timing-safe) on state-changing requests,
 * and which the REST layer hands to the SPA at login time.
 */
export interface SessionContext {
    kind: "session";
    user: AppUser;
    csrfToken: string;
}

/** Input modality of a chat session. */
export type SessionKind = "text" | "voice";

/**
 * One row of the web-session ledger: a browser cookie session.
 *
 * Created by {@link CookieSessionProvider}. `secretHash` is the SHA-256 of the
 * cookie's raw token (hash-at-rest, exactly like device tokens); `csrfToken`
 * is the per-session nonce the browser echoes in an `x-csrf-token` header on
 * state-changing requests. `user_id` is the account the session belongs to.
 */
export interface WebSessionRow {
    id: number;
    userId: number;
    secretHash: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
}

/**
 * One chat session: a nexus between the WS-turn ledger and a LangGraph thread.
 *
 * `threadId` is unique — a session maps one-to-one onto a checkpoint thread.
 * `userId`/`deviceId` are `NULL` for guest (ephemeral) sessions; `kind`
 * (`text`/`voice`) drives the lifecycle-deletion policy.
 */
export interface AppSession {
    id: number;
    threadId: string;
    userId: number | null;
    deviceId: number | null;
    kind: SessionKind;
    createdAt: string;
    lastActiveAt: string;
}
