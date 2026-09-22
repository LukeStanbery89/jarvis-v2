import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/http/rateLimit";
import type { RateLimitConfig } from "../src/config";

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
        expect(limiter.admit("u:127.0.0.1:x")).toBeNull();
    });

    it("admits attempts up to the limit, then locks the key", () => {
        const limiter = new RateLimiter(CFG);
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            expect(limiter.admit("u:127.0.0.1:x")).toBeNull();
        }
        // The over-budget attempt engages the lockout.
        expect(limiter.admit("u:127.0.0.1:x")).toMatch(/rate limited/);
    });

    it("lifts the lockout after it expires; window resets the count", () => {
        const limiter = new RateLimiter({
            ...CFG,
            windowMs: 100,
            lockoutMs: 50,
        });
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            limiter.admit("k");
        }
        expect(limiter.admit("k")).toMatch(/rate limited/);
        vi.advanceTimersByTime(51);
        expect(limiter.admit("k")).toBeNull();
        // Reaching the limit again after the window slide is expected.
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            limiter.admit("k");
        }
        expect(limiter.admit("k")).toMatch(/rate limited/);
    });

    it("backs off exponentially across repeat lockouts", () => {
        const limiter = new RateLimiter(CFG);
        const lock = () => {
            for (let i = 0; i <= CFG.maxFailures; i += 1) {
                limiter.admit("k");
            }
        };
        lock();
        vi.advanceTimersByTime(CFG.lockoutMs);
        expect(limiter.admit("k")).toBeNull();
        lock();
        expect(limiter.admit("k")).toMatch(/rate limited/);
        vi.advanceTimersByTime(CFG.lockoutMs);
        // Second lockout is 2x; still blocked after only the base duration.
        expect(limiter.admit("k")).toMatch(/rate limited/);
        vi.advanceTimersByTime(CFG.lockoutMs);
        expect(limiter.admit("k")).toBeNull();
    });

    it("resets on success", () => {
        const limiter = new RateLimiter(CFG);
        limiter.admit("k");
        limiter.admit("k");
        limiter.recordSuccess("k");
        expect(limiter.admit("k")).toBeNull();
        // The budget is restored (one attempt already spent above), so the
        // remaining budget can be spent again before the lockout engages.
        for (let i = 0; i < CFG.maxFailures - 1; i += 1) {
            expect(limiter.admit("k")).toBeNull();
        }
        expect(limiter.admit("k")).toMatch(/rate limited/);
    });

    it("caps attempts across distinct usernames via the IP key", () => {
        const limiter = new RateLimiter(CFG);
        // authRoutes admits every attempt against both the user key and the
        // per-IP aggregate; that aggregate must trip even when each username
        // stays under its own limit.
        for (let u = 0; u < CFG.maxIpFailures; u += 1) {
            limiter.admit(`u:127.0.0.1:user${u}`);
            limiter.admit("ip:127.0.0.1");
        }
        expect(limiter.admit("ip:127.0.0.1")).toMatch(/rate limited/);
    });

    it("counts attempts at admit time, before any slow verification", () => {
        const limiter = new RateLimiter(CFG);
        // Three genuinely concurrent requests from one source each admit()
        // synchronously; the third is admitted, the fourth is refused while
        // the verifications are still in flight (maxFailures + this one).
        for (let i = 0; i < CFG.maxFailures; i += 1) {
            expect(limiter.admit("u:127.0.0.1:x")).toBeNull();
        }
        expect(limiter.admit("u:127.0.0.1:x")).toMatch(/rate limited/);
    });
});
