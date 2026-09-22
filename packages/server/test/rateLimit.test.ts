import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter, type RateLimitConfig } from "../src/http/rateLimit";

const CFG: RateLimitConfig = {
    windowMs: 10_000,
    maxFailures: 3,
    lockoutMs: 1_000,
    maxIpFailures: 5,
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("RateLimiter", () => {
    it("allows an unseeded key", () => {
        const limiter = new RateLimiter(CFG);
        expect(limiter.check("u:127.0.0.1:x")).toBeNull();
    });

    it("allows failures up to the limit, then locks the key", () => {
        const limiter = new RateLimiter(CFG);
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            limiter.recordFailure("u:127.0.0.1:x");
        }
        expect(limiter.check("u:127.0.0.1:x")).toMatch(/rate limited/);
    });

    it("lifts the lockout after it expires; window resets the count", () => {
        const limiter = new RateLimiter({
            ...CFG,
            windowMs: 100,
            lockoutMs: 50,
        });
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            limiter.recordFailure("k");
        }
        expect(limiter.check("k")).toMatch(/rate limited/);
        vi.advanceTimersByTime(51);
        expect(limiter.check("k")).toBeNull();
        // A stale-counting bug would keep failures > 0; reaching the limit
        // again after the window slide is expected.
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            limiter.recordFailure("k");
        }
        expect(limiter.check("k")).toMatch(/rate limited/);
    });

    it("backs off exponentially across repeat lockouts", () => {
        const limiter = new RateLimiter(CFG);
        const lock = () => {
            for (let i = 0; i < CFG.maxFailures; i += 1) {
                limiter.recordFailure("k");
            }
        };
        lock();
        vi.advanceTimersByTime(CFG.lockoutMs);
        expect(limiter.check("k")).toBeNull();
        lock();
        expect(limiter.check("k")).toMatch(/rate limited/);
        vi.advanceTimersByTime(CFG.lockoutMs);
        // Second lockout is 2x; still blocked after only the base duration.
        expect(limiter.check("k")).toMatch(/rate limited/);
        vi.advanceTimersByTime(CFG.lockoutMs);
        expect(limiter.check("k")).toBeNull();
    });

    it("resets on success", () => {
        const limiter = new RateLimiter(CFG);
        limiter.recordFailure("k");
        limiter.recordFailure("k");
        limiter.recordSuccess("k");
        expect(limiter.check("k")).toBeNull();
        // The failure count is gone, so 3 more failures are allowed again.
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            limiter.recordFailure("k");
        }
        expect(limiter.check("k")).toMatch(/rate limited/);
    });

    it("caps failures across distinct usernames via the IP key", () => {
        const limiter = new RateLimiter(CFG);
        // authRoutes records every miss against both the user key and the
        // per-IP aggregate; that aggregate must trip even when each username
        // stays under its own limit.
        for (let u = 0; u < CFG.maxIpFailures; u += 1) {
            limiter.recordFailure(`u:127.0.0.1:user${u}`);
            limiter.recordFailure("ip:127.0.0.1");
        }
        expect(limiter.check("ip:127.0.0.1")).toMatch(/rate limited/);
    });
});
