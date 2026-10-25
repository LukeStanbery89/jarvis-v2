/**
 * Unit tests for the dashboard weather presentation helpers (#186).
 *
 * These are the decisions that must not live only in a `.tsx` component: which
 * graphic a condition gets, whether it is day or night, and how wind is spelled.
 */
import { describe, expect, it } from "vitest";
import {
    capitalizeCondition,
    compassDirection,
    formatTemperature,
    formatWindSpeed,
    isDaytime,
    placeLabel,
    temperatureUnit,
    weatherGlyph,
    windUnit,
} from "./weather";
import type { WeatherNow } from "./api";

/** A complete response, overridable per test. */
function weather(overrides: Partial<WeatherNow> = {}): WeatherNow {
    return {
        location: { name: "Portland", country: "US" },
        temp: 63,
        feelsLike: 61,
        description: "light rain",
        condition: "Rain",
        conditionId: 500,
        windSpeed: 8,
        windDeg: 200,
        observedAt: 1_760_000_000,
        timezoneOffsetSeconds: -25_200,
        sunrise: 1_759_996_800,
        sunset: 1_760_032_800,
        units: "imperial",
        ...overrides,
    };
}

describe("isDaytime", () => {
    it("uses sunrise and sunset when the provider supplied them", () => {
        const base = weather();
        expect(isDaytime(base)).toBe(true);
        expect(isDaytime({ ...base, observedAt: base.sunrise! - 1 })).toBe(
            false,
        );
        expect(isDaytime({ ...base, observedAt: base.sunset! })).toBe(false);
    });

    it("falls back to the observation's local clock without sun times", () => {
        const base = weather({ sunrise: undefined, sunset: undefined });
        // 1_760_000_000 is 2025-10-09 08:53 UTC; UTC-7 makes it 01:53 — night.
        expect(isDaytime(base)).toBe(false);
        // The same instant at UTC+12 is 20:53 — still night.
        expect(isDaytime({ ...base, timezoneOffsetSeconds: 43_200 })).toBe(
            false,
        );
        // 12:00 UTC-7 is daytime.
        expect(
            isDaytime({
                ...base,
                observedAt: 1_760_036_420,
                timezoneOffsetSeconds: -25_200,
            }),
        ).toBe(true);
    });
});

describe("weatherGlyph", () => {
    it("maps the provider's grouped codes", () => {
        const base = weather();
        expect(weatherGlyph({ ...base, conditionId: 800 }, true)).toBe(
            "clear-day",
        );
        expect(weatherGlyph({ ...base, conditionId: 800 }, false)).toBe(
            "clear-night",
        );
        expect(weatherGlyph({ ...base, conditionId: 801 }, true)).toBe(
            "partly-day",
        );
        expect(weatherGlyph({ ...base, conditionId: 802 }, false)).toBe(
            "partly-night",
        );
        expect(weatherGlyph({ ...base, conditionId: 804 }, true)).toBe(
            "cloudy",
        );
        expect(weatherGlyph({ ...base, conditionId: 500 }, true)).toBe("rain");
        expect(weatherGlyph({ ...base, conditionId: 300 }, true)).toBe(
            "drizzle",
        );
        expect(weatherGlyph({ ...base, conditionId: 600 }, true)).toBe("snow");
        expect(weatherGlyph({ ...base, conditionId: 200 }, true)).toBe(
            "thunder",
        );
        expect(weatherGlyph({ ...base, conditionId: 741 }, true)).toBe("fog");
        expect(weatherGlyph({ ...base, conditionId: 781 }, true)).toBe("wind");
    });

    it("falls back to the condition text when there is no code", () => {
        const base = weather({ conditionId: undefined });
        expect(
            weatherGlyph(
                { ...base, condition: "Clear", description: "clear sky" },
                false,
            ),
        ).toBe("clear-night");
        expect(
            weatherGlyph(
                {
                    ...base,
                    condition: "Clouds",
                    description: "few clouds",
                },
                true,
            ),
        ).toBe("partly-day");
        expect(
            weatherGlyph(
                {
                    ...base,
                    condition: "Clouds",
                    description: "overcast clouds",
                },
                true,
            ),
        ).toBe("cloudy");
        expect(
            weatherGlyph(
                { ...base, condition: "Rain", description: "heavy shower" },
                true,
            ),
        ).toBe("rain");
        expect(
            weatherGlyph(
                { ...base, condition: "Snow", description: "light snow" },
                true,
            ),
        ).toBe("snow");
        expect(
            weatherGlyph(
                { ...base, condition: "Mist", description: "mist" },
                true,
            ),
        ).toBe("fog");
        expect(
            weatherGlyph(
                { ...base, condition: "Thunderstorm", description: "storm" },
                true,
            ),
        ).toBe("thunder");
        expect(
            weatherGlyph(
                { ...base, condition: "Unknown", description: "strange" },
                true,
            ),
        ).toBe("cloudy");
    });
});

describe("wind and display formatting", () => {
    it("spells the eight-point compass and wraps around", () => {
        expect(compassDirection(0)).toBe("N");
        expect(compassDirection(90)).toBe("E");
        expect(compassDirection(225)).toBe("SW");
        expect(compassDirection(350)).toBe("N");
        expect(compassDirection(-45)).toBe("NW");
        expect(compassDirection(Number.NaN)).toBeNull();
        expect(compassDirection(undefined)).toBeNull();
    });

    it("uses the response's unit system", () => {
        expect(temperatureUnit("imperial")).toBe("°F");
        expect(temperatureUnit("metric")).toBe("°C");
        expect(windUnit("imperial")).toBe("mph");
        expect(windUnit("metric")).toBe("m/s");
    });

    it("rounds temperatures and keeps one wind decimal", () => {
        expect(formatTemperature(63.4)).toBe("63");
        expect(formatTemperature(63.6)).toBe("64");
        expect(formatTemperature(Number.NaN)).toBe("—");
        expect(formatWindSpeed(8)).toBe("8");
        expect(formatWindSpeed(0.62)).toBe("0.6");
        expect(formatWindSpeed(Number.NaN)).toBe("—");
    });

    it("capitalizes the condition and joins the place", () => {
        expect(capitalizeCondition("light rain")).toBe("Light rain");
        expect(capitalizeCondition("  ")).toBe("");
        expect(placeLabel({ name: "Portland", country: "US" })).toBe(
            "Portland, US",
        );
        expect(placeLabel({ name: "Zocca" })).toBe("Zocca");
    });
});
