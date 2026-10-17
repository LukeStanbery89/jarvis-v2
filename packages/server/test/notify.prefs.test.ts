/**
 * Quiet-hours arithmetic (#90 2b).
 *
 * `prefs.ts` is now the one home for "is it quiet now" and "when does it stop
 * being quiet", because two callers ask: the notification service (which
 * suppresses a push) and the scheduler (which defers a reminder). These are the
 * pure functions, tested without a store or a clock, so a midnight/DST/edge
 * mistake shows up here rather than as a reminder that never comes back.
 */
import { describe, expect, it } from "vitest";
import {
    NOTIFY_QUIET_HOURS_PREF,
    quietHoursEnd,
    quietHoursHold,
    withinQuietHours,
    type QuietHours,
} from "../src/notify/prefs";

/** The common shape: a window that spans midnight. */
const WRAPPING: QuietHours = { start: "22:00", end: "07:00" };

describe("quiet-hours arithmetic", () => {
    it("is half-open at the end of the window", () => {
        // 06:59 is inside, 07:00 is not: the end minute is already over, which
        // is what makes a deferred reminder due exactly at the end.
        expect(withinQuietHours(WRAPPING, new Date(2026, 9, 20, 6, 59))).toBe(
            true,
        );
        expect(withinQuietHours(WRAPPING, new Date(2026, 9, 20, 7, 0))).toBe(
            false,
        );
        expect(withinQuietHours(WRAPPING, new Date(2026, 9, 20, 22, 0))).toBe(
            true,
        );
    });

    it("handles a window that does not wrap", () => {
        const window: QuietHours = { start: "12:00", end: "13:00" };
        expect(withinQuietHours(window, new Date(2026, 9, 20, 11, 59))).toBe(
            false,
        );
        expect(withinQuietHours(window, new Date(2026, 9, 20, 12, 30))).toBe(
            true,
        );
        expect(withinQuietHours(window, new Date(2026, 9, 20, 13, 1))).toBe(
            false,
        );
    });

    it("ends a wrapping window tomorrow", () => {
        // 23:30 is after today's 07:00, so the window closes tomorrow at 07:00.
        expect(quietHoursEnd(WRAPPING, new Date(2026, 9, 20, 23, 30))).toEqual(
            new Date(2026, 9, 21, 7, 0),
        );
        // 02:00 is still before today's 07:00.
        expect(quietHoursEnd(WRAPPING, new Date(2026, 9, 20, 2, 0))).toEqual(
            new Date(2026, 9, 20, 7, 0),
        );
    });

    it("ends a same-day window today, and moves on once it has passed", () => {
        const window: QuietHours = { start: "12:00", end: "13:00" };
        expect(quietHoursEnd(window, new Date(2026, 9, 20, 12, 30))).toEqual(
            new Date(2026, 9, 20, 13, 0),
        );
        // Exactly at the end the window is already over, so the next close is
        // tomorrow's — the half-open rule in this function's terms.
        expect(quietHoursEnd(window, new Date(2026, 9, 20, 13, 0))).toEqual(
            new Date(2026, 9, 21, 13, 0),
        );
    });

    it("holds every class but a timer", () => {
        const prefs = {
            [NOTIFY_QUIET_HOURS_PREF]: { start: "22:00", end: "07:00" },
        };
        const at = new Date(2026, 9, 20, 23, 30);
        expect(quietHoursHold(prefs, "notification", at)).toBe(true);
        expect(quietHoursHold(prefs, "reminder", at)).toBe(true);
        expect(quietHoursHold(prefs, "timer", at)).toBe(false);
    });

    it("treats an unreadable window as no quiet hours", () => {
        const at = new Date(2026, 9, 20, 23, 30);
        const values: unknown[] = [
            null,
            undefined,
            "22:00-07:00",
            { start: "22:00" },
            { start: "22:00", end: "22:00" },
            { start: "25:00", end: "07:00" },
        ];
        for (const value of values) {
            // The failure direction is always "no quiet hours": a hand-edited
            // pref must never silence a user indefinitely.
            expect(
                quietHoursHold(
                    { [NOTIFY_QUIET_HOURS_PREF]: value },
                    "reminder",
                    at,
                ),
            ).toBe(false);
        }
    });

    it("does not consult the master switch", () => {
        // `notify.enabled: false` is a kill switch, not a quiet hour: each
        // caller checks it first, and answering it here would make a deferred
        // reminder wait for a window that no longer means anything.
        const prefs = {
            "notify.enabled": false,
            [NOTIFY_QUIET_HOURS_PREF]: { start: "22:00", end: "07:00" },
        };
        expect(
            quietHoursHold(prefs, "reminder", new Date(2026, 9, 20, 23, 30)),
        ).toBe(true);
    });
});
