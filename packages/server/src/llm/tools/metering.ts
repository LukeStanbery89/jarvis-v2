/**
 * The owner-guard + quota-refusal scaffold shared by the metered tools
 * (#103).
 *
 * All four metered tools (`getWeather`, `webSearch`, `homeAssistant`,
 * `analyzeImage`) open with the same ~20 lines: refuse guest sockets with
 * "requires signing in" text, then check the per-user quota and refuse with
 * "rate limited — try again in about Ns" text. The copies had drifted in
 * wording; both sentences now come from here, so the model-facing contract
 * is identical across tools and the `Math.max(1, Math.ceil(ms/1000))` math
 * has one home. The quota is still checked per tool before any fetch, and a
 * refusal stays a returnable string (never a thrown error), so a
 * rate-limited call degrades to an answer the model can relay.
 */
import type { ToolRuntime } from "@langchain/core/tools";
import type { QuotaAdmission } from "../../rate/fixedWindowQuota";
import { logger } from "../../logger";

/** The subset of the fixed-window quota the scaffold needs. */
export type QuotaGate = {
    /**
     * Reserves one call for `userId` — the `FixedWindowQuota` shape, kept
     * structural so tests can inject a fake.
     */
    tryAcquire: (userId: number) => QuotaAdmission;
};

/**
 * The gate's verdict: admitted with the verified owner id, or refused with
 * the model-facing text to return.
 */
export type MeteredGate =
    { ok: true; userId: number } | { ok: false; text: string };

/**
 * Renders the quota-refusal clause: "try again in about Ns", floored at 1
 * so a just-expired window never answers "0s".
 */
export function retryAfterText(retryAfterMs: number): string {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return `try again in about ${seconds}s`;
}

/**
 * Runs the two gates every metered tool opens with: the owner guard (a
 * guest socket has no verified `userId` — refuse with sign-in text) and the
 * per-user quota (refused calls get the wait, floored and model-facing).
 *
 * `names.subject` is the model-facing noun phrase ("Weather lookup"),
 * `names.logName` the server-log tool name ("getWeather") for the warn line
 * a guest invocation emits.
 */
export function requireMeteredUser(
    runtime: ToolRuntime,
    quota: QuotaGate,
    names: { subject: string; logName: string },
): MeteredGate {
    const owner = runtime.configurable?.userId;
    if (typeof owner !== "number" || !Number.isInteger(owner)) {
        logger.warn(`${names.logName} called without a user id`);
        return {
            ok: false,
            text: `${names.subject} requires signing in. Ask the user to authenticate and retry.`,
        };
    }
    const admission = quota.tryAcquire(owner);
    if (!admission.ok) {
        return {
            ok: false,
            text: `${names.subject} is rate limited — ${retryAfterText(admission.retryAfterMs)}.`,
        };
    }
    return { ok: true, userId: owner };
}
