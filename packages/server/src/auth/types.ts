/**
 * Auth domain types: the account/device shapes and the resolution seam.
 *
 * These are the object shapes the REST and WebSocket layers read. `AuthContext`
 * is what `req.jarv` / the WS handshake carry; a guest has `user: null` and
 * `device: null`, an authenticated socket has both.
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
 * The auth state attached to one request/socket.
 *
 * `user`/`device` are `null` for guests. Middleware on REST and the WS
 * resolve this once and thread it through, so the endpoint/turn handlers
 * never re-parse tokens.
 */
export interface AuthContext {
    user: AppUser | null;
    device: AppDevice | null;
}
