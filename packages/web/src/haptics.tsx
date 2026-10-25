/**
 * Haptic feedback for the app's primary controls (#189 follow-up).
 *
 * The web has no single haptics API:
 *
 * - Chromium on Android exposes `navigator.vibrate()`, but only after a real
 *   gesture and with no intensity control.
 * - iOS never shipped the Vibration API. Since iOS 26.5 the only remaining
 *   route is a native `<input type="checkbox" switch>` tapped directly by the
 *   user: toggling it plays one fixed Taptic tick. A script-triggered click no
 *   longer works (Apple patched that in 26.5), which is why `HapticButton`
 *   overlays the switch itself rather than calling a function.
 *
 * The preference is per browser, like the appearance switches: a phone can
 * want ticks while a desktop cannot produce them at all. Haptics are never the
 * only feedback for an action — the visual response remains the contract.
 */
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

/** The browser-local preference key. */
export const HAPTICS_KEY = "jarvis.haptics";

/** Whether this browser should play the primary-button tick. */
export interface HapticsState {
    /** The user's preference. */
    enabled: boolean;
    /** Whether this browser has any haptic path at all. */
    supported: boolean;
}

/** The context a shell provides to its buttons. */
const HapticsContext = createContext<HapticsState>({
    enabled: false,
    supported: false,
});

/** Props for {@link HapticsProvider}. */
export interface HapticsProviderProps extends HapticsState {
    /** The app surface. */
    children: ReactNode;
}

/**
 * Supplies the haptics preference to every `HapticButton` below it.
 *
 * @param props - See {@link HapticsProviderProps}.
 */
export function HapticsProvider({
    enabled,
    supported,
    children,
}: HapticsProviderProps) {
    const value = useMemo(() => ({ enabled, supported }), [enabled, supported]);
    return (
        <HapticsContext.Provider value={value}>
            {children}
        </HapticsContext.Provider>
    );
}

/** Reads the current preference and support from the nearest shell. */
export function useHaptics(): HapticsState {
    return useContext(HapticsContext);
}

/**
 * Whether this is an iPhone/iPad browser (including Chrome and Firefox on iOS,
 * which all run WebKit). iPadOS reports itself as a Mac with touch points.
 *
 * @param userAgent - The navigator user agent.
 * @param platform - The navigator platform.
 * @param maxTouchPoints - The navigator touch-point count.
 * @returns True for an Apple mobile browser.
 */
export function isAppleMobile(
    userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
    platform = typeof navigator === "undefined" ? "" : navigator.platform,
    maxTouchPoints = typeof navigator === "undefined"
        ? 0
        : navigator.maxTouchPoints,
): boolean {
    return (
        /iPad|iPhone|iPod/.test(userAgent) ||
        (platform === "MacIntel" && maxTouchPoints > 1)
    );
}

/**
 * Whether this browser can produce haptics in at least one of the two ways.
 *
 * iOS is always considered supported because the native-switch overlay works
 * without the Vibration API. Android/Chromium requires a coarse pointer and the
 * Vibration API; desktop Chromium exposes `vibrate` but has no motor, so it is
 * not offered.
 *
 * @returns True when the settings row should be enabled.
 */
export function hapticsSupported(): boolean {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
        return false;
    }
    if (isAppleMobile()) {
        return true;
    }
    return (
        typeof navigator.vibrate === "function" &&
        window.matchMedia("(pointer: coarse)").matches
    );
}

/**
 * Fires the Android/Chromium vibration for one primary tap.
 *
 * No-op on iOS: that path is the native switch in `HapticButton`, and a
 * programmatic click cannot trigger it after iOS 26.5.
 */
export function triggerHaptic(): void {
    if (
        typeof navigator === "undefined" ||
        typeof navigator.vibrate !== "function" ||
        isAppleMobile()
    ) {
        return;
    }
    try {
        navigator.vibrate(10);
    } catch {
        // A browser that exposes the method but rejects the call is silent;
        // haptics must never break the action they accompany.
    }
}

/**
 * Reads the browser-local haptics preference.
 *
 * @param storage - The browser's `localStorage` (injected for tests).
 * @returns True unless the user explicitly turned the tick off.
 */
export function loadHapticsEnabled(storage: Storage): boolean {
    try {
        return storage.getItem(HAPTICS_KEY) !== "off";
    } catch {
        // Private-mode Safari throws on read; the default is on.
        return true;
    }
}

/**
 * Persists the browser-local haptics preference.
 *
 * @param storage - The browser's `localStorage` (injected for tests).
 * @param enabled - Whether primary buttons should tick.
 */
export function saveHapticsEnabled(storage: Storage, enabled: boolean): void {
    try {
        storage.setItem(HAPTICS_KEY, enabled ? "on" : "off");
    } catch {
        // A denied store leaves the session choice intact; the worst case is
        // that it returns to the default on the next visit.
    }
}
