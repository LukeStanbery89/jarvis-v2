/**
 * Generic fixed-window call quota, keyed by user id.
 *
 * The shared machinery behind every metered-tool budget: the vision-model
 * call quota (#10) and the web-search quota (#9) are both "N successful
 * calls per user per window" — a shape deliberately unlike
 * `http/rateLimit.ts`'s RateLimiter, whose admit-then-clear semantics are
 * for guessing backoff, not for counting successful (billable) work. A
 * successful call stays counted; the budget renews only when the window
 * lapses.
 *
 * In-memory, per-process, synchronous — see the rate-limiting section of
 * the package README for the mechanism inventory.
 */
/** Refusal reason with the budget's renewal time. */
export type QuotaAdmission = { ok: true } | { ok: false; retryAfterMs: number };

export class FixedWindowQuota {
    /** Per-user timestamp of each call inside the current window. */
    private readonly hits = new Map<number, number[]>();

    constructor(
        private readonly callsPerWindow: number,
        private readonly windowMs = 60_000,
    ) {}

    /**
     * Reserves one call for `userId`, returning `{ ok: true }` or the reason
     * with when the budget renews.
     *
     * The refusal is shaped for the model to relay: tools turn it into
     * user-facing text ("try again in Ns") rather than throwing, so a
     * rate-limited call degrades to an answer instead of an error frame.
     * Synchronous, so a burst of concurrent calls cannot all observe a
     * pre-limit count (Node serializes the check-and-push).
     */
    tryAcquire(
        /** The owning user's numeric row id (`AppUser.id`). */
        userId: number,
        now: number = Date.now(),
    ): QuotaAdmission {
        const windowStart = now - this.windowMs;
        const live = (this.hits.get(userId) ?? []).filter(
            (t) => t > windowStart,
        );
        if (live.length >= this.callsPerWindow) {
            const oldest = Math.min(...live);
            return { ok: false, retryAfterMs: oldest + this.windowMs - now };
        }
        live.push(now);
        this.hits.set(userId, live);
        return { ok: true };
    }
}
