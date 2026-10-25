/**
 * The appearance preferences this browser owns (#146 phases B2, D).
 *
 * They are per-browser, not per-account: a busy background on a phone and a
 * quiet one on a wall display are facts about the device, and syncing them
 * through the account would set one device's choice against another's. So they
 * live in `localStorage` beside the browser's other local settings, with the
 * same private-mode tolerance `browserNotify.ts` uses (a read or write that
 * throws leaves the default in place rather than breaking the panel).
 */

/** The appearances the settings panel can switch. */
export interface Appearance {
    /** The particle field behind the app. */
    particles: boolean;
    /** Frosted glass on panes; off leaves solid panes in the same layout. */
    glass: boolean;
    /** Text labels on the wide-screen left menu; off leaves its icons alone. */
    navLabels: boolean;
}

/** Every effect on — the design as built. */
export const DEFAULT_APPEARANCE: Appearance = {
    particles: true,
    glass: true,
    navLabels: true,
};

/** The `localStorage` leaf; one key for the browser, not per user. */
export const APPEARANCE_KEY = "jarvis.appearance";

/**
 * Reads one flag out of a parsed record, falling back **per field**.
 *
 * Per field rather than whole-object on purpose: a stored blob with a corrupt
 * or unknown half must not reset the other half — which is exactly what a
 * whole-object fallback would do the first time the shape gained a key.
 */
function flag(record: Record<string, unknown>, key: keyof Appearance): boolean {
    const value = record[key];
    return typeof value === "boolean" ? value : DEFAULT_APPEARANCE[key];
}

/**
 * Parses a stored blob.
 *
 * Anything unreadable — absent, not JSON, an array, a bare number — is the
 * default, so a hand-edited or half-written value cannot leave the app in a
 * state the panel cannot describe.
 *
 * @param raw - The raw `localStorage` value, or `null` when unset.
 * @returns The stored appearance, with each unreadable field defaulted.
 */
export function parseAppearance(raw: string | null): Appearance {
    if (raw === null) {
        return DEFAULT_APPEARANCE;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
        ) {
            return DEFAULT_APPEARANCE;
        }
        const record = parsed as Record<string, unknown>;
        return {
            particles: flag(record, "particles"),
            glass: flag(record, "glass"),
            navLabels: flag(record, "navLabels"),
        };
    } catch {
        return DEFAULT_APPEARANCE;
    }
}

/**
 * Loads this browser's appearance.
 *
 * @param storage - The browser's `localStorage` (injected for tests).
 * @returns The stored appearance, or the default when it cannot be read.
 */
export function loadAppearance(storage: Storage): Appearance {
    try {
        return parseAppearance(storage.getItem(APPEARANCE_KEY));
    } catch {
        // Private-mode Safari throws on read; that is "no preference", not a
        // reason to fail rendering the settings panel.
        return DEFAULT_APPEARANCE;
    }
}

/**
 * Persists this browser's appearance.
 *
 * A storage failure is deliberately silent: the toggle still applies for the
 * session, and a modal warning about `localStorage` would be noise next to a
 * setting whose worst case is "it comes back on next visit".
 *
 * @param storage - The browser's `localStorage` (injected for tests).
 * @param appearance - The value to store.
 */
export function saveAppearance(storage: Storage, appearance: Appearance): void {
    try {
        storage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
    } catch {
        // Quota or a denied store: the session keeps the choice either way.
    }
}
