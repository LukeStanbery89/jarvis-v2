/**
 * REST auth middleware.
 *
 * `requireAuth(store)` reads a `Bearer <device token>` header, resolves it to
 * an identity, and attaches it to the request as `jarv` (a 401 on any
 * failure). `requireOwner` then restricts a route to the owner account.
 *
 * `jarv` is the `{ kind: "authed" }` member of the `AuthContext` union, so
 * handlers mounted behind `requireAuth` read `authed(req).jarv` and the
 * user/device fields are guaranteed non-null by the type system — `authed()`
 * in this module is the only place a `Request` is asserted.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { MAX_TOKEN_LENGTH } from "@lukestanbery/jarvis-protocol";
import { hashDeviceToken } from "@lukestanbery/jarvis-auth";
import type {
    AppDatabase,
    AuthenticatedContext,
} from "@lukestanbery/jarvis-auth";

/**
 * Request augmented with the identity resolved by {@link requireAuth}.
 *
 * Derived from the `AuthContext` union (not a duplicate shape), so it can
 * never drift: `jarv` is exactly the authenticated member, carrying the
 * non-null `user`/`device` pair.
 */
export type AuthedRequest = Request & { jarv: AuthenticatedContext };

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

/** Route guard: attaches the resolved identity as `req.jarv` or answers 401. */
export function requireAuth(store: AppDatabase): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const token = parseBearerToken(req.headers.authorization);
        if (!token || token.length > MAX_TOKEN_LENGTH) {
            res.status(401).json({ error: "a valid bearer token is required" });
            return;
        }
        const identity = store.resolveTokenHash(hashDeviceToken(token));
        if (!identity) {
            res.status(401).json({ error: "invalid device token" });
            return;
        }
        store.touchDevice(identity.device.id);
        (req as AuthedRequest).jarv = {
            kind: "authed",
            user: identity.user,
            device: identity.device,
        };
        next();
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
