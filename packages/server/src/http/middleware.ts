/**
 * REST auth middleware.
 *
 * `requireAuth(store, cookies)` accepts either a `Bearer <device token>`
 * header (the CLI path) or a `web_sessions` cookie managed by the
 * `CookieSessionProvider` (the portal path, #24), resolves whichever is
 * presented, and attaches the identity to the request as `jarv` (a 401 on any
 * failure). `requireOwner` then restricts a route to the owner account;
 * `requireCsrf` requires the per-session nonce on cookie-authed state changes.
 *
 * `jarv` is the non-guest member(s) of the `AuthContext` union, so handlers
 * mounted behind `requireAuth` read `authed(req).jarv` and the user fields are
 * guaranteed non-null by the type system — `authed()` in this module is the
 * only place a `Request` is asserted.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { MAX_TOKEN_LENGTH } from "@lukestanbery/jarvis-protocol";
import { hashDeviceToken } from "@lukestanbery/jarvis-auth";
import type {
    AppDatabase,
    AuthenticatedContext,
    CookieSessionProvider,
    SessionContext,
} from "@lukestanbery/jarvis-auth";
import { readSessionToken } from "./cookies";

/**
 * Request augmented with the identity resolved by {@link requireAuth}.
 *
 * Derived from the `AuthContext` union (not a duplicate shape), so it can
 * never drift: `jarv` is exactly the authenticated members, carrying the
 * non-null `user`/`device` pair for bearer auth or the `user` (+ CSRF nonce)
 * for cookie auth.
 */
export type AuthedRequest = Request & {
    jarv: AuthenticatedContext | SessionContext;
};

/**
 * Cookie-auth configuration shared by {@link requireAuth} and the router's
 * session routes. `provider` verifies the opaque token; `cookieName` is the
 * name used by the current TLS mode (see `http/cookies.ts`).
 */
export interface CookieAuthOptions {
    provider: CookieSessionProvider;
    cookieName: string;
}

/**
 * Narrows a route-handler `Request` to the {@link AuthedRequest} guaranteed by
 * `requireAuth`. The cast lives here — in the module that posts `jarv` — so
 * handlers themselves stay cast-free.
 */
export function authed(req: Request): AuthedRequest {
    return req as AuthedRequest;
}

/** Extracts the token from `Authorization: Bearer <token>`, if well-formed. */
function parseBearerToken(header: string | undefined): string | null {
    if (!header) {
        return null;
    }
    const match = /^Bearer (.+)$/i.exec(header);
    return match ? match[1] : null;
}

/**
 * Route guard: attaches the resolved identity as `req.jarv` or answers 401.
 *
 * Bearer first (the device-token path used by the CLI), then the session
 * cookie (the portal path). A bearer request also refreshes the device's
 * `last_seen_at`, mirroring the WS handshake. The cookie branch verifies via
 * the `CookieSessionProvider` and re-reads the user from the store, so a
 * disabled account — or a revoked/expired session — fails closed.
 */
export function requireAuth(
    store: AppDatabase,
    cookies: CookieAuthOptions,
): RequestHandler {
    const resolveBearer = (
        header: string | undefined,
    ): AuthenticatedContext | null => {
        const token = parseBearerToken(header);
        if (!token || token.length > MAX_TOKEN_LENGTH) {
            return null;
        }
        const identity = store.resolveTokenHash(hashDeviceToken(token));
        if (!identity) {
            return null;
        }
        store.touchDevice(identity.device.id);
        return {
            kind: "authed",
            user: identity.user,
            device: identity.device,
        };
    };

    const resolveCookie = (req: Request): SessionContext | null => {
        const token = readSessionToken(
            req,
            cookies.cookieName.startsWith("__Host-"),
        );
        if (!token) {
            return null;
        }
        const session = cookies.provider.verify(token);
        if (!session) {
            return null;
        }
        const user = store.getUserById(session.userId);
        if (!user) {
            return null;
        }
        return { kind: "session", user, csrfToken: session.csrfToken };
    };

    return (req: Request, res: Response, next: NextFunction): void => {
        const bearer = resolveBearer(req.headers.authorization);
        if (bearer) {
            (req as AuthedRequest).jarv = bearer;
            next();
            return;
        }
        const session = resolveCookie(req);
        if (session) {
            (req as AuthedRequest).jarv = session;
            next();
            return;
        }
        const attempted =
            parseBearerToken(req.headers.authorization) !== null ||
            readSessionToken(req, cookies.cookieName.startsWith("__Host-")) !==
                null;
        // Distinguish "no credential at all" from "a credential was presented
        // but didn't resolve", without naming which family was probed.
        res.status(401).json({
            error: attempted
                ? "invalid device token or session"
                : "a valid bearer token or session cookie is required",
        });
    };
}

/** Route guard: restricts a route to the owner account (after `requireAuth`). */
export function requireOwner(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const jarv = authed(req).jarv;
    // Belt-and-suspenders: the type system can't verify Express chain order,
    // so a misthread (requireOwner without requireAuth) answers a clean 403
    // instead of crashing on a missing `jarv`.
    if (!jarv || jarv.user.role !== "owner") {
        res.status(403).json({ error: "owner access required" });
        return;
    }
    next();
}

/**
 * Route guard: rejects state-changing requests authenticated by a session
 * cookie unless they carry the correct `x-csrf-token` nonce.
 *
 * Bearer-authenticated requests carry no ambient authority (an attacker's
 * page can't forge a `Bearer` header), so they pass through; a cookie is
 * attached by the browser automatically, which is exactly the CSRF vector —
 * so cookie-authed mutations always require the per-session nonce (compared
 * timing-safe against `jarv.csrfToken`). Mount after `requireAuth`.
 */
export function requireCsrf(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const jarv = authed(req).jarv;
    if (!jarv || jarv.kind !== "session") {
        next();
        return;
    }
    const presented = req.headers["x-csrf-token"];
    if (typeof presented !== "string" || presented.length === 0) {
        res.status(403).json({ error: "a CSRF token is required" });
        return;
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(jarv.csrfToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        res.status(403).json({ error: "invalid CSRF token" });
        return;
    }
    next();
}
