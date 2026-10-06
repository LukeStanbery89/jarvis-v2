/**
 * Browser geolocation plumbing for the weather tool (#31).
 *
 * Everything here is deliberately framework-free and DOM-thin so the
 * node-env vitest suite can drive the full decision tree with fakes (the
 * known trap: `.tsx` tests never run under the web package's node
 * configuration, so no behavior may live only inside a component).
 *
 * The flow is automatic (#31): on mount, a supported document requests a
 * position and ships it as a `location` frame; the browser's own permission
 * prompt is the consent gate, and the sidebar pin is the visible opt-out
 * (persisted in localStorage). A secure context is the hard floor —
 * `navigator.geolocation` exists only on HTTPS or localhost, so over plain
 * HTTP the pin reports "unsupported" and the server-side tool falls back to
 * asking for a city.
 *
 * Coordinates are rounded to four decimals (~11 m) before anything leaves
 * the device: weather does not need GPS-grade precision, and the browser is
 * the only place this data should exist at full resolution.
 */

/** A minimal structural view of the browser's geolocation provider. */
export interface GeolocationLike {
    getCurrentPosition(
        success: (position: {
            coords: { latitude: number; longitude: number };
        }) => void,
        error?: (err: { code: number; message?: string }) => void,
        options?: {
            timeout?: number;
            maximumAge?: number;
            enableHighAccuracy?: boolean;
        },
    ): void;
}

/** The rounded coordinates the client sends in a `location` frame. */
export interface GeoPosition {
    lat: number;
    lon: number;
}

/** Every way a single geolocation request can end. */
export type LocationResult =
    | { kind: "granted"; position: GeoPosition }
    | { kind: "denied" }
    | { kind: "failed"; reason: string };

/** localStorage key for the location-sharing preference. */
const PREF_KEY = "jarvis.location.enabled";

/**
 * Reads the location-sharing preference.
 *
 * **Default ON**: the product requirement (#31) is that the device reports
 * its location automatically — the consent gate is the browser's own
 * permission prompt (which the user must answer explicitly, and which the
 * browser remembers), not this flag. The flag exists to OPT OUT: an
 * explicit `"0"` (the sidebar pin toggled off) suppresses sharing; absent
 * or `"1"` means enabled.
 */
export function readLocationPref(storage: Pick<Storage, "getItem">): boolean {
    return storage.getItem(PREF_KEY) !== "0";
}

/**
 * Persists the location-sharing preference.
 *
 * Writes `"1"`/`"0"` verbatim (rather than clearing on enable) so the
 * meaning of an absent key stays "never decided" — future policy changes
 * can distinguish the two.
 */
export function writeLocationPref(
    storage: Pick<Storage, "setItem">,
    enabled: boolean,
): void {
    storage.setItem(PREF_KEY, enabled ? "1" : "0");
}

/**
 * Whether this document can request a location at all.
 *
 * `navigator.geolocation` exists only in secure contexts (HTTPS or
 * localhost) — over plain HTTP the property is undefined, which is the
 * documented fallback path, not a bug.
 */
export function isLocationSupported(nav: {
    geolocation?: GeolocationLike;
}): boolean {
    return nav.geolocation !== undefined;
}

/** Rounds one coordinate to four decimals (~11 m). */
export function roundCoordinate(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

/**
 * Requests one position fix.
 *
 * Wraps the callback API in a promise that always settles: `denied` for the
 * browser's PERMISSION_DENIED, `failed` (with the browser's message) for
 * unavailable/timeout, `granted` with rounded coordinates otherwise. Options
 * ask for a coarse fix on purpose — a weather question needs a city, not a
 * GPS lock, so low accuracy plus a 10-minute cached position keeps the
 * request fast and cheap.
 */
export function requestLocation(
    geo: GeolocationLike,
    timeoutMs = 10_000,
): Promise<LocationResult> {
    return new Promise((resolve) => {
        geo.getCurrentPosition(
            (position) => {
                resolve({
                    kind: "granted",
                    position: {
                        lat: roundCoordinate(position.coords.latitude),
                        lon: roundCoordinate(position.coords.longitude),
                    },
                });
            },
            (err) => {
                // 1 = PERMISSION_DENIED; 2 = POSITION_UNAVAILABLE; 3 = TIMEOUT.
                if (err.code === 1) {
                    resolve({ kind: "denied" });
                    return;
                }
                resolve({
                    kind: "failed",
                    reason: err.message || "location unavailable",
                });
            },
            {
                timeout: timeoutMs,
                maximumAge: 600_000,
                enableHighAccuracy: false,
            },
        );
    });
}

/** The location-sharing states the chat UI's pin button can display. */
export type LocationUiState =
    "off" | "unsupported" | "locating" | "active" | "denied" | "failed";

/** Short, user-facing explanation for each state (button tooltip). */
export function describeLocationState(state: LocationUiState): string {
    switch (state) {
        case "off":
            return "Share my location for weather (off)";
        case "unsupported":
            return "Location unavailable — HTTPS or localhost required";
        case "locating":
            return "Locating…";
        case "active":
            return "Sharing location for weather";
        case "denied":
            return "Location denied in the browser — allow it to use weather";
        case "failed":
            return "Location lookup failed — try again";
    }
}
