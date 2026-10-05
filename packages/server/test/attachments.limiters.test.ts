import { describe, expect, it } from "vitest";
import {
    ByteLedger,
    InFlightLimiter,
    VlCallLimiter,
} from "../src/attachments/limiters";

describe("VlCallLimiter", () => {
    it("admits calls up to the per-window budget", () => {
        const limiter = new VlCallLimiter(3, 60_000);
        expect(limiter.tryAcquire(1, 1000).ok).toBe(true);
        expect(limiter.tryAcquire(1, 1001).ok).toBe(true);
        expect(limiter.tryAcquire(1, 1002).ok).toBe(true);
    });

    it("refuses past the budget with the window's renewal time", () => {
        const limiter = new VlCallLimiter(2, 60_000);
        limiter.tryAcquire(1, 1000);
        limiter.tryAcquire(1, 2000);
        const result = limiter.tryAcquire(1, 3000);
        // Renewal is measured from the OLDEST live hit (1000): the budget
        // reopens at 1000 + 60000 = 61000, i.e. 58000ms after now=3000.
        expect(result).toEqual({
            ok: false,
            retryAfterMs: 58_000,
        });
    });

    it("renews when the window lapses", () => {
        const limiter = new VlCallLimiter(1, 10_000);
        expect(limiter.tryAcquire(1, 1000).ok).toBe(true);
        expect(limiter.tryAcquire(1, 2000).ok).toBe(false);
        // 11s > 1s + 10s window: budget is fresh again
        expect(limiter.tryAcquire(1, 11_001).ok).toBe(true);
    });

    it("keys per user — one user's budget never consumes another's", () => {
        const limiter = new VlCallLimiter(1, 60_000);
        expect(limiter.tryAcquire(2, 1000).ok).toBe(true);
        expect(limiter.tryAcquire(3, 1000).ok).toBe(true);
        expect(limiter.tryAcquire(2, 1000).ok).toBe(false);
    });

    it("drops expired timestamps so stale calls stop counting", () => {
        const limiter = new VlCallLimiter(2, 10_000);
        limiter.tryAcquire(1, 0);
        limiter.tryAcquire(1, 1000);
        // At 10500 only the t=1000 hit is still in-window (t=0 lapsed), so
        // one slot is free — proving expired hits no longer count.
        expect(limiter.tryAcquire(1, 10_500).ok).toBe(true);
        expect(limiter.tryAcquire(1, 10_501).ok).toBe(false);
        // 11001 > 1000 + 10000: the second hit lapses too, freeing a slot.
        expect(limiter.tryAcquire(1, 11_001).ok).toBe(true);
    });
});

describe("ByteLedger", () => {
    it("reserves within the budget", () => {
        const ledger = new ByteLedger(1000);
        expect(ledger.tryReserve(1, 400)).toBe(true);
        expect(ledger.heldBytes(1)).toBe(400);
    });

    it("refuses a reservation that would exceed the budget", () => {
        const ledger = new ByteLedger(1000);
        ledger.tryReserve(1, 700);
        expect(ledger.tryReserve(1, 301)).toBe(false);
        expect(ledger.tryReserve(1, 300)).toBe(true);
    });

    it("releases bytes back to the budget", () => {
        const ledger = new ByteLedger(1000);
        ledger.tryReserve(1, 800);
        ledger.release(1, 800);
        expect(ledger.tryReserve(1, 1000)).toBe(true);
    });

    it("floors at zero instead of going negative", () => {
        const ledger = new ByteLedger(1000);
        ledger.release(1, 50); // release without reservation
        ledger.tryReserve(1, 100);
        ledger.release(1, 999);
        expect(ledger.heldBytes(1)).toBe(0);
    });

    it("tracks users independently", () => {
        const ledger = new ByteLedger(1000);
        expect(ledger.tryReserve(2, 1000)).toBe(true);
        expect(ledger.tryReserve(3, 1)).toBe(true);
    });
});

describe("InFlightLimiter", () => {
    it("admits up to max concurrent holders", () => {
        const limiter = new InFlightLimiter(2);
        const a = limiter.tryAcquire();
        const b = limiter.tryAcquire();
        expect(a).toBeTypeOf("function");
        expect(b).toBeTypeOf("function");
        expect(limiter.tryAcquire()).toBeNull();
        expect(limiter.inFlight()).toBe(2);
    });

    it("admits again after release", () => {
        const limiter = new InFlightLimiter(1);
        const release = limiter.tryAcquire()!;
        expect(limiter.tryAcquire()).toBeNull();
        release();
        expect(limiter.tryAcquire()).not.toBeNull();
    });

    it("ignores a double release", () => {
        const limiter = new InFlightLimiter(1);
        const release = limiter.tryAcquire()!;
        release();
        release();
        expect(limiter.inFlight()).toBe(0);
    });
});
