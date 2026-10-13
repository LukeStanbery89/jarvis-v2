/**
 * Location-sharing hook for the chat view (#31).
 *
 * Owns the persisted opt-out preference and the single geolocation request that
 * runs on mount (and on every toggle-on). On success the rounded coordinates go
 * out through the injected `sendLocation` (latest-ref, so it stays bound to the
 * live chat client); `denied`/`unsupported` are surfaced for the sidebar note
 * and never retried in a loop. The browser's permission prompt is the consent
 * gate; a secure context is the hard floor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    isLocationSupported,
    readLocationPref,
    requestLocation,
    writeLocationPref,
    type LocationUiState,
} from "../location";

/** The public surface {@link useLocationSharing} returns. */
export interface UseLocationSharingResult {
    /** The persisted sharing preference (ON by default). */
    locationOn: boolean;
    /** Why the pin looks the way it does (tooltip text lives in location.ts). */
    locationState: LocationUiState;
    /** Flips the preference and persists it. */
    toggleLocation(): void;
}

/**
 * Owns the location preference and the one-shot geolocation effect.
 *
 * @param options.sendLocation - Sends a `location` frame (latest-ref).
 * @returns The preference, UI state, and the toggle.
 */
export function useLocationSharing(options: {
    sendLocation(lat: number, lon: number): void;
}): UseLocationSharingResult {
    const [locationOn, setLocationOn] = useState(() =>
        readLocationPref(localStorage),
    );
    const [locationState, setLocationState] = useState<LocationUiState>("off");
    /** Latest sender (the effect must call the live chat client). */
    const sendLocationRef = useRef(options.sendLocation);
    sendLocationRef.current = options.sendLocation;

    // Automatic by default: on mount (and on every toggle-on) one geolocation
    // request runs, and on success one `location` frame goes out. "denied"/
    // "unsupported" are shown in the open, never retried in a loop.
    useEffect(() => {
        if (!locationOn) {
            setLocationState("off");
            return;
        }
        if (!isLocationSupported(navigator)) {
            setLocationState("unsupported");
            return;
        }
        let cancelled = false;
        setLocationState("locating");
        void requestLocation(navigator.geolocation).then((result) => {
            if (cancelled) {
                return;
            }
            if (result.kind === "granted") {
                sendLocationRef.current(
                    result.position.lat,
                    result.position.lon,
                );
                setLocationState("active");
            } else if (result.kind === "denied") {
                setLocationState("denied");
            } else {
                setLocationState("failed");
            }
        });
        return () => {
            cancelled = true;
        };
    }, [locationOn]);

    const toggleLocation = useCallback((): void => {
        const next = !locationOn;
        setLocationOn(next);
        writeLocationPref(localStorage, next);
    }, [locationOn]);

    return { locationOn, locationState, toggleLocation };
}
