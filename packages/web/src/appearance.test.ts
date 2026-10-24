/**
 * The appearance preferences' storage contract (#146 phase B2).
 *
 * The interesting cases are all "what does a broken store mean": the panel must
 * be able to describe what is on screen even after a hand-edited value, a
 * half-written blob, or a browser that refuses `localStorage` altogether.
 */
import { describe, expect, it } from "vitest";
import {
    APPEARANCE_KEY,
    DEFAULT_APPEARANCE,
    loadAppearance,
    parseAppearance,
    saveAppearance,
} from "./appearance";

/** A `Storage` double backed by a map. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
    const values = new Map(Object.entries(initial));
    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => {
            values.delete(key);
        },
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
    };
}

describe("parseAppearance", () => {
    it("is the default when nothing is stored", () => {
        expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    });

    it("reads a stored shape", () => {
        expect(
            parseAppearance(
                '{"particles":false,"glass":true,"navLabels":false}',
            ),
        ).toEqual({
            particles: false,
            glass: true,
            navLabels: false,
        });
    });

    it("defaults a missing field without resetting the one it has", () => {
        expect(parseAppearance('{"particles":false}')).toEqual({
            particles: false,
            glass: DEFAULT_APPEARANCE.glass,
            navLabels: DEFAULT_APPEARANCE.navLabels,
        });
        expect(parseAppearance('{"glass":false}')).toEqual({
            particles: DEFAULT_APPEARANCE.particles,
            glass: false,
            navLabels: DEFAULT_APPEARANCE.navLabels,
        });
        expect(parseAppearance('{"navLabels":false}')).toEqual({
            particles: DEFAULT_APPEARANCE.particles,
            glass: DEFAULT_APPEARANCE.glass,
            navLabels: false,
        });
    });

    it("ignores a field of the wrong type", () => {
        expect(
            parseAppearance('{"particles":"no","glass":1,"navLabels":0}'),
        ).toEqual(DEFAULT_APPEARANCE);
    });

    it("is the default for anything that is not an object", () => {
        for (const raw of ["", "null", "true", "42", "[]", "not json {"]) {
            expect(parseAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
        }
    });
});

describe("loadAppearance / saveAppearance", () => {
    it("round-trips through storage", () => {
        const storage = memoryStorage();
        saveAppearance(storage, {
            particles: false,
            glass: false,
            navLabels: false,
        });

        expect(storage.getItem(APPEARANCE_KEY)).toBe(
            '{"particles":false,"glass":false,"navLabels":false}',
        );
        expect(loadAppearance(storage)).toEqual({
            particles: false,
            glass: false,
            navLabels: false,
        });
    });

    it("survives a store that throws on read", () => {
        const storage = memoryStorage();
        storage.getItem = () => {
            throw new Error("denied");
        };

        expect(loadAppearance(storage)).toEqual(DEFAULT_APPEARANCE);
    });

    it("survives a store that throws on write", () => {
        const storage = memoryStorage();
        storage.setItem = () => {
            throw new Error("quota");
        };

        expect(() =>
            saveAppearance(storage, {
                particles: false,
                glass: true,
                navLabels: true,
            }),
        ).not.toThrow();
    });
});
