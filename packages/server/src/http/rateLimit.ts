/**
 * In-memory rate limiting for the credential endpoints.
 *
 * A tiny, dependency-free fixed-window counter with per-key lockout and
 * exponential backoff. Two key kinds are maintained for login: one per
 * `(ip, username)` and one aggregate per `ip`, so an attacker who spreads
 * guesses across many usernames is still throttled by the IP cap, while a
 * single account can't be hammered from many sources without the username key
 * firing first. Success clears a key; expiry clears failures, so a client
 * that stops misbehaving recovers on its own. State is intentionally
 * in-memory only (a per-process map): the server is single-instance, and a
 * process restart simply resets the throttle — acceptable for the LAN posture.
 *
 * This is not a general-purpose limiter: no distributed state, no
 * persistence, and `req.ip` is trusted as-is (document `app.set('trust
 * proxy', …)` if the server ever sits behind a reverse proxy).
 */
export interface RateLimitConfig {
    /** Fixed window during which failures accumulate. */
    windowMs: number;
    /** Failures allowed per key before a lockout begins. */
    maxFailures: number;
    /** Base lockout duration; doubles (×2, ×4, …) per repeat until capped. */
    lockoutMs: number;
    /** Aggregate failure cap per IP, regardless of which username failed. */
    maxIpFailures: number;
}

/** LAN-reasonable defaults: 10 attempts/user/15 min, 100 misses/IP/15 min. */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
    windowMs: 15 * 60_000,
    maxFailures: 10,
    lockoutMs: 60_000,
    maxIpFailures: 100,
};

/** Per-key in-memory state. */
interface Entry {
    failures: number;
    lastFailureAt: number;
    lockedUntil: number;
    backoffMs: number;
}

const MAX_BACKOFF = 32;

/** Returns `null` to allow a request, or a lockout-reason string to block it. */
export class RateLimiter {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly config: RateLimitConfig) {}

    /** Prunes stale entries, then returns whether `key`s request may proceed. */
    check(key: string): string | null {
        const now = Date.now();
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (now < entry.lockedUntil) {
            return `rate limited (${key}) until lockout expires`;
        }
        if (
            now - entry.lastFailureAt > this.config.windowMs &&
            now >= entry.lockedUntil
        ) {
            this.entries.delete(key);
        }
        return null;
    }

    /** Records a failed verification for `key`, escalating to a lockout. */
    recordFailure(key: string): void {
        const now = Date.now();
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {
                failures: 0,
                lastFailureAt: now,
                lockedUntil: 0,
                backoffMs: this.config.lockoutMs,
            };
            this.entries.set(key, entry);
        }
        if (now < entry.lockedUntil) {
            return;
        }
        if (now - entry.lastFailureAt > this.config.windowMs) {
            entry.failures = 0;
        }
        entry.failures += 1;
        entry.lastFailureAt = now;
        if (entry.failures >= this.config.maxFailures) {
            entry.lockedUntil = now + entry.backoffMs;
            entry.backoffMs = Math.min(
                entry.backoffMs * 2,
                this.config.lockoutMs * MAX_BACKOFF,
            );
            entry.failures = 0;
        }
    }

    /** Clears a key after a successful verification. */
    recordSuccess(key: string): void {
        this.entries.delete(key);
    }
}
