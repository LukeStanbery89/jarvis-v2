/**
 * REST auth middleware.
 *
 * `requireAuth(store)` reads a `Bearer <device token>` header, resolves it to
 * an identity, and attaches it to the request as `jarv` (null on any
 * failure). `requireOwner` then restricts a route to the owner account.
 * Route handlers that passed `requireAuth` cast `req` to {@link AuthedRequest}
 * to see the guaranteed identity.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { MAX_TOKEN_LENGTH } from "@lukestanbery/jarvis-protocol";
import { hashDeviceToken } from "../auth";
import type { AppDatabase } from "../auth";
import type { AppDevice, AppUser } from "../auth";

/**
 * Request augmented with the identity resolved by {@link requireAuth}.
 *
 * Guests never reach REST routes (`requireAuth` rejects them), so `user` and
 * `device` are guaranteed non-null here.
 */
export interface AuthedRequest extends Request {
    jarv: { user: AppUser; device: AppDevice };
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
        const identity = store.resolveToken(hashDeviceToken(token));
        if (!identity) {
            res.status(401).json({ error: "invalid device token" });
            return;
        }
        store.touchDevice(identity.device.id);
        (req as AuthedRequest).jarv = {
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
    const jarv = (req as AuthedRequest).jarv;
    if (!jarv || jarv.user.role !== "owner") {
        res.status(403).json({ error: "owner access required" });
        return;
    }
    next();
}
