/**
 * Known-pref write validation tests (#143).
 *
 * The point of the registry is that a setting which cannot work fails at the
 * moment it is written, not silently at the moment it should have fired. So
 * these pin three things: a well-formed value passes, a malformed one is a 400
 * whose message names the key and the shape, and an unknown key is left alone
 * (the prefs map belongs to integrations too).
 *
 * One case is subtler and matters most: a value the *delivery path* would
 * ignore (say a window missing its `end`) must be rejected on write. A
 * lenient read is a safety net for a hand-edited database, not a licence to
 * store something unreadable through the API.
 */
import { describe, expect, it } from "vitest";
import { AuthError } from "@lukestanbery/jarvis-auth";
import { assertKnownPrefs } from "../src/prefs/known";
import {
    NOTIFY_ENABLED_PREF,
    NOTIFY_QUIET_HOURS_PREF,
    parseQuietHours,
    validateEnabledPref,
    validateQuietHoursPref,
} from "../src/notify/prefs";

describe("assertKnownPrefs", () => {
    it("accepts well-formed values for both known keys", () => {
        expect(() =>
            assertKnownPrefs([
                { key: NOTIFY_ENABLED_PREF, value: false },
                {
                    key: NOTIFY_QUIET_HOURS_PREF,
                    value: { start: "22:00", end: "07:30" },
                },
            ]),
        ).not.toThrow();
    });

    it("accepts the off/clear values (null and booleans)", () => {
        expect(() =>
            assertKnownPrefs([
                { key: NOTIFY_ENABLED_PREF, value: null },
                { key: NOTIFY_ENABLED_PREF, value: true },
                { key: NOTIFY_QUIET_HOURS_PREF, value: null },
            ]),
        ).not.toThrow();
    });

    it("rejects a malformed known value with a 400 naming the key's shape", () => {
        const cases: { key: string; value: unknown }[] = [
            { key: NOTIFY_ENABLED_PREF, value: "off" },
            { key: NOTIFY_ENABLED_PREF, value: 0 },
            { key: NOTIFY_QUIET_HOURS_PREF, value: "22:00-07:00" },
            { key: NOTIFY_QUIET_HOURS_PREF, value: { start: "22:00" } },
            {
                key: NOTIFY_QUIET_HOURS_PREF,
                value: { start: "7:00", end: "9:00" },
            },
            { key: NOTIFY_QUIET_HOURS_PREF, value: { start: "22:00", end: 7 } },
            {
                key: NOTIFY_QUIET_HOURS_PREF,
                value: { start: "22:00", end: "22:00" },
            },
        ];
        for (const entry of cases) {
            let thrown: unknown;
            try {
                assertKnownPrefs([entry]);
            } catch (err) {
                thrown = err;
            }
            expect(thrown, JSON.stringify(entry)).toBeInstanceOf(AuthError);
            const error = thrown as AuthError;
            expect(error.code).toBe("BAD_REQUEST");
            expect(error.message).toContain(entry.key);
        }
    });

    it("rejects a shape the delivery path would silently ignore", () => {
        // The lenient read is a safety net for a hand-edited store; it is not
        // a reason to accept an unreadable value through the API.
        const value = { start: "22:00" };
        expect(parseQuietHours(value)).toBeNull();
        expect(validateQuietHoursPref(value)).not.toBeNull();
        expect(() =>
            assertKnownPrefs([{ key: NOTIFY_QUIET_HOURS_PREF, value }]),
        ).toThrow(AuthError);
    });

    it("leaves unknown keys alone, whatever their value", () => {
        expect(() =>
            assertKnownPrefs([
                {
                    key: "integration.whatever",
                    value: { any: ["json", 1, null] },
                },
                { key: "notify", value: "a prefix is not a key" },
            ]),
        ).not.toThrow();
    });
});

describe("the notify pref definition", () => {
    it("accepts every window the delivery path honours", () => {
        for (const value of [
            { start: "22:00", end: "07:00" },
            { start: "12:00", end: "13:00" },
            { start: "00:00", end: "23:59" },
            // Extra keys are ignored by the reader, so the writer must not
            // reject a value that works.
            { start: "22:00", end: "07:00", timezone: "UTC" },
        ]) {
            expect(validateQuietHoursPref(value)).toBeNull();
            expect(parseQuietHours(value)).not.toBeNull();
        }
    });

    it("tolerates a zero-length window on read (as off) but refuses it on write", () => {
        const zero = { start: "09:00", end: "09:00" };
        expect(parseQuietHours(zero)).toBeNull();
        expect(validateQuietHoursPref(zero)).toMatch(/differ/);
    });

    it("reads an unusable stored value as no quiet hours, never as always-quiet", () => {
        for (const value of [
            null,
            undefined,
            5,
            "22:00",
            [],
            { start: "22:00" },
        ]) {
            expect(parseQuietHours(value)).toBeNull();
        }
    });

    it("accepts only booleans and null for the master switch", () => {
        expect(validateEnabledPref(true)).toBeNull();
        expect(validateEnabledPref(false)).toBeNull();
        expect(validateEnabledPref(null)).toBeNull();
        expect(validateEnabledPref("true")).toMatch(/true, false, or null/);
        expect(validateEnabledPref(1)).not.toBeNull();
    });
});
