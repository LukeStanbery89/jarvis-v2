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
export type AuthContext = GuestContext | AuthenticatedContext;

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

/** Input modality of a chat session. */
export type SessionKind = "text" | "voice";

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
