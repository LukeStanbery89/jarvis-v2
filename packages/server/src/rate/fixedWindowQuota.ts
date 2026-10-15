/**
 * Generic fixed-window call quota, keyed by caller identity.
 *
 * The shared machinery behind every metered-tool budget: the vision-model
 * call quota (#10) and the web-search quota (#9) are both "N successful
 * calls per user per window" — a shape deliberately unlike
 * `http/rateLimit.ts`'s RateLimiter, whose admit-then-clear semantics are
 * for guessing backoff, not for counting successful (billable) work. A
 * successful call stays counted; the budget renews only when the window
 * lapses.
 *
 * The key type defaults to `number` — every original caller keys on the
 * verified `userId` (`AppUser.id`), so those instantiations are unchanged.
 * The `wikipedia` tool (#8) admits guests, which have no numeric id, and
 * keys its guest budgets on string keys instead (a session id and a client
 * address) via `FixedWindowQuota<string>`.
 *
 * In-memory, per-process, synchronous — see the rate-limiting section of
 * the package README for the mechanism inventory. The per-key map is swept
 * of lapsed entries, so a caller-supplied key set (guest session ids, #8)
 * cannot grow the map without bound.
 */
/** Refusal reason with the budget's renewal time. */
export type QuotaAdmission = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Distinct keys retained before a sweep reclaims lapsed ones.
 *
 * Small enough that a guest-minted key set is pruned promptly, large enough
 * that a server with many real users never sweeps mid-request.
 */
const SWEEP_AT_KEYS = 1024;

export class FixedWindowQuota<K = number> {
    /** Per-key timestamp of each call inside the current window. */
    private readonly hits = new Map<K, number[]>();
    /** When the last reclamation sweep ran, so sweeping stays amortized. */
    private lastSweepAt = 0;

    constructor(
        private readonly callsPerWindow: number,
        private readonly windowMs = 60_000,
    ) {}

    /** Distinct keys currently tracked (diagnostics/tests). */
    get size(): number {
        return this.hits.size;
    }

    /**
     * Reserves one call for `key`, returning `{ ok: true }` or the reason
     * with when the budget renews.
     *
     * The refusal is shaped for the model to relay: tools turn it into
     * user-facing text ("try again in Ns") rather than throwing, so a
     * rate-limited call degrades to an answer instead of an error frame.
     * Synchronous, so a burst of concurrent calls cannot all observe a
     * pre-limit count (Node serializes the check-and-push).
     */
    tryAcquire(
        /**
         * The caller key: the owning user's numeric row id (`AppUser.id`)
         * for per-user budgets, or a namespaced string (`"session:<id>"`,
         * `"address:<ip>"`) for guest budgets.
         */
        key: K,
        now: number = Date.now(),
    ): QuotaAdmission {
        const windowStart = now - this.windowMs;
        this.sweep(windowStart, now);
        const live = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
        if (live.length >= this.callsPerWindow) {
            const oldest = Math.min(...live);
            return { ok: false, retryAfterMs: oldest + this.windowMs - now };
        }
        live.push(now);
        this.hits.set(key, live);
        return { ok: true };
    }

    /**
     * Reclaims every key whose calls have all lapsed.
     *
     * Guest budgets key on caller-supplied strings (#8) — a session id and a
     * peer address — so without this the map would retain one entry per
     * session id ever seen, which an unauthenticated caller can mint at the
     * prompt rate (the `/ws` chat path is not frequency-limited, #65). The
     * sweep runs on access, only once the key set is large, and at most once
     * per window, so it stays amortized and never changes a live budget.
     */
    private sweep(windowStart: number, now: number): void {
        if (this.hits.size <= SWEEP_AT_KEYS) return;
        if (now - this.lastSweepAt < this.windowMs) return;
        this.lastSweepAt = now;
        for (const [key, times] of this.hits) {
            // Timestamps are appended in increasing order, so the last is the
            // newest; an entry is fully lapsed when even that has expired.
            if ((times[times.length - 1] ?? 0) <= windowStart) {
                this.hits.delete(key);
            }
        }
    }
}
