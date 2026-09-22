/**
 * In-memory rate limiting for the credential endpoints.
 *
 * A tiny, dependency-free fixed-window counter with per-key lockout and
 * exponential backoff. Two key kinds are maintained for login: one per
 * `(ip, username)` and one aggregate per `ip`, so an attacker who spreads
 * guesses across many usernames is still throttled by the IP cap, while a
 * single account can't be hammered from many sources without the username key
 * firing first. Successful verification clears a key; the window slides on
 * expiry, so a client that stops misbehaving recovers on its own.
 *
 * Budget model: `admit()` consumes one attempt *synchronously*, before the
 * expensive scrypt verification runs. Node's single thread serializes the
 * increment, so a burst of concurrent guesses from one source cannot all race
 * past the configured limit while their verifications are still in flight —
 * later volleys are refused as soon as the counter crosses the threshold. The
 * first genuinely simultaneous volley may still overshoot the window budget by
 * up to its own width; that is inherent to any async verify and is the reason
 * `admit` is checked again on every request rather than once per window.
 *
 * State is intentionally in-memory only (a per-process map): the server is
 * single-instance, and a process restart simply resets the throttle —
 * acceptable for the LAN posture. This is not a general-purpose limiter: no
 * distributed state, no persistence, and `req.ip` is trusted as-is (document
 * `app.set('trust proxy', …)` if the server ever sits behind a reverse proxy).
 */
import type { RateLimitConfig } from "../config";

/** Per-key in-memory state. */
interface Entry {
    failures: number;
    lastAttemptAt: number;
    lockedUntil: number;
    backoffMs: number;
}

const MAX_BACKOFF = 32;

/** Per-key attempt budget for the credential endpoints. */
export class RateLimiter {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly config: RateLimitConfig) {}

    /**
     * Reserves one attempt for `key`, returning `null` when the request may
     * proceed or a lockout reason when it must be refused.
     *
     * Counting happens here — synchronously, before the caller's slow work —
     * so concurrent requests can't all observe a pre-limit count while their
     * verifications are in flight (see the module doc on the budget model).
     */
    admit(key: string): string | null {
        const now = Date.now();
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {
                failures: 0,
                lastAttemptAt: now,
                lockedUntil: 0,
                backoffMs: this.config.lockoutMs,
            };
            this.entries.set(key, entry);
        }
        if (now < entry.lockedUntil) {
            return `rate limited (${key}) until lockout expires`;
        }
        if (now - entry.lastAttemptAt > this.config.windowMs) {
            entry.failures = 0;
        }
        entry.failures += 1;
        entry.lastAttemptAt = now;
        if (entry.failures > this.config.maxFailures) {
            entry.lockedUntil = now + entry.backoffMs;
            entry.backoffMs = Math.min(
                entry.backoffMs * 2,
                this.config.lockoutMs * MAX_BACKOFF,
            );
            entry.failures = 0;
            return `rate limited (${key}) until lockout expires`;
        }
        return null;
    }

    /** Clears a key after a successful verification. */
    recordSuccess(key: string): void {
        this.entries.delete(key);
    }
}
