/**
 * Cookie-session provider for the web portal (#24).
 *
 * The cookie-session analog of the device-token flow in `crypto.ts`: issuing a
 * session gives the browser a 32-random-byte base64url `token` (carried in an
 * HttpOnly cookie) whose SHA-256 hash — plus a per-session CSRF nonce — is all
 * the store persists. A leaked `web_sessions` table never yields a usable
 * cookie, exactly like a leaked device-token table.
 *
 * The provider depends only on {@link WebSessionLedger} (token generation,
 * expiry, and revoke live here; the ledger is pure hash lookup). The REST
 * middleware composes the session's user via `UserLedger.getUserById` — this
 * module never couples to the user ledger.
 */
import { randomBytes } from "node:crypto";
import { hashDeviceToken } from "./crypto";
import type { WebSessionLedger } from "./store";

/** Default cookie-session lifetime: 30 days, absolute expiry (no sliding). */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const SESSION_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;

/** Material returned to the HTTP layer on {@link CookieSessionProvider.issue}. */
export interface CookieSessionMaterial {
    /** The secret the browser cookie carries; never persisted raw. */
    token: string;
    /** Per-session nonce echoed in an `x-csrf-token` header on mutating calls. */
    csrfToken: string;
    /** ISO timestamp at which the session stops verifying. */
    expiresAt: string;
}

/** The cookie-session API the server's REST layer codes against. */
export interface CookieSessionProvider {
    /** Creates a session row and returns the cookie + CSRF material. */
    issue(userId: number): CookieSessionMaterial;
    /**
     * Resolves a presented cookie token. Returns `null` for unknown or expired
     * tokens; an expired session is also deleted (garbage-collected on use).
     */
    verify(token: string): { userId: number; csrfToken: string } | null;
    /** Immediately invalidates one session (logout / sign-out-this-device). */
    revoke(token: string): void;
    /** Invalidates every session for a user (disable / sign-out-everywhere). */
    deleteAllForUser(userId: number): void;
}

/** Options for {@link createCookieSessionProvider}. */
export interface CookieSessionOptions {
    /** Session lifetime in ms (default {@link DEFAULT_SESSION_TTL_MS}). */
    ttlMs?: number;
    /** Injectable clock (ms) for expiry tests; defaults to `Date.now`. */
    now?: () => number;
}

/**
 * Builds a {@link CookieSessionProvider} over a {@link WebSessionLedger}.
 *
 * Tokens reuse the same SHA-256 `hashDeviceToken` primitive as device tokens,
 * so both credential families share one hash-at-rest precedent.
 */
export function createCookieSessionProvider(
    webSessions: WebSessionLedger,
    options: CookieSessionOptions = {},
): CookieSessionProvider {
    const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const now = options.now ?? Date.now;

    return {
        issue(userId) {
            const token =
                randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
            const csrfToken =
                randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
            const expiresAt = new Date(now() + ttlMs).toISOString();
            webSessions.createWebSession(
                userId,
                hashDeviceToken(token),
                csrfToken,
                expiresAt,
            );
            return { token, csrfToken, expiresAt };
        },
        verify(token) {
            const row = webSessions.getWebSessionByHash(hashDeviceToken(token));
            if (!row) {
                return null;
            }
            if (Date.parse(row.expiresAt) <= now()) {
                webSessions.deleteWebSession(row.secretHash);
                return null;
            }
            return { userId: row.userId, csrfToken: row.csrfToken };
        },
        revoke(token) {
            webSessions.deleteWebSession(hashDeviceToken(token));
        },
        deleteAllForUser(userId) {
            webSessions.deleteWebSessionsForUser(userId);
        },
    };
}
