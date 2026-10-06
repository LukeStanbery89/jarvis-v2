/**
 * Tests for the browser geolocation plumbing (#31): the consent toggle's
 * persistence, secure-context feature detection, coordinate rounding, the
 * always-settling request promise, and the UI-state descriptions. All logic
 * lives in `location.ts` (plain .ts) precisely so this node-env suite can
 * exercise it — `.tsx` tests never run under the web package's config.
 */
import { describe, expect, it } from "vitest";
import {
    describeLocationState,
    isLocationSupported,
    readLocationPref,
    requestLocation,
    roundCoordinate,
    writeLocationPref,
    type GeolocationLike,
} from "./location";

/** A localStorage double: an in-memory string map. */
function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
        removeItem: (k) => void map.delete(k),
        clear: () => void map.clear(),
        key: () => null,
        get length() {
            return map.size;
        },
    } as Storage;
}

/** A geolocation double that resolves or rejects on demand. */
function fakeGeo(
    outcome:
        | { kind: "ok"; lat: number; lon: number }
        | { kind: "error"; code: number; message?: string },
): GeolocationLike {
    return {
        getCurrentPosition(success, error) {
            if (outcome.kind === "ok") {
                success({
                    coords: {
                        latitude: outcome.lat,
                        longitude: outcome.lon,
                    },
                });
            } else {
                error?.({ code: outcome.code, message: outcome.message });
            }
        },
    } as GeolocationLike;
}

describe("location preference", () => {
    it("defaults on (never-decided means enabled) and round-trips", () => {
        const storage = fakeStorage();
        expect(readLocationPref(storage)).toBe(true);
        writeLocationPref(storage, true);
        expect(readLocationPref(storage)).toBe(true);
        writeLocationPref(storage, false);
        expect(readLocationPref(storage)).toBe(false);
        // An explicit "0" persists the opt-out across reloads.
        expect(readLocationPref(storage)).toBe(false);
    });
});

describe("isLocationSupported", () => {
    it("is false without a geolocation provider (plain HTTP)", () => {
        expect(isLocationSupported({})).toBe(false);
    });

    it("is true when the provider exists (HTTPS/localhost)", () => {
        expect(
            isLocationSupported({
                geolocation: fakeGeo({ kind: "ok", lat: 0, lon: 0 }),
            }),
        ).toBe(true);
    });
});

describe("roundCoordinate", () => {
    it("keeps four decimals (~11 m) and no more", () => {
        expect(roundCoordinate(45.523198765)).toBe(45.5232);
        expect(roundCoordinate(-122.67651234)).toBe(-122.6765);
        expect(roundCoordinate(0)).toBe(0);
    });
});

describe("requestLocation", () => {
    it("resolves granted with rounded coordinates", async () => {
        const geo = fakeGeo({
            kind: "ok",
            lat: 45.52319876,
            lon: -122.67651234,
        });
        const result = await requestLocation(geo);
        expect(result).toEqual({
            kind: "granted",
            position: { lat: 45.5232, lon: -122.6765 },
        });
    });

    it("maps PERMISSION_DENIED (code 1) to denied", async () => {
        const geo = fakeGeo({ kind: "error", code: 1 });
        await expect(requestLocation(geo)).resolves.toEqual({ kind: "denied" });
    });

    it("maps other errors (unavailable, timeout) to failed with the reason", async () => {
        const geo = fakeGeo({
            kind: "error",
            code: 3,
            message: "Position taking too long",
        });
        await expect(requestLocation(geo)).resolves.toEqual({
            kind: "failed",
            reason: "Position taking too long",
        });
        const fallback = fakeGeo({ kind: "error", code: 2 });
        await expect(requestLocation(fallback)).resolves.toEqual({
            kind: "failed",
            reason: "location unavailable",
        });
    });
});

describe("describeLocationState", () => {
    it("gives every state a non-empty explanation", () => {
        for (const state of [
            "off",
            "unsupported",
            "locating",
            "active",
            "denied",
            "failed",
        ] as const) {
            expect(describeLocationState(state).length).toBeGreaterThan(0);
        }
    });
});
