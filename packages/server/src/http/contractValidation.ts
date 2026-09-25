/**
 * Runtime enforcement of the REST contract (`spec/openapi.yaml` in
 * `@lukestanbery/jarvis-contracts`).
 *
 * Mounts `express-openapi-validator` ahead of `/health` and the `/api` router:
 * request shapes are always validated (`validateRequests`), and response
 * shapes are checked only when the `JARVIS_API_CONTRACT=verify` flag is set
 * (`validateResponses`) — which `npm run dev` and the contract tests enable.
 * `validateSecurity` is intentionally off: this app's auth is OR-composed
 * (bearer device token **or** session cookie) with per-route `requireCsrf` /
 * `requireOwner` owned by `middleware.ts`, and that middleware stays the sole
 * judge of identity. The validator is additive — the hand-rolled checks in
 * `authRoutes.ts` stay in place while the spec takes over shape ownership.
 */
import type { Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { middleware as openApiMiddleware } from "express-openapi-validator";
import { logger } from "../logger";

const contractRequire = createRequire(__filename);

/** Everything outside the contract surface (portal SPA, other paths) is skipped. */
const IGNORED_PATHS = /^\/(?!api|health)/;

/**
 * Locates the REST spec the validator runs against: the Redocly-bundled
 * single-file artifact when it exists, else the source YAML. Both ship with
 * `@lukestanbery/jarvis-contracts` (`spec/` is in its published `files`), so
 * this only returns null when the dependency is missing entirely.
 */
export function resolveContractSpec(): string | null {
    try {
        const pkgRoot = path.dirname(
            contractRequire.resolve(
                "@lukestanbery/jarvis-contracts/package.json",
            ),
        );
        const bundled = path.join(pkgRoot, "spec/.bundle/openapi.yaml");
        if (existsSync(bundled)) {
            return bundled;
        }
        const source = path.join(pkgRoot, "spec/openapi.yaml");
        return existsSync(source) ? source : null;
    } catch {
        return null;
    }
}

/**
 * Mounts the contract-validator middleware ahead of `/health` and `/api`.
 *
 * Request validation is always on; response validation is opt-in through
 * `verifyResponses`. A missing spec yields a loud warning plus a working
 * server (the same exists-or-warn posture as the web portal), never a crash.
 */
export function mountContractValidator(
    app: Express,
    verifyResponses: boolean,
): void {
    const apiSpec = resolveContractSpec();
    if (!apiSpec) {
        logger.warn(
            "REST contract spec not found; skipping contract validation (install and build @lukestanbery/jarvis-contracts)",
        );
        return;
    }
    app.use(
        openApiMiddleware({
            apiSpec,
            validateRequests: true,
            validateResponses: verifyResponses,
            validateSecurity: false,
            ignorePaths: IGNORED_PATHS,
        }),
    );
    logger.info(
        `REST contract validation active (${apiSpec}); responses ${verifyResponses ? "verified (JARVIS_API_CONTRACT=verify)" : "not verified — set JARVIS_API_CONTRACT=verify to enable"}`,
    );
}

/**
 * Recognizes an `express-openapi-validator` error and maps it to the declared
 * `Error` shape (`{ error: string }`).
 *
 * Client-reachable violations become `{ error: <first message> }` with the
 * reported status (bad requests). Contract violations (`status >= 500`) are
 * server bugs — their detail is logged locally and the client gets the
 * generic internal-error body so spec internals never leak.
 */
export function contractErrorResponse(err: unknown): {
    status: number;
    error: string;
} | null {
    const errors = (err as { errors?: { message?: unknown }[] } | null)?.errors;
    const status = (err as { status?: unknown } | null)?.status;
    // A numeric status is part of the validator's error contract; requiring it
    // keeps unrelated `errors`-carrying errors (e.g. AggregateError) on the
    // default `next(err)` path.
    if (
        !Array.isArray(errors) ||
        errors.length === 0 ||
        typeof status !== "number"
    ) {
        return null;
    }
    const first = errors.find((e) => typeof e?.message === "string")?.message;
    if (status >= 500) {
        logger.error(
            `REST contract violated by this response: ${first ?? "unknown"}`,
        );
        return { status: 500, error: "internal server error" };
    }
    return {
        status,
        error: typeof first === "string" ? first : "request failed validation",
    };
}
