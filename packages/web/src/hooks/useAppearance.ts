/**
 * This browser's appearance preferences (#146 phase B2).
 *
 * `localStorage` is the store, so the read is lazy (once, at mount) and the
 * write happens on change. The shell is the only writer: the settings panel
 * calls these setters, and the shell applies the result (mounting or unmounting
 * the field, and setting `data-glass` on `.app` for the CSS to read).
 */
import { useCallback, useState } from "react";
import {
    DEFAULT_APPEARANCE,
    loadAppearance,
    saveAppearance,
} from "../appearance";
import type { Appearance } from "../appearance";

/** The appearance state and the setters the panel needs. */
export interface AppearanceState {
    /** The current preferences. */
    appearance: Appearance;
    /** Shows or hides the particle field. */
    setParticles(on: boolean): void;
    /** Turns the frosted-glass treatment on or off. */
    setGlass(on: boolean): void;
    /** Shows or hides the wide-screen rail's labels. */
    setNavLabels(on: boolean): void;
}

/**
 * Reads this browser's appearance once, and writes it back on every change.
 *
 * Not a server preference and not a `usePrefs` key: switching the background
 * off on a phone must not switch it off on the desktop, and a visual preference
 * has no meaning to any other client.
 *
 * @returns The appearance and its setters.
 */
export function useAppearance(): AppearanceState {
    const [appearance, setAppearance] = useState<Appearance>(() =>
        typeof localStorage === "undefined"
            ? DEFAULT_APPEARANCE
            : loadAppearance(localStorage),
    );

    const update = useCallback((patch: Partial<Appearance>) => {
        setAppearance((previous) => {
            const next = { ...previous, ...patch };
            if (typeof localStorage !== "undefined") {
                saveAppearance(localStorage, next);
            }
            return next;
        });
    }, []);

    return {
        appearance,
        setParticles: (on: boolean) => update({ particles: on }),
        setGlass: (on: boolean) => update({ glass: on }),
        setNavLabels: (on: boolean) => update({ navLabels: on }),
    };
}
