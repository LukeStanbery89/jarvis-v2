/**
 * Location-sharing hook for the app shell (#31, #186).
 *
 * Owns the persisted opt-out preference and the single geolocation request that
 * runs on mount (and on every toggle-on or explicit retry). On success the
 * rounded coordinates go out through the injected `sendLocation` (latest-ref,
 * so it stays bound to the live chat client) and are kept on the result for the
 * dashboard weather widget; `denied`/`unsupported` are surfaced for the bar and
 * the widget and never retried in a loop. The browser's permission prompt is
 * the consent gate; a secure context is the hard floor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    isLocationSupported,
    readLocationPref,
    requestLocation,
    writeLocationPref,
    type GeoPosition,
    type LocationUiState,
} from "../location";

/** The public surface {@link useLocationSharing} returns. */
export interface UseLocationSharingResult {
    /** The persisted sharing preference (ON by default). */
    locationOn: boolean;
    /** Why the pin looks the way it does (tooltip text lives in location.ts). */
    locationState: LocationUiState;
    /**
     * The last granted fix, for the dashboard weather widget (#186).
     *
     * `null` while sharing is off, while a request is in flight for the first
     * time, and after a denied/unavailable outcome; the coordinates are already
     * rounded by `requestLocation`.
     */
    position: GeoPosition | null;
    /** Flips the preference and persists it. */
    toggleLocation(): void;
    /**
     * Asks for a position now (the dashboard widget's prompt and its retry).
     *
     * Turns sharing on when it was off — the same preference the Settings
     * toggle writes — and starts a fresh request even when sharing was already
     * on, which is the only way to recover from a failed lookup.
     */
    shareLocation(): void;
}

/**
 * Owns the location preference and the one-shot geolocation effect.
 *
 * @param options.sendLocation - Sends a `location` frame (latest-ref).
 * @returns The preference, UI state, the last fix, the toggle, and the request.
 */
export function useLocationSharing(options: {
    sendLocation(lat: number, lon: number): void;
}): UseLocationSharingResult {
    const [locationOn, setLocationOn] = useState(() =>
        readLocationPref(localStorage),
    );
    const [locationState, setLocationState] = useState<LocationUiState>("off");
    const [position, setPosition] = useState<GeoPosition | null>(null);
    /**
     * Bumped by {@link shareLocation} to request again while sharing is already
     * on. A preference toggle alone cannot retry a failed lookup: the effect
     * only re-runs when one of its dependencies changes.
     */
    const [attempt, setAttempt] = useState(0);
    /** Latest sender (the effect must call the live chat client). */
    const sendLocationRef = useRef(options.sendLocation);
    sendLocationRef.current = options.sendLocation;

    // Automatic by default: on mount (and on every toggle-on or explicit
    // retry) one geolocation request runs, and on success one `location` frame
    // goes out plus the fix is kept for the dashboard. "denied"/"unsupported"
    // are shown in the open, never retried in a loop.
    useEffect(() => {
        if (!locationOn) {
            setLocationState("off");
            setPosition(null);
            return;
        }
        if (!isLocationSupported(navigator)) {
            setLocationState("unsupported");
            setPosition(null);
            return;
        }
        let cancelled = false;
        setLocationState("locating");
        void requestLocation(navigator.geolocation).then((result) => {
            if (cancelled) {
                return;
            }
            if (result.kind === "granted") {
                setPosition(result.position);
                sendLocationRef.current(
                    result.position.lat,
                    result.position.lon,
                );
                setLocationState("active");
            } else {
                setPosition(null);
                setLocationState(
                    result.kind === "denied" ? "denied" : "failed",
                );
            }
        });
        return () => {
            cancelled = true;
        };
    }, [locationOn, attempt]);

    const toggleLocation = useCallback((): void => {
        const next = !locationOn;
        setLocationOn(next);
        writeLocationPref(localStorage, next);
        if (!next) {
            setPosition(null);
            setLocationState("off");
        }
    }, [locationOn]);

    const shareLocation = useCallback((): void => {
        if (!locationOn) {
            setLocationOn(true);
            writeLocationPref(localStorage, true);
        }
        setAttempt((current) => current + 1);
    }, [locationOn]);

    return {
        locationOn,
        locationState,
        position,
        toggleLocation,
        shareLocation,
    };
}
