/**
 * The REST attachment-upload route (#10): `POST /api/attachments`.
 *
 * The browser client uploads an image (base64 in a JSON body) and gets back
 * `{ attachmentId }` to reference in a chat prompt. Requires authentication —
 * image analysis is a compute-expensive, per-user-billed surface, so guests
 * are refused here rather than at the socket (an upload they could never
 * analyze is still 4 MB of temp disk). CSRF stays on the route for
 * cookie-authenticated callers; bearer-token callers (the web client) have no
 * CSRF token by design.
 *
 * **Body size is enforced in two layers, and the split matters:**
 * 1. `createApp` mounts a per-route `express.json` parser for this path
 *    BEFORE the global 100 KB parser and the contract validator (review
 *    findings B1/B2) — the global parser would otherwise reject every real
 *    upload with its own generic 413. This layer bounds raw request bytes.
 * 2. This route enforces the *decoded* byte cap via the attachment store,
 *    answering `413 { error, code: "ATTACHMENT_TOO_LARGE", maxBytes }` so a
 *    client can retry smaller without parsing prose (review finding R10).
 * A body exceeding even the per-route parser's bound is mapped onto the same
 * shape by `app.ts`'s targeted error handler.
 */
import { Router } from "express";
import type { AppConfig } from "../config";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { requireAuth, requireCsrf, authed } from "./middleware";
import { createCookieSessionProvider } from "@lukestanbery/jarvis-auth";
import { sessionCookieName } from "./cookies";
import type { AttachmentStore } from "../attachments/store";
import { AttachmentError } from "../attachments/store";
import type { InFlightLimiter } from "../attachments/limiters";
import { logger } from "../logger";

/**
 * Builds the `/api/attachments` router.
 *
 * `store` backs authentication (shared with the management API); `attachments`
 * and `inFlight` are the process-wide attachment store and upload semaphore.
 */
export function createAttachmentRouter(
    store: AppDatabase,
    appConfig: AppConfig,
    attachments: AttachmentStore,
    inFlight: InFlightLimiter,
): Router {
    const router = Router();
    const config = appConfig.attachments;
    const secure = Boolean(appConfig.tlsCertPath && appConfig.tlsKeyPath);
    const authenticated = requireAuth(store, {
        provider: createCookieSessionProvider(store, {
            ttlMs: appConfig.sessionTtlMs,
        }),
        cookieName: sessionCookieName(secure),
    });

    router.post("/", authenticated, requireCsrf, (req, res) => {
        // Reject-when-saturated (not queue): a queue would grow memory
        // without bound, defeating the semaphore's purpose (see the module).
        const release = inFlight.tryAcquire();
        if (!release) {
            res.status(503).json({
                error: "too many uploads in progress; retry shortly",
            });
            return;
        }
        void (async () => {
            const jarv = authed(req).jarv;
            const raw = (req.body as { data?: unknown } | undefined)?.data;
            if (typeof raw !== "string" || raw.length === 0) {
                res.status(400).json({
                    error: "expected a 'data' field with base64 image bytes",
                });
                return;
            }
            // Buffer.from base64 is lenient — garbage silently decodes to
            // garbage bytes, which the store's magic-byte sniff then refuses
            // (403), matching the spec's "broken encoding surfaces as a
            // decode failure" note. No regex over megabytes of base64.
            const bytes = Buffer.from(raw, "base64");
            const attachmentId = await attachments.put(jarv.user.id, bytes);
            res.status(201).json({ attachmentId });
            // Fire-and-forget TTL sweep after every upload (R2: the sweep
            // tolerates failure; it must never fail the request).
            setImmediate(() => {
                void attachments.sweep().catch((err: unknown) => {
                    logger.warn(
                        `Attachment sweep failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                });
            });
        })()
            .catch((err: unknown) => {
                if (err instanceof AttachmentError) {
                    if (
                        err.code === "too-large" ||
                        err.code === "over-budget"
                    ) {
                        res.status(413).json({
                            error: err.message,
                            code: "ATTACHMENT_TOO_LARGE",
                            maxBytes: config?.maxBytes ?? 0,
                        });
                        return;
                    }
                    if (err.code === "unsupported") {
                        res.status(403).json({ error: err.message });
                        return;
                    }
                }
                logger.error(
                    `Attachment upload failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                res.status(500).json({ error: "internal server error" });
            })
            .finally(() => {
                release();
            });
    });

    return router;
}
