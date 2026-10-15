/**
 * The owner-guard + quota-refusal scaffold shared by the metered tools
 * (#103).
 *
 * The four signed-in-only metered tools (`getWeather`, `webSearch`,
 * `homeAssistant`, `analyzeImage`) open with the same ~20 lines: refuse guest
 * sockets with "requires signing in" text, then check the per-user quota and
 * refuse with "rate limited — try again in about Ns" text. The copies had
 * drifted in wording; both sentences now come from here, so the
 * model-facing contract is identical across tools and the
 * `Math.max(1, Math.ceil(ms/1000))` math has one home. The quota is still
 * checked per tool before any fetch, and a refusal stays a returnable string
 * (never a thrown error), so a rate-limited call degrades to an answer the
 * model can relay.
 *
 * {@link requireMeteredUser} is the signed-in-only guard those four use.
 * {@link requireMeteredCaller} is the variant for a tool that also serves
 * guests (#8): a verified `userId` still charges the per-user budget, while
 * a guest is charged to two stricter buckets — a per-`sessionId` one and an
 * aggregate per-address one — so guests get a much tighter, reconnect-proof
 * allowance. The refusal wording is shared, so both gates read the same.
 */
import type { ToolRuntime } from "@langchain/core/tools";
import type { QuotaAdmission } from "../../rate/fixedWindowQuota";
import { logger } from "../../logger";

/** The subset of the fixed-window quota the scaffold needs. */
export type QuotaGate<K = number> = {
    /**
     * Reserves one call for `key` — the `FixedWindowQuota` shape, kept
     * structural so tests can inject a fake. `K` is the verified user's
     * numeric row id for per-user budgets, or a namespaced string
     * (`"session:<id>"`, `"address:<ip>"`) for guest budgets (#8).
     */
    tryAcquire: (key: K) => QuotaAdmission;
};

/**
 * The gate's verdict: admitted with the verified owner id, or refused with
 * the model-facing text to return.
 */
export type MeteredGate =
    { ok: true; userId: number } | { ok: false; text: string };

/**
 * The caller a metered call is charged to: a signed-in user (a verified
 * numeric id) or a guest (no id at all — a session and a client address).
 */
export type MeteredCaller =
    | { readonly kind: "user"; readonly userId: number }
    | {
          readonly kind: "guest";
          readonly sessionId: string;
          readonly clientIp: string;
      };

/**
 * The verdict of a caller-admitting tool's guard: the admitted caller, or
 * the model-facing text to return instead of calling the provider.
 */
export type CallerAdmission =
    { ok: true; caller: MeteredCaller } | { ok: false; text: string };

/**
 * The extra budgets a guest needs (#8).
 *
 * A guest has no identity, so one bucket cannot both stay strict and resist
 * a reconnect (a fresh socket means a fresh `sessionId`, chosen by the
 * client). Two keys are admitted together, exactly like the credential
 * throttle's per-username + per-IP pair: a strict per-`sessionId` bucket
 * bounds one conversation, and an aggregate per-address bucket bounds the
 * client's total, so rotating sessions does not reset the budget.
 */
export interface GuestQuotas {
    /** Strict bucket keyed by `"session:<sessionId>"`. */
    readonly session: QuotaGate<string>;
    /** Aggregate bucket keyed by `"address:<clientIp>"`. */
    readonly address: QuotaGate<string>;
}

/** The budgets a caller-admitting tool needs (#8). */
export interface MeteredCallerQuotas {
    /** Per-user budget; keyed by the verified numeric `userId`. */
    readonly user: QuotaGate;
    /** Guest budgets; omit to keep the tool signed-in only. */
    readonly guest?: GuestQuotas;
}

/**
 * Renders the quota-refusal clause: "try again in about Ns", floored at 1
 * so a just-expired window never answers "0s".
 */
export function retryAfterText(retryAfterMs: number): string {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return `try again in about ${seconds}s`;
}

/** Renders the quota-refusal clause for a caller-admitting tool. */
function rateLimitedText(subject: string, retryAfterMs: number): string {
    return `${subject} is rate limited — ${retryAfterText(retryAfterMs)}.`;
}

/** Renders the sign-in refusal for a tool that admits no guests. */
function signInRequiredText(subject: string): string {
    return `${subject} requires signing in. Ask the user to authenticate and retry.`;
}

/**
 * Runs the two gates every metered tool opens with: the owner guard (a
 * guest socket has no verified `userId` — refuse with sign-in text) and the
 * per-user quota (refused calls get the wait, floored and model-facing).
 *
 * `names.subject` is the model-facing noun phrase ("Weather lookup"),
 * `names.logName` the server-log tool name ("getWeather") for the warn line
 * a guest invocation emits.
 *
 * Signed-in only: to admit guests as well, use
 * {@link requireMeteredCaller} with a `guest` budget set (#8).
 */
export function requireMeteredUser(
    runtime: ToolRuntime,
    quota: QuotaGate,
    names: { subject: string; logName: string },
): MeteredGate {
    const owner = runtime.configurable?.userId;
    if (typeof owner !== "number" || !Number.isInteger(owner)) {
        logger.warn(`${names.logName} called without a user id`);
        return { ok: false, text: signInRequiredText(names.subject) };
    }
    const admission = quota.tryAcquire(owner);
    if (!admission.ok) {
        return {
            ok: false,
            text: rateLimitedText(names.subject, admission.retryAfterMs),
        };
    }
    return { ok: true, userId: owner };
}

/**
 * Runs the same guard for a tool that also serves guests (#8).
 *
 * A verified numeric `userId` charges the per-user budget and returns a
 * `"user"` caller. Otherwise, when `quotas.guest` is configured, the call
 * is charged to BOTH guest buckets — the strict per-session one and the
 * aggregate per-address one — and only then admitted; the guest reaches the
 * provider with no user id, which such a tool must be written to accept.
 * Without guest budgets (or without the session/address the guest keys need)
 * the refusal text is the signed-in-only wording, so a mis-wired graph
 * degrades to "requires signing in" rather than an unbounded free-for-all.
 */
export function requireMeteredCaller(
    runtime: ToolRuntime,
    quotas: MeteredCallerQuotas,
    names: { subject: string; logName: string },
): CallerAdmission {
    const owner = runtime.configurable?.userId;
    if (typeof owner === "number" && Number.isInteger(owner)) {
        const admission = quotas.user.tryAcquire(owner);
        if (!admission.ok) {
            return {
                ok: false,
                text: rateLimitedText(names.subject, admission.retryAfterMs),
            };
        }
        return { ok: true, caller: { kind: "user", userId: owner } };
    }
    if (!quotas.guest) {
        logger.warn(`${names.logName} called without a user id`);
        return { ok: false, text: signInRequiredText(names.subject) };
    }
    const sessionId = runtime.configurable?.sessionId;
    const clientIp = runtime.configurable?.clientIp;
    if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        typeof clientIp !== "string" ||
        clientIp.length === 0
    ) {
        // A guest turn always carries both (stamped by `runAgent`); missing
        // either means the graph was wired without them, so refuse rather
        // than admit an unkeyed caller.
        logger.warn(
            `${names.logName} guest call without a session id or client address`,
        );
        return {
            ok: false,
            text: `${names.subject} is unavailable right now. Try again in a moment.`,
        };
    }
    const session = quotas.guest.session.tryAcquire(`session:${sessionId}`);
    if (!session.ok) {
        return {
            ok: false,
            text: rateLimitedText(names.subject, session.retryAfterMs),
        };
    }
    const address = quotas.guest.address.tryAcquire(`address:${clientIp}`);
    if (!address.ok) {
        return {
            ok: false,
            text: rateLimitedText(names.subject, address.retryAfterMs),
        };
    }
    return { ok: true, caller: { kind: "guest", sessionId, clientIp } };
}
