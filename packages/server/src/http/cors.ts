/**
 * Cross-origin request handling for browser clients hosted on another machine
 * (issue #63).
 *
 * Hand-rolled rather than pulled from the `cors` package for the same reason
 * `rateLimit.ts` is dependency-free: the whole policy is one allowlist
 * comparison, and the repository already hand-rolls its CSRF check. The
 * important details are all recorded below, because each one is a way to ship a
 * subtly broken allowlist.
 *
 * ## Why an allowlist and never `*`
 *
 * The REST API is credentialed two ways — an `Authorization: Bearer` device
 * token and the `jarvis_session` cookie — and browsers reject
 * `Access-Control-Allow-Origin: *` on any credentialed request outright. A
 * wildcard would therefore be both useless and, if it ever "worked", a way to
 * hand a credentialed API to any site the user visits. So the configured origin
 * is echoed back verbatim, never collapsed to `*`, and only when it is an exact
 * match for a configured entry.
 *
 * ## Why unset means "deny"
 *
 * With no configured origins the middleware emits no `Access-Control-*` headers
 * at all and never short-circuits, which leaves same-origin requests (the SPAs
 * this server hosts at `/` and `/web`) completely unaffected while the browser
 * blocks every cross-origin caller. Defaulting to permissive would mean an
 * unconfigured server silently accepted credentialed calls from any site.
 *
 * ## Ordering
 *
 * `createApp` mounts this **before** `express.json()` and
 * `mountContractValidator`. A browser preflight is an `OPTIONS` request with no
 * body, and the contract validator rejects `OPTIONS` against paths that only
 * declare `POST`/`GET` — so a preflight that reached it would fail with a
 * validation error instead of the `Access-Control-Allow-*` headers that would
 * let the real request through. Answering it here keeps preflight off that path.
 *
 * ## Cookies across origins
 *
 * `Access-Control-Allow-Credentials` is sent for allowed origins so a future
 * cookie-based cross-origin client can work, but cookie auth does **not** work
 * cross-origin today: `setSessionCookie` emits `SameSite=Strict`, which browsers
 * refuse to send on cross-site requests, and `SameSite=None` is itself rejected
 * without `Secure` (i.e. over the default plain-HTTP LAN posture). Cross-origin
 * browser clients must therefore use device-token auth. See the same-origin and
 * cross-origin sections of the package README.
 *
 * Not subject to CORS: the `/ws` WebSocket upgrade, which browsers do not gate
 * on `Origin` (the server authenticates the socket with its `auth` frame
 * instead).
 */
import type { RequestHandler } from "express";
import { logger } from "../logger";
import { normalizeOrigin } from "../config";

/** How long a browser may cache a preflight result, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Methods advertised on a preflight. Deliberately a fixed list rather than an
 * echo of `Access-Control-Request-Method`: the surface is known, and echoing
 * would let a caller enumerate what the preflight would approve.
 */
const ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

/**
 * Builds the CORS middleware for `origins`.
 *
 * An empty or absent list installs a pass-through that adds no CORS headers,
 * which denies every cross-origin browser request without disturbing
 * same-origin traffic.
 *
 * A literal `*` entry is dropped with a warning: it cannot be honored for a
 * credentialed API, and silently ignoring it would leave an operator believing
 * they had opened the API up.
 */
export function createCorsMiddleware(
    origins: readonly string[] | undefined,
): RequestHandler {
    const allowed = new Set<string>();
    for (const origin of origins ?? []) {
        const normalized = normalizeOrigin(origin);
        if (normalized === "*") {
            logger.warn(
                'Ignoring "*" in JARVIS_CORS_ORIGINS: the API is credentialed, so wildcard origins are neither honored by browsers nor safe. List explicit origins.',
            );
            continue;
        }
        allowed.add(normalized);
    }

    if (allowed.size === 0) {
        return (_req, res, next) => {
            next();
        };
    }

    return (req, res, next) => {
        const header = req.headers.origin;
        // Same-origin requests omit `Origin` entirely; nothing to negotiate.
        if (typeof header !== "string" || header === "") {
            next();
            return;
        }

        // Always `Vary`, even when denying: a shared cache must not serve one
        // origin's CORS verdict to another.
        appendVary(res, "Origin");

        const origin = normalizeOrigin(header);
        if (!allowed.has(origin)) {
            // Deliberately no error status — the browser blocks a response that
            // simply lacks the header, and a 403 would leak the allowlist's
            // existence to a caller that can already see the refusal.
            next();
            return;
        }

        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");

        if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
            // Echo the requested headers (Authorization, x-csrf-token, …) so a
            // client sending a custom header preflights successfully.
            const requested = req.headers["access-control-request-headers"];
            res.setHeader(
                "Access-Control-Allow-Headers",
                typeof requested === "string" && requested !== ""
                    ? requested
                    : "Authorization, Content-Type, x-csrf-token, x-bootstrap-token",
            );
            res.setHeader(
                "Access-Control-Max-Age",
                String(PREFLIGHT_MAX_AGE_SECONDS),
            );
            res.status(204).end();
            return;
        }

        next();
    };
}

/**
 * Appends `field` to the response's `Vary` header without clobbering an
 * existing value (Express sets its own `Vary` for some responses).
 *
 * Typed structurally rather than as Express's `Response` so the append logic can
 * be exercised without a live response object.
 */
function appendVary(
    res: {
        getHeader(name: string): unknown;
        setHeader(name: string, value: string): unknown;
    },
    field: string,
) {
    const current = res.getHeader("Vary");
    if (current === "*") {
        return;
    }
    const existing =
        typeof current === "string"
            ? current.split(",")
            : Array.isArray(current)
              ? current.map(String)
              : [];
    if (
        existing.some(
            (value) => value.trim().toLowerCase() === field.toLowerCase(),
        )
    ) {
        return;
    }
    res.setHeader("Vary", [...existing, field].join(", "));
}
