/**
 * Quota mechanisms for the attachment surface (#10).
 *
 * Three independent bounds, none of which reuse `http/rateLimit.ts`'s
 * `RateLimiter` — deliberately. That limiter counts every `admit()` and
 * clears the key on success, which is the right shape for guessing backoff
 * and the wrong shape for every budget here: a vision-call quota must count
 * successful calls (there is no "failure" to forgive), a byte ledger must
 * track *held* bytes rather than attempts, and an upload semaphore must bound
 * concurrency rather than frequency. See the rate-limiting section of the
 * package README.
 *
 * All three are in-memory, per-process, and synchronous — the server is
 * single-instance by design, and a restart legitimately forgets its quotas.
 */

/**
 * Fixed-window quota on vision-model analysis calls, keyed by user.
 *
 * The only control that bounds compute abuse of the (large) VL model: bytes
 * on disk are cheap, a 35B-parameter inference is not. Unlike the credential
 * throttle, a successful call stays counted — the window must lapse before
 * the budget renews. `tryAcquire` is synchronous, so a burst of concurrent
 * tool calls cannot all observe a pre-limit count (Node serializes the
 * check-and-push).
 */
export class VlCallLimiter {
    /** Per-user timestamp of each call inside the current window. */
    private readonly hits = new Map<string, number[]>();

    constructor(
        private readonly callsPerWindow: number,
        private readonly windowMs = 60_000,
    ) {}

    /**
     * Reserves one VL call for `userId`, returning `{ ok: true }` or the
     * reason with when the budget renews.
     *
     * The refusal is shaped for the model to relay: the tool turns it into
     * user-facing text rather than throwing, so a rate-limited analysis
     * degrades to a "try again in Ns" answer instead of an error frame.
     */
    tryAcquire(
        userId: string,
        now: number = Date.now(),
    ): { ok: true } | { ok: false; retryAfterMs: number } {
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

/**
 * Per-user ledger of bytes currently held by live attachments.
 *
 * Bounds temp-disk exhaustion, which a per-file cap cannot: one user could
 * otherwise hold unlimited 3 MB images inside their TTL. `tryReserve` fails
 * when the reservation would push the user over their total; `release`
 * returns bytes to the budget. The ledger trusts its caller to release each
 * reservation exactly once — the attachment store owns that idempotency
 * (releases are keyed on registry-entry presence there), so a double release
 * in the ledger is a programming error, not a recoverable state.
 */
export class ByteLedger {
    private readonly held = new Map<string, number>();

    constructor(private readonly maxTotalBytes: number) {}

    /**
     * Reserves `bytes` for `userId`, or returns `false` when the user's live
     * total would exceed the budget. Zero-byte reservations always succeed.
     */
    tryReserve(userId: string, bytes: number): boolean {
        const current = this.held.get(userId) ?? 0;
        if (current + bytes > this.maxTotalBytes) {
            return false;
        }
        this.held.set(userId, current + bytes);
        return true;
    }

    /** Returns `bytes` to `userId`'s budget, flooring at zero. */
    release(userId: string, bytes: number): void {
        const current = this.held.get(userId) ?? 0;
        this.held.set(userId, Math.max(0, current - bytes));
    }

    /** Bytes currently held by `userId`. */
    heldBytes(userId: string): number {
        return this.held.get(userId) ?? 0;
    }
}

/**
 * Server-wide semaphore bounding concurrent uploads.
 *
 * Bounds per-upload memory: the body is already parsed when a handler runs,
 * so the bound applies to decode/write processing of at most `max` uploads at
 * once. Saturated acquires are **rejected, not queued** — a queue would let
 * memory grow without bound, defeating the point; the client sees a clear
 * "too many uploads" error and retries.
 */
export class InFlightLimiter {
    private current = 0;

    constructor(private readonly max: number) {}

    /**
     * Takes one slot, returning the release function — or `null` when
     * `max` uploads are already in flight. The returned release is
     * single-use by contract (the caller releases exactly once, in a
     * `finally`).
     */
    tryAcquire(): (() => void) | null {
        if (this.current >= this.max) {
            return null;
        }
        this.current += 1;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.current -= 1;
        };
    }

    /** Slots currently held. */
    inFlight(): number {
        return this.current;
    }
}
