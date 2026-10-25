/**
 * The browser-local haptics preference (#189 follow-up).
 *
 * The shell reads it once and writes it on every toggle; the provider then
 * hands the result to every `HapticButton`. Kept out of the server prefs for
 * the same reason as the appearance switches: a phone's motor is not a fact
 * about the account.
 */
import { useCallback, useState } from "react";
import {
    hapticsSupported,
    loadHapticsEnabled,
    saveHapticsEnabled,
} from "../haptics";

/** The preference, its hardware availability, and the toggle. */
export interface HapticsPreference {
    /** Whether primary buttons should tick. */
    enabled: boolean;
    /** Whether this browser has a haptic path at all. */
    supported: boolean;
    /** Flips the preference and persists it. */
    toggle(): void;
}

/**
 * Reads the preference once and writes it on change.
 *
 * @returns The preference, support, and the toggle.
 */
export function useHapticsPreference(): HapticsPreference {
    const [enabled, setEnabled] = useState(() =>
        typeof localStorage === "undefined"
            ? true
            : loadHapticsEnabled(localStorage),
    );

    const toggle = useCallback(() => {
        setEnabled((previous) => {
            const next = !previous;
            if (typeof localStorage !== "undefined") {
                saveHapticsEnabled(localStorage, next);
            }
            return next;
        });
    }, []);

    return { enabled, supported: hapticsSupported(), toggle };
}
