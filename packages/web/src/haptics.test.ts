/**
 * The browser-local haptics preference and platform detection (#189 follow-up).
 *
 * The DOM paths (`useHapticsPreference`, the native switch overlay) need a real
 * device; these tests pin the pure pieces that decide what the toggle says and
 * where the preference lives.
 */
import { describe, expect, it } from "vitest";
import {
    HAPTICS_KEY,
    isAppleMobile,
    loadHapticsEnabled,
    saveHapticsEnabled,
} from "./haptics";

/** An in-memory `Storage` double. */
function storage(initial: string | null = null): Storage {
    const values = new Map<string, string>();
    if (initial !== null) {
        values.set(HAPTICS_KEY, initial);
    }
    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => {
            values.delete(key);
        },
        setItem: (key, value) => {
            values.set(key, value);
        },
    };
}

describe("haptics preference", () => {
    it("defaults on when nothing has been stored", () => {
        expect(loadHapticsEnabled(storage())).toBe(true);
    });

    it("reads an explicit on/off value", () => {
        expect(loadHapticsEnabled(storage("on"))).toBe(true);
        expect(loadHapticsEnabled(storage("off"))).toBe(false);
    });

    it("persists the toggle", () => {
        const store = storage();
        saveHapticsEnabled(store, false);
        expect(store.getItem(HAPTICS_KEY)).toBe("off");
        saveHapticsEnabled(store, true);
        expect(store.getItem(HAPTICS_KEY)).toBe("on");
    });

    it("survives a storage that throws", () => {
        const broken = {
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => {
                throw new Error("denied");
            },
            clear: () => undefined,
            key: () => null,
            removeItem: () => undefined,
            length: 0,
        } satisfies Storage;
        expect(loadHapticsEnabled(broken)).toBe(true);
        expect(() => saveHapticsEnabled(broken, false)).not.toThrow();
    });
});

describe("isAppleMobile", () => {
    it("recognises iPhone and iPad user agents", () => {
        expect(
            isAppleMobile(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) Mobile/15E148",
                "iPhone",
                5,
            ),
        ).toBe(true);
        expect(
            isAppleMobile(
                "Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X)",
                "iPad",
                5,
            ),
        ).toBe(true);
    });

    it("recognises iPadOS reporting as a touch Mac", () => {
        expect(isAppleMobile("Mozilla/5.0 (Macintosh)", "MacIntel", 5)).toBe(
            true,
        );
    });

    it("leaves desktops and Android alone", () => {
        expect(
            isAppleMobile(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "MacIntel",
                0,
            ),
        ).toBe(false);
        expect(
            isAppleMobile(
                "Mozilla/5.0 (Linux; Android 16; Pixel 9)",
                "Linux armv8l",
                5,
            ),
        ).toBe(false);
    });
});
