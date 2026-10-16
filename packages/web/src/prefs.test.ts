/**
 * Preference helper tests.
 *
 * Two things need pinning. First, a stored value must read back the way the
 * *server* would read it: a malformed pref is ignored rather than fatal, so the
 * panel must show the same effective behaviour — and flag the value as
 * unreadable rather than silently showing the default. Second, what the panel
 * writes must be exactly what the server accepts, so a saved setting is never
 * a silent no-op.
 */
import { describe, expect, it } from "vitest";
import {
    describeQuietHours,
    isClockTime,
    NOTIFY_ENABLED_PREF,
    NOTIFY_QUIET_HOURS_PREF,
    notificationsEnabledPatch,
    quietHoursPatch,
    readNotificationsEnabled,
    readQuietHours,
    validateQuietHours,
} from "./prefs";
import type { Prefs } from "./api";

describe("readNotificationsEnabled", () => {
    it("reads an absent key as on, without flagging it", () => {
        expect(readNotificationsEnabled({})).toEqual({
            value: true,
            unreadable: false,
        });
    });

    it("reads a literal false as off and true as on", () => {
        expect(
            readNotificationsEnabled({ [NOTIFY_ENABLED_PREF]: false }).value,
        ).toBe(false);
        expect(
            readNotificationsEnabled({ [NOTIFY_ENABLED_PREF]: true }),
        ).toEqual({ value: true, unreadable: false });
    });

    it("reads an explicit null as the default (on), the way the server does", () => {
        expect(
            readNotificationsEnabled({ [NOTIFY_ENABLED_PREF]: null }),
        ).toEqual({ value: true, unreadable: false });
    });

    it("reads an unusable value as the on the server will actually apply, flagged", () => {
        expect(
            readNotificationsEnabled({ [NOTIFY_ENABLED_PREF]: "no" }),
        ).toEqual({ value: true, unreadable: true });
        expect(readNotificationsEnabled({ [NOTIFY_ENABLED_PREF]: 0 })).toEqual({
            value: true,
            unreadable: true,
        });
    });

    it("ignores unrelated pref keys", () => {
        expect(readNotificationsEnabled({ "some.integration": false })).toEqual(
            {
                value: true,
                unreadable: false,
            },
        );
    });
});

describe("readQuietHours", () => {
    it("reads an absent key as off, without flagging it", () => {
        expect(readQuietHours({})).toEqual({ value: null, unreadable: false });
    });

    it("reads the explicit null off value without flagging it", () => {
        expect(readQuietHours({ [NOTIFY_QUIET_HOURS_PREF]: null })).toEqual({
            value: null,
            unreadable: false,
        });
    });

    it("reads a well-formed window", () => {
        expect(
            readQuietHours({
                [NOTIFY_QUIET_HOURS_PREF]: { start: "22:00", end: "07:30" },
            }),
        ).toEqual({
            value: { start: "22:00", end: "07:30" },
            unreadable: false,
        });
    });

    it("flags a stored value that is not a window as not in effect", () => {
        for (const stored of [
            "22:00-07:00",
            42,
            { start: "22:00" },
            { start: "22:00", end: 7 },
            { start: "7:00", end: "09:00" },
            { start: "25:00", end: "07:00" },
        ]) {
            expect(
                readQuietHours({ [NOTIFY_QUIET_HOURS_PREF]: stored }),
            ).toEqual({ value: null, unreadable: true });
        }
    });

    it("flags a zero-length window, which the server refuses to treat as always-quiet", () => {
        expect(
            readQuietHours({
                [NOTIFY_QUIET_HOURS_PREF]: { start: "22:00", end: "22:00" },
            }),
        ).toEqual({ value: null, unreadable: true });
    });
});

describe("describeQuietHours", () => {
    it("states the window, the off state, and the ignored-value case", () => {
        expect(
            describeQuietHours({
                value: { start: "22:00", end: "07:00" },
                unreadable: false,
            }),
        ).toBe("22:00 → 07:00");
        expect(describeQuietHours({ value: null, unreadable: false })).toBe(
            "off",
        );
        expect(describeQuietHours({ value: null, unreadable: true })).toMatch(
            /not in effect/,
        );
    });
});

describe("validateQuietHours", () => {
    it("accepts a usable window, including one that wraps past midnight", () => {
        expect(validateQuietHours("22:00", "07:30")).toBeNull();
        expect(validateQuietHours("00:00", "23:59")).toBeNull();
    });

    it("rejects a malformed clock time", () => {
        expect(validateQuietHours("7:00", "09:00")).toMatch(/24-hour/);
        expect(validateQuietHours("22:00", "25:00")).toMatch(/24-hour/);
        expect(validateQuietHours("", "")).toMatch(/24-hour/);
    });

    it("rejects a zero-length window", () => {
        expect(validateQuietHours("22:00", "22:00")).toMatch(/differ/);
    });
});

describe("isClockTime", () => {
    it("accepts only HH:MM 24-hour strings", () => {
        expect(isClockTime("00:00")).toBe(true);
        expect(isClockTime("23:59")).toBe(true);
        expect(isClockTime("24:00")).toBe(false);
        expect(isClockTime("7:00")).toBe(false);
        expect(isClockTime("07:0")).toBe(false);
        expect(isClockTime("0700")).toBe(false);
        expect(isClockTime("")).toBe(false);
    });
});

describe("patches", () => {
    it("builds one-key patches under the server's pref keys", () => {
        expect(notificationsEnabledPatch(false)).toEqual({
            [NOTIFY_ENABLED_PREF]: false,
        });
        expect(quietHoursPatch({ start: "22:00", end: "07:00" })).toEqual({
            [NOTIFY_QUIET_HOURS_PREF]: { start: "22:00", end: "07:00" },
        });
        expect(quietHoursPatch(null)).toEqual({
            [NOTIFY_QUIET_HOURS_PREF]: null,
        });
    });

    it("round-trips through JSON: what we write is what we read back", () => {
        // The store keeps prefs as JSON text; encoding is exactly that trip.
        const written = JSON.parse(
            JSON.stringify(quietHoursPatch({ start: "22:00", end: "07:00" })),
        ) as Prefs;
        expect(readQuietHours(written)).toEqual({
            value: { start: "22:00", end: "07:00" },
            unreadable: false,
        });
        const off = JSON.parse(JSON.stringify(quietHoursPatch(null))) as Prefs;
        expect(readQuietHours(off)).toEqual({ value: null, unreadable: false });
        const toggle = JSON.parse(
            JSON.stringify(notificationsEnabledPatch(false)),
        ) as Prefs;
        expect(readNotificationsEnabled(toggle).value).toBe(false);
    });
});
