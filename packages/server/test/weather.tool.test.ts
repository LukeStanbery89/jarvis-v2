/**
 * Tests for the `getWeather` tool (#31): the location fallback chain, the
 * per-user quota gate, scope routing, the model-facing formatters, and
 * failure text. The provider is scripted, never live.
 */
import { describe, expect, it, vi } from "vitest";
import {
    createGetWeatherTool,
    discardedLocationReason,
    formatCurrentConditions,
    formatForecast,
    localClock,
    resolveLocation,
} from "../src/llm/tools/getWeather";
import { logger } from "../src/logger";
import { WeatherError } from "../src/llm/tools/weather/types";
import type {
    CurrentConditions,
    Forecast,
    WeatherLocation,
    WeatherProvider,
    WeatherUnits,
} from "../src/llm/tools/weather/types";
import { FixedWindowQuota } from "../src/rate/fixedWindowQuota";

/** A scripted provider recording its calls; throws when scripted to fail. */
function fakeProvider(script: {
    current?: CurrentConditions | Error;
    forecast?: Forecast | Error;
}): {
    provider: WeatherProvider;
    currentCalls: WeatherLocation[];
    forecastCalls: WeatherLocation[];
} {
    const currentCalls: WeatherLocation[] = [];
    const forecastCalls: WeatherLocation[] = [];
    return {
        currentCalls,
        forecastCalls,
        provider: {
            name: "openweather",
            async current(location) {
                currentCalls.push(location);
                const outcome = script.current;
                if (outcome instanceof Error) {
                    throw outcome;
                }
                return outcome ?? CONDITIONS;
            },
            async forecast(location) {
                forecastCalls.push(location);
                const outcome = script.forecast;
                if (outcome instanceof Error) {
                    throw outcome;
                }
                return outcome ?? FORECAST;
            },
        },
    };
}

/** Representative imperial current conditions. */
const CONDITIONS: CurrentConditions = {
    provider: "openweather",
    name: "Portland",
    country: "US",
    temp: 63,
    feelsLike: 61,
    description: "light rain",
    condition: "Rain",
    humidity: 78,
    windSpeed: 8,
    windDeg: 200,
    cloudCover: 90,
    precipitationMm: 1.2,
    observedAt: 1_791_270_000 + 50_640, // Tue 2026-10-06 14:04 local (UTC-7)
    timezoneOffsetSeconds: -25_200,
};

/** A representative two-day forecast. */
const FORECAST: Forecast = {
    provider: "openweather",
    name: "Portland",
    country: "US",
    days: [
        {
            date: "2026-10-06",
            weekday: "Tuesday",
            tempMin: 52,
            tempMax: 68,
            description: "partly cloudy",
            precipProbability: 0.6,
        },
    ],
};

const OWNER = { configurable: { userId: 7 } };

/** Runs the tool; `configurable` defaults to the owner identity. */
async function run(
    deps?: Partial<{
        provider: WeatherProvider;
        quota: FixedWindowQuota;
        units: WeatherUnits;
    }>,
    args: { location?: string; scope?: "now" | "forecast" } = {},
    runtime: { configurable?: Record<string, unknown> } = OWNER,
): Promise<string> {
    const tool = createGetWeatherTool({
        provider: deps?.provider ?? fakeProvider({}).provider,
        quota: deps?.quota ?? new FixedWindowQuota(10),
        units: deps?.units ?? "imperial",
    });
    return (await tool.invoke(args, runtime)) as string;
}

describe("getWeather location resolution", () => {
    it("prefers an explicit model argument over the device report", async () => {
        const fake = fakeProvider({});
        const result = await run(
            { provider: fake.provider },
            { location: "Paris" },
            {
                configurable: {
                    userId: 7,
                    location: { lat: 45.5, lon: -122.6 },
                },
            },
        );
        expect(fake.currentCalls).toEqual([{ query: "Paris" }]);
        expect(result).toContain("Portland, US");
    });

    it("uses device coordinates when the model passes no location", async () => {
        const fake = fakeProvider({});
        await run(
            { provider: fake.provider },
            {},
            {
                configurable: {
                    userId: 7,
                    location: { lat: 45.5231, lon: -122.6765 },
                },
            },
        );
        expect(fake.currentCalls).toEqual([{ lat: 45.5231, lon: -122.6765 }]);
    });

    it("asks the model to ask the user when no location source exists", async () => {
        const fake = fakeProvider({});
        const result = await run({ provider: fake.provider });
        expect(fake.currentCalls).toHaveLength(0);
        expect(result).toBe(
            "No location is available for this user. Ask the user which city they want the weather for.",
        );
    });

    it("ignores a blank location argument (falls through to the device)", async () => {
        const fake = fakeProvider({});
        await run(
            { provider: fake.provider },
            { location: "   " },
            {
                configurable: {
                    userId: 7,
                    location: { lat: 45.5, lon: -122.6 },
                },
            },
        );
        expect(fake.currentCalls).toEqual([{ lat: 45.5, lon: -122.6 }]);
    });
});

describe("getWeather scope and gates", () => {
    it("routes scope=forecast to the forecast endpoint", async () => {
        const fake = fakeProvider({});
        const result = await run(
            { provider: fake.provider },
            { location: "Portland", scope: "forecast" },
        );
        expect(fake.forecastCalls).toEqual([{ query: "Portland" }]);
        expect(fake.currentCalls).toHaveLength(0);
        expect(result).toContain("1-day forecast");
    });

    it("defaults to current conditions", async () => {
        const fake = fakeProvider({});
        await run({ provider: fake.provider }, { location: "Portland" });
        expect(fake.currentCalls).toHaveLength(1);
        expect(fake.forecastCalls).toHaveLength(0);
    });

    it("refuses guests before any provider call", async () => {
        const fake = fakeProvider({});
        const result = await run(
            { provider: fake.provider },
            { location: "Portland" },
            { configurable: {} },
        );
        expect(fake.currentCalls).toHaveLength(0);
        expect(result).toContain("requires signing in");
    });

    it("returns retry text instead of calling through when the quota is spent", async () => {
        const fake = fakeProvider({});
        const quota = new FixedWindowQuota(1);
        await run({ provider: fake.provider, quota }, { location: "A" });
        const second = await run(
            { provider: fake.provider, quota },
            { location: "B" },
        );
        expect(second).toMatch(/rate limited — try again in about \d+s/);
        // Only the first call reached the provider.
        expect(fake.currentCalls).toHaveLength(1);
    });

    it("maps provider failures to model-facing text without leaking the key", async () => {
        const fake = fakeProvider({
            current: new WeatherError("openweather returned 401"),
        });
        const result = await run(
            { provider: fake.provider },
            { location: "Portland" },
        );
        expect(result).toBe(
            "Weather lookup failed. Answer from your own knowledge, or tell the user that weather data is temporarily unavailable.",
        );
    });
});

describe("getWeather formatters", () => {
    it("renders imperial units with a compass bearing and local time", () => {
        const text = formatCurrentConditions(CONDITIONS, "imperial");
        expect(text).toBe(
            "Portland, US — 63°F (feels like 61°F), light rain. " +
                "Humidity 78%, wind 8 mph S. Observed 2:04 PM local. " +
                "Precipitation 1.2 mm in the last hour.",
        );
    });

    it("renders metric units", () => {
        const text = formatForecast(FORECAST, "metric");
        expect(text).toBe(
            "Portland, US — 1-day forecast:\n" +
                "- Tuesday 2026-10-06: 52–68°C, partly cloudy (60% rain chance)",
        );
    });

    it("omits the rain-chance note when the day is dry", () => {
        const text = formatForecast(
            {
                ...FORECAST,
                days: [{ ...FORECAST.days[0]!, precipProbability: 0 }],
            },
            "imperial",
        );
        expect(text).toBe(
            "Portland, US — 1-day forecast:\n" +
                "- Tuesday 2026-10-06: 52–68°F, partly cloudy",
        );
    });

    it("omits the country when the provider reports none", () => {
        const text = formatCurrentConditions(
            { ...CONDITIONS, country: undefined },
            "imperial",
        );
        expect(text.startsWith("Portland — ")).toBe(true);
    });

    it("renders an empty clock for missing observation timestamps", () => {
        expect(localClock(NaN, 0)).toBe("");
        expect(localClock(1_791_270_000 + 50_640, -25_200)).toBe("2:04 PM");
    });
});

describe("resolveLocation", () => {
    it("returns a coordinate target from a finite device report", () => {
        expect(resolveLocation(undefined, { lat: 45.5, lon: -122.6 })).toEqual({
            lat: 45.5,
            lon: -122.6,
        });
    });

    it("ignores a device report with non-finite coordinates", () => {
        expect(
            resolveLocation(undefined, { lat: NaN, lon: -122.6 }),
        ).toBeUndefined();
    });

    it("returns undefined with neither source", () => {
        expect(resolveLocation(undefined, undefined)).toBeUndefined();
    });

    it("keeps a real place the user named", () => {
        expect(resolveLocation("Paris", { lat: 45.5, lon: -122.6 })).toEqual({
            query: "Paris",
        });
    });

    it("treats a placeholder argument as no place named", () => {
        const device = { lat: 45.5, lon: -122.6 };
        expect(resolveLocation("current", device)).toEqual({
            lat: 45.5,
            lon: -122.6,
        });
        expect(resolveLocation("Here.", device)).toEqual({
            lat: 45.5,
            lon: -122.6,
        });
        expect(resolveLocation("My Current Location", device)).toEqual({
            lat: 45.5,
            lon: -122.6,
        });
        expect(resolveLocation("current", undefined)).toBeUndefined();
    });

    it("does not mistake a real place for a placeholder", () => {
        const device = { lat: 45.5, lon: -122.6 };
        // The near-misses that are genuine places: `Local` (Ohio), `Na`
        // (China), `Default` (Derbyshire), `Hereford`. A wrong answer about the
        // wrong city is worse than one failed lookup, so these must survive.
        for (const place of [
            "Current River",
            "Hereford",
            "Local",
            "Na",
            "Default",
            "Nearby",
        ]) {
            expect(resolveLocation(place, device)).toEqual({ query: place });
        }
    });
});

describe("discardedLocationReason", () => {
    it("reports nothing when the argument was absent or named a place", () => {
        expect(discardedLocationReason(undefined)).toBe("");
        expect(discardedLocationReason("Chicago, US")).toBe("");
    });

    it("classifies an empty or whitespace argument as blank", () => {
        expect(discardedLocationReason("")).toBe("blank");
        expect(discardedLocationReason("   ")).toBe("blank");
    });

    it("classifies a stand-in as a placeholder", () => {
        for (const value of [
            "current",
            "CURRENT",
            "current.",
            "Here",
            "my location",
            "the user's location",
            "N/A",
            "unknown",
        ]) {
            expect(discardedLocationReason(value)).toBe("placeholder");
        }
    });
});

describe("getWeather discarded-argument warning", () => {
    it("warns without echoing the discarded value when the model passes a placeholder", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        try {
            const fake = fakeProvider({});
            await run(
                { provider: fake.provider },
                { location: "current" },
                {
                    configurable: {
                        userId: 7,
                        location: { lat: 45.5, lon: -122.6 },
                    },
                },
            );
            const messages = warn.mock.calls.map((call) => String(call[0]));
            expect(
                messages.some(
                    (message) =>
                        message.includes("placeholder") &&
                        message.includes("device coordinates"),
                ),
            ).toBe(true);
            // The classification is logged; the argument itself never is.
            expect(messages.join("\n")).not.toContain("current");
        } finally {
            warn.mockRestore();
        }
    });

    it("warns that it will ask the user when a placeholder has nothing to fall back to", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        try {
            const fake = fakeProvider({});
            const result = await run(
                { provider: fake.provider },
                { location: "here" },
            );
            expect(fake.currentCalls).toHaveLength(0);
            expect(result).toBe(
                "No location is available for this user. Ask the user which city they want the weather for.",
            );
            expect(
                warn.mock.calls
                    .map((call) => String(call[0]))
                    .some((message) => message.includes("asking the user")),
            ).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });

    it("stays quiet when the model names a real place", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        try {
            const fake = fakeProvider({});
            await run({ provider: fake.provider }, { location: "Chicago, US" });
            expect(
                warn.mock.calls.map((call) => String(call[0])),
            ).not.toContainEqual(
                expect.stringContaining("discarded") as unknown as string,
            );
        } finally {
            warn.mockRestore();
        }
    });
});
