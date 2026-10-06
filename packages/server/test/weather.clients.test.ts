/**
 * Tests for the OpenWeather weather client (#31): request shapes, units,
 * location routing (text query vs device coordinates), defensive
 * normalization (absent phenomena, forecast aggregation), and typed failure
 * modes. The key must never appear in an error message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenWeatherClient } from "../src/llm/tools/weather/openweather";
import { WeatherError } from "../src/llm/tools/weather/types";

/** Builds a mock fetch returning `body` as JSON (or throwing on raw). */
function mockJsonFetch(
    respond: { status?: number; body: unknown } | { failWith: unknown },
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        calls.push({
            url: String(input),
            init: (init ?? {}) as RequestInit,
        });
        if ("failWith" in respond) {
            throw respond.failWith;
        }
        return new Response(
            respond.status && respond.status !== 200
                ? JSON.stringify(respond.body)
                : JSON.stringify(respond.body),
            {
                status: respond.status ?? 200,
                headers: { "Content-Type": "application/json" },
            },
        );
    };
    return { fetch: impl as unknown as typeof fetch, calls };
}

const OPTS = {
    apiKey: "ow-secret-key",
    units: "imperial" as const,
    timeoutMs: 5_000,
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("openweather current", () => {
    it("sends q + units + appid for a text query", async () => {
        const { fetch, calls } = mockJsonFetch({
            body: CURRENT_BODY,
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.current({ query: "Portland,OR,US" });
        expect(calls).toEqual([
            {
                url: "https://api.openweathermap.org/data/2.5/weather?appid=ow-secret-key&units=imperial&q=Portland%2COR%2CUS",
                init: { signal: expect.any(AbortSignal) },
            },
        ]);
        expect(result).toEqual({
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
            observedAt: 1_760_000_000,
            timezoneOffsetSeconds: -25_200,
        });
    });

    it("sends lat/lon for device coordinates instead of q", async () => {
        const { fetch, calls } = mockJsonFetch({ body: CURRENT_BODY });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        await client.current({ lat: 45.5231, lon: -122.6765 });
        expect(calls[0]?.url).toContain("lat=45.5231");
        expect(calls[0]?.url).toContain("lon=-122.6765");
        expect(calls[0]?.url).not.toContain("q=");
    });

    it("sends metric units when configured", async () => {
        const { fetch, calls } = mockJsonFetch({ body: CURRENT_BODY });
        const client = createOpenWeatherClient({
            ...OPTS,
            units: "metric",
            fetchImpl: fetch,
        });
        await client.current({ query: "Portland" });
        expect(calls[0]?.url).toContain("units=metric");
    });

    it("normalizes a body with no rain, snow, wind direction, or clouds", async () => {
        const { fetch } = mockJsonFetch({
            body: {
                name: "Zocca",
                main: { temp: 298.48, feels_like: 298.74, humidity: 64 },
                weather: [{ main: "Clear", description: "clear sky" }],
                wind: { speed: 0.62 },
                dt: 1_760_000_000,
                timezone: 7_200,
            },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.current({ query: "Zocca" });
        expect(result.precipitationMm).toBeUndefined();
        expect(result.windDeg).toBeUndefined();
        expect(result.cloudCover).toBeUndefined();
        expect(result.country).toBeUndefined();
    });

    it("sums rain and snow into one precipitation figure", async () => {
        const { fetch } = mockJsonFetch({
            body: {
                ...CURRENT_BODY,
                rain: { "1h": 0.4 },
                snow: { "1h": 0.6 },
            },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.current({ query: "X" });
        expect(result.precipitationMm).toBe(1);
    });
});

describe("openweather forecast aggregation", () => {
    it("folds 3-hourly steps into daily min/max with a noon headline", async () => {
        const { fetch, calls } = mockJsonFetch({ body: FORECAST_BODY });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.forecast({ query: "Portland" });
        expect(calls[0]?.url).toContain("/data/2.5/forecast?");
        expect(result.name).toBe("Portland");
        expect(result.country).toBe("US");
        expect(result.days).toHaveLength(2);
        // Day 1: min across {55, 52, 54} and max across {63, 68, 66}; the
        // 12:00 local step ("partly cloudy") wins the headline; the day's
        // peak rain chance is 0.6.
        expect(result.days[0]).toEqual({
            date: "2026-10-06",
            weekday: "Tuesday",
            tempMin: 52,
            tempMax: 68,
            description: "partly cloudy",
            precipProbability: 0.6,
        });
        expect(result.days[1]).toEqual({
            date: "2026-10-07",
            weekday: "Wednesday",
            tempMin: 48,
            tempMax: 61,
            description: "light rain",
            precipProbability: 0.9,
        });
    });

    it("caps the aggregation at five days", async () => {
        const steps = Array.from({ length: 48 }, (_, i) => ({
            dt: BASE_DT + i * 10_800,
            main: { temp: 60, temp_min: 60, temp_max: 60 },
            weather: [{ main: "Clear", description: "clear sky" }],
            pop: 0,
        }));
        const { fetch } = mockJsonFetch({
            body: { city: FORECAST_BODY.city, list: steps },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.forecast({ query: "X" });
        expect(result.days).toHaveLength(5);
    });

    it("skips a malformed step without sinking the rest", async () => {
        const { fetch } = mockJsonFetch({
            body: {
                city: FORECAST_BODY.city,
                list: [
                    { main: { temp: 60 } }, // no dt — skipped
                    ...((FORECAST_BODY.list as unknown[]) ?? []),
                ],
            },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        const result = await client.forecast({ query: "X" });
        expect(result.days).toHaveLength(2);
    });

    it("rejects a forecast with no usable steps", async () => {
        const { fetch } = mockJsonFetch({
            body: { city: FORECAST_BODY.city, list: [{ main: {} }] },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.forecast({ query: "X" })).rejects.toThrow(
            WeatherError,
        );
    });
});

describe("openweather failures", () => {
    it("maps an HTTP status to a typed error without leaking the key", async () => {
        for (const status of [401, 404, 500]) {
            const { fetch } = mockJsonFetch({
                status,
                body: { cod: status, message: "x" },
            });
            const client = createOpenWeatherClient({
                ...OPTS,
                fetchImpl: fetch,
            });
            const err = await client
                .current({ query: "X" })
                .catch((e: unknown) => e);
            expect(err).toBeInstanceOf(WeatherError);
            expect((err as Error).message).toBe(
                `openweather returned ${status}`,
            );
            expect((err as Error).message).not.toContain(OPTS.apiKey);
        }
    });

    it("maps transport failures to a typed error", async () => {
        const { fetch } = mockJsonFetch({ failWith: new Error("dns died") });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.current({ query: "X" })).rejects.toThrow(
            "openweather unreachable: dns died",
        );
    });

    it("maps invalid JSON to a typed error", async () => {
        const calls: string[] = [];
        const impl = (async (..._args: Parameters<typeof fetch>) => {
            calls.push("called");
            return new Response("<html>502</html>", { status: 200 });
        }) as unknown as typeof fetch;
        const client = createOpenWeatherClient({
            ...OPTS,
            fetchImpl: impl,
        });
        await expect(client.current({ query: "X" })).rejects.toThrow(
            "openweather returned invalid JSON",
        );
        expect(calls).toHaveLength(1);
    });

    it("rejects a current payload missing its temperature", async () => {
        const { fetch } = mockJsonFetch({
            body: { name: "X", weather: [{ description: "clear" }] },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.current({ query: "X" })).rejects.toThrow(
            "missing current temp",
        );
    });

    it("rejects a current payload missing its condition text", async () => {
        const { fetch } = mockJsonFetch({
            body: { name: "X", main: { temp: 60 }, weather: [] },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.current({ query: "X" })).rejects.toThrow(
            "missing condition text",
        );
    });

    it("rejects a current payload missing its location name", async () => {
        const { fetch } = mockJsonFetch({
            body: {
                main: { temp: 60 },
                weather: [{ description: "clear" }],
            },
        });
        const client = createOpenWeatherClient({ ...OPTS, fetchImpl: fetch });
        await expect(client.current({ query: "X" })).rejects.toThrow(
            "missing location name",
        );
    });
});

/** A representative /weather payload (imperial units). */
const CURRENT_BODY = {
    coord: { lon: -122.68, lat: 45.52 },
    weather: [{ id: 500, main: "Rain", description: "light rain" }],
    main: { temp: 63, feels_like: 61, humidity: 78 },
    wind: { speed: 8, deg: 200 },
    clouds: { all: 90 },
    rain: { "1h": 1.2 },
    dt: 1_760_000_000,
    sys: { country: "US" },
    timezone: -25_200,
    name: "Portland",
};

/** Unix seconds for local Tue 2026-10-06 00:00 at UTC-7 (2026-10-06T07:00Z). */
const BASE_DT = 1_791_270_000;

/** A two-day /forecast payload whose steps sit at 00/12/21 local (UTC-7). */
const FORECAST_BODY = {
    city: { name: "Portland", country: "US", timezone: -25_200 },
    list: [
        step(BASE_DT, 55, 52, 63, "clear sky", 0), // Tue 00:00 local
        step(BASE_DT + 43_200, 63, 61, 68, "partly cloudy", 0.6), // Tue 12:00
        step(BASE_DT + 75_600, 54, 52, 66, "light rain", 0.3), // Tue 21:00
        step(BASE_DT + 86_400, 50, 48, 55, "light rain", 0.9), // Wed 00:00
        step(BASE_DT + 129_600, 61, 58, 61, "light rain", 0.2), // Wed 12:00
    ],
};

/** Builds one forecast step for the fixture (all temps °F). */
function step(
    dt: number,
    temp: number,
    tempMin: number,
    tempMax: number,
    description: string,
    pop: number,
): unknown {
    return {
        dt,
        main: { temp, temp_min: tempMin, temp_max: tempMax },
        weather: [{ main: "Rain", description }],
        pop,
    };
}
