/**
 * Tests for the dashboard weather endpoint (#186).
 *
 * The route is the browser's half of the existing OpenWeather client: auth,
 * coordinate parsing, the shared per-user budget, the normalized response, and
 * the three failure answers the widget distinguishes. Contract verification is
 * on, so the response shape is checked against `spec/openapi.yaml` too.
 */
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import { createApp } from "../src/app";
import { FixedWindowQuota } from "../src/rate/fixedWindowQuota";
import { WeatherError } from "../src/llm/tools/weather/types";
import type {
    CurrentConditions,
    Forecast,
    WeatherProvider,
} from "../src/llm/tools/weather/types";
import type { WeatherRouteDeps } from "../src/http/weatherRoutes";
import type { AppConfig } from "../src/config";

/** Contract-verifying config: the shape is as much a subject as the status. */
const CONFIG: AppConfig = {
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: "weather-bootstrap-secret",
    apiContractVerify: true,
};

const CONDITIONS: CurrentConditions = {
    provider: "openweather",
    name: "Portland",
    country: "US",
    temp: 63,
    feelsLike: 61,
    description: "light rain",
    condition: "Rain",
    conditionId: 500,
    humidity: 78,
    windSpeed: 8,
    windDeg: 200,
    cloudCover: 90,
    observedAt: 1_760_000_000,
    timezoneOffsetSeconds: -25_200,
    sunrise: 1_760_002_400,
    sunset: 1_760_040_000,
};

const FORECAST: Forecast = {
    provider: "openweather",
    name: "Portland",
    days: [],
};

/** Stores created by the suite, closed afterwards. */
const stores: AppDatabase[] = [];

afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
});

/** A provider whose current call returns `conditions` (or throws). */
function provider(
    result: CurrentConditions | Error = CONDITIONS,
): WeatherProvider {
    return {
        name: "openweather",
        current: vi.fn(async () => {
            if (result instanceof Error) {
                throw result;
            }
            return result;
        }),
        forecast: vi.fn(async () => FORECAST),
    };
}

/** Builds an app, bootstraps an owner, and returns the bearer token. */
async function makeApp(weather?: WeatherRouteDeps): Promise<{
    app: ReturnType<typeof createApp>;
    token: string;
}> {
    const store = createInMemoryAppDatabase();
    stores.push(store);
    const app = createApp(
        store,
        CONFIG,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        weather,
    );
    const boot = await request(app)
        .post("/api/bootstrap")
        .set("x-bootstrap-token", CONFIG.bootstrapToken!)
        .send({
            username: "luke",
            password: "owner-password-1",
            deviceName: "weather-test",
        });
    expect(boot.status).toBe(201);
    return { app, token: boot.body.device.token as string };
}

/** A configured weather dependency set with a fake provider. */
function weatherDeps(
    result: CurrentConditions | Error = CONDITIONS,
    callsPerMin = 10,
): WeatherRouteDeps & { provider: WeatherProvider } {
    return {
        provider: provider(result),
        quota: new FixedWindowQuota(callsPerMin),
        units: "imperial",
    };
}

describe("GET /api/weather", () => {
    it("requires authentication", async () => {
        const { app } = await makeApp(weatherDeps());
        const res = await request(app).get(
            "/api/weather?lat=45.52&lon=-122.68",
        );
        expect(res.status).toBe(401);
        expect(typeof res.body.error).toBe("string");
    });

    it("returns the normalized current conditions for the coordinates", async () => {
        const deps = weatherDeps();
        const { app, token } = await makeApp(deps);
        const res = await request(app)
            .get("/api/weather?lat=45.52&lon=-122.68")
            .set("authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(deps.provider.current).toHaveBeenCalledWith({
            lat: 45.52,
            lon: -122.68,
        });
        expect(res.body).toEqual({
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
            sunrise: 1_760_002_400,
            sunset: 1_760_040_000,
            units: "imperial",
        });
    });

    it("rejects a coordinate outside its range", async () => {
        const { app, token } = await makeApp(weatherDeps());
        const res = await request(app)
            .get("/api/weather?lat=91&lon=-122.68")
            .set("authorization", `Bearer ${token}`);
        expect(res.status).toBe(400);
        expect(typeof res.body.error).toBe("string");
    });

    it("shares the tool's per-user budget and says when it renews", async () => {
        const deps = weatherDeps(CONDITIONS, 1);
        const { app, token } = await makeApp(deps);
        const first = await request(app)
            .get("/api/weather?lat=45.52&lon=-122.68")
            .set("authorization", `Bearer ${token}`);
        expect(first.status).toBe(200);

        const second = await request(app)
            .get("/api/weather?lat=45.52&lon=-122.68")
            .set("authorization", `Bearer ${token}`);
        expect(second.status).toBe(429);
        expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
        expect(deps.provider.current).toHaveBeenCalledTimes(1);
    });

    it("answers a generic 502 when the provider fails", async () => {
        const { app, token } = await makeApp(
            weatherDeps(new WeatherError("openweather said secret things")),
        );
        const res = await request(app)
            .get("/api/weather?lat=45.52&lon=-122.68")
            .set("authorization", `Bearer ${token}`);
        expect(res.status).toBe(502);
        expect(res.body.error).toBe("weather is temporarily unavailable");
    });

    it("says weather is not configured when the server has no key", async () => {
        const { app, token } = await makeApp();
        const res = await request(app)
            .get("/api/weather?lat=45.52&lon=-122.68")
            .set("authorization", `Bearer ${token}`);
        expect(res.status).toBe(503);
        expect(res.body.error).toContain("not configured");
    });
});
