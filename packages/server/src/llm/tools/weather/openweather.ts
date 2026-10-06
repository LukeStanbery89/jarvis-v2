/**
 * The OpenWeather weather provider (#31).
 *
 * OpenWeather's free tier serves current conditions and the 5-day/3-hour
 * forecast (60 calls/minute account-wide, no card required); paid tiers add
 * hourly/16-day forecasts and One Call, none of which this client touches.
 * Hand-rolled `fetch` rather than a community package — two GET endpoints,
 * full control over timeout and error shapes, zero new dependencies.
 *
 * The built-in city-name geocoder (`q=`) is upstream-deprecated but still
 * functional and free; it is used for text queries because the alternative
 * (Geocoding API → coordinates) doubles the calls per request. Coordinate
 * queries go straight to `lat`/`lon`. Either way the response carries the
 * resolved place `name`, so display needs no reverse geocoding.
 */
import {
    WeatherError,
    type CurrentConditions,
    type Forecast,
    type ForecastDay,
    type WeatherLocation,
    type WeatherProvider,
    type WeatherUnits,
} from "./types";

/** OpenWeather's 2.5 data root (current weather + forecast share it). */
const OPENWEATHER_BASE = "https://api.openweathermap.org/data/2.5";

/** Options for {@link createOpenWeatherClient}. */
export interface OpenWeatherOptions {
    /** The `OPENWEATHER_API_KEY` secret; never logged, never in error text. */
    readonly apiKey: string;
    /** Unit system requested from the provider (temperature + wind units). */
    readonly units: WeatherUnits;
    /** Wall-clock cap applied when the caller supplies no signal. */
    readonly timeoutMs: number;
    /** Injectable for tests (defaults to global `fetch`). */
    readonly fetchImpl?: typeof fetch;
}

/** Defensive field coercion for untrusted provider JSON: a number or NaN. */
function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/** Defensive field coercion for untrusted provider JSON: a string or "". */
function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/**
 * GETs one OpenWeather endpoint and returns the parsed JSON body.
 *
 * Shared transport for both scopes: builds the query (`appid` + `units` plus
 * `q` or `lat`/`lon`), applies the timeout, and maps transport/HTTP/JSON
 * failures onto typed `WeatherError`s. Status text is the raw code ("401"
 * covers an unactivated or wrong key; "404" an unresolvable place) — the key
 * itself never appears in any message.
 */
async function getJson(
    path: string,
    params: Record<string, string>,
    opts: OpenWeatherOptions,
    signal?: AbortSignal,
): Promise<unknown> {
    const query = new URLSearchParams({ appid: opts.apiKey, ...params });
    const effectiveSignal = signal ?? AbortSignal.timeout(opts.timeoutMs);
    let response: Response;
    try {
        response = await (opts.fetchImpl ?? fetch)(
            `${OPENWEATHER_BASE}${path}?${query}`,
            { signal: effectiveSignal },
        );
    } catch (err) {
        // Abort/timeout or transport failure — never the key.
        throw new WeatherError(
            `openweather unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
        );
    }
    if (!response.ok) {
        throw new WeatherError(`openweather returned ${response.status}`);
    }
    try {
        return await response.json();
    } catch {
        throw new WeatherError("openweather returned invalid JSON");
    }
}

/**
 * Normalizes a `/weather` payload into {@link CurrentConditions}.
 *
 * Defensive by design: `rain`/`snow`/`wind.deg`/`clouds` are legitimately
 * absent when the phenomenon is not happening (the provider omits fields
 * rather than sending zeroes), so absence maps to `undefined`. A missing
 * temperature, condition, or name is a shape violation, not an absence —
 * those are `WeatherError`s.
 */
function normalizeCurrent(raw: unknown): CurrentConditions {
    const body = raw as {
        name?: unknown;
        sys?: { country?: unknown };
        main?: { temp?: unknown; feels_like?: unknown; humidity?: unknown };
        weather?: unknown;
        wind?: { speed?: unknown; deg?: unknown };
        clouds?: { all?: unknown };
        rain?: { "1h"?: unknown };
        snow?: { "1h"?: unknown };
        dt?: unknown;
        timezone?: unknown;
    };
    const temp = asNumber(body.main?.temp);
    if (Number.isNaN(temp)) {
        throw new WeatherError("openweather response missing current temp");
    }
    const weather = Array.isArray(body.weather) ? body.weather : [];
    const first = (weather[0] ?? {}) as {
        main?: unknown;
        description?: unknown;
    };
    const description = asString(first.description);
    if (description === "") {
        throw new WeatherError("openweather response missing condition text");
    }
    const name = asString(body.name);
    if (name === "") {
        throw new WeatherError("openweather response missing location name");
    }
    const rain = asNumber(body.rain?.["1h"]);
    const snow = asNumber(body.snow?.["1h"]);
    const windSpeed = asNumber(body.wind?.speed);
    if (Number.isNaN(windSpeed)) {
        throw new WeatherError("openweather response missing wind speed");
    }
    const windDeg = asNumber(body.wind?.deg);
    const cloudCover = asNumber(body.clouds?.all);
    return {
        provider: "openweather",
        name,
        country: asString(body.sys?.country) || undefined,
        temp,
        feelsLike: asNumber(body.main?.feels_like),
        description,
        condition: asString(first.main) || description,
        humidity: asNumber(body.main?.humidity),
        windSpeed,
        windDeg: Number.isNaN(windDeg) ? undefined : windDeg,
        cloudCover: Number.isNaN(cloudCover) ? undefined : cloudCover,
        precipitationMm:
            Number.isNaN(rain) && Number.isNaN(snow)
                ? undefined
                : (Number.isNaN(rain) ? 0 : rain) +
                  (Number.isNaN(snow) ? 0 : snow),
        observedAt: asNumber(body.dt),
        timezoneOffsetSeconds: asNumber(body.timezone),
    };
}

/** English weekday names for {@link aggregateForecast}'s day labels. */
const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/**
 * Normalizes a `/forecast` payload into {@link Forecast}.
 *
 * The provider returns ~40 three-hourly steps; users speak in days, so the
 * steps are folded per local calendar date (derived by shifting each step's
 * unix `dt` by the city's `timezone` offset, then reading UTC getters —
 * grouping by UTC would misplace days across the midnight boundary). Each
 * day folds its steps into a min/max range, the step closest to local noon
 * as the headline condition, and the peak precipitation probability. A step
 * missing its timestamp or temperature is skipped — one malformed step out
 * of forty should not sink a four-day forecast — but a payload with no
 * usable steps at all is a shape violation.
 */
function normalizeForecast(raw: unknown): Forecast {
    const body = raw as {
        city?: { name?: unknown; country?: unknown; timezone?: unknown };
        list?: unknown;
    };
    const name = asString(body.city?.name);
    if (name === "") {
        throw new WeatherError("openweather forecast missing location name");
    }
    if (!Array.isArray(body.list)) {
        throw new WeatherError("openweather forecast missing step list");
    }
    const timezone = asNumber(body.city?.timezone) || 0;
    const byDate = new Map<string, ForecastStep[]>();
    const order: string[] = [];
    for (const rawStep of body.list as unknown[]) {
        let step: ForecastStep;
        try {
            step = normalizeStep(rawStep);
        } catch {
            continue;
        }
        const local = new Date((step.dt + timezone) * 1000);
        const pad = (n: number) => String(n).padStart(2, "0");
        const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
        step.noonDistance = Math.abs(local.getUTCHours() - 12);
        let bucket = byDate.get(date);
        if (!bucket) {
            bucket = [];
            byDate.set(date, bucket);
            order.push(date);
        }
        bucket.push(step);
    }
    const days: ForecastDay[] = order.slice(0, 5).map((date) => {
        const steps = byDate.get(date)!;
        // Headline: the step closest to local noon — midday conditions say
        // "the day" better than the most-frequent bucket, which a stretch
        // of identical 3 AM hours can dominate.
        let headline = steps[0];
        for (const step of steps) {
            if (step.noonDistance < headline.noonDistance) {
                headline = step;
            }
        }
        const tempMin = Math.min(
            ...steps.map((s) => Math.min(s.temp, s.tempMin)),
        );
        const tempMax = Math.max(
            ...steps.map((s) => Math.max(s.temp, s.tempMax)),
        );
        return {
            date,
            weekday: WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()],
            tempMin,
            tempMax,
            description: headline.description,
            precipProbability: Math.max(...steps.map((s) => s.pop)),
        };
    });
    if (days.length === 0) {
        throw new WeatherError("openweather forecast missing step list");
    }
    return {
        provider: "openweather",
        name,
        country: asString(body.city?.country) || undefined,
        days,
    };
}

/** One normalized 3-hourly forecast step (internal to the aggregation). */
interface ForecastStep {
    /** Unix (UTC) seconds of the step. */
    dt: number;
    temp: number;
    tempMin: number;
    tempMax: number;
    description: string;
    /** Precipitation probability, 0–1 (provider default 0 when absent). */
    pop: number;
    /** |local hour − 12| for the step, set by the aggregation loop. */
    noonDistance: number;
}

/**
 * Normalizes one raw forecast step.
 *
 * Throws when the step lacks a usable timestamp or temperature (the
 * aggregation loop skips such steps); `pop` defaults to 0, the provider
 * omitting the field when precipitation is impossible for the step.
 */
function normalizeStep(raw: unknown): ForecastStep {
    const step = raw as {
        dt?: unknown;
        main?: { temp?: unknown; temp_min?: unknown; temp_max?: unknown };
        weather?: unknown;
        pop?: unknown;
    };
    const dt = asNumber(step.dt);
    const temp = asNumber(step.main?.temp);
    if (Number.isNaN(dt) || Number.isNaN(temp)) {
        throw new WeatherError("openweather forecast step missing dt/temp");
    }
    const weather = Array.isArray(step.weather) ? step.weather : [];
    const first = (weather[0] ?? {}) as { description?: unknown };
    return {
        dt,
        temp,
        tempMin: asNumber(step.main?.temp_min),
        tempMax: asNumber(step.main?.temp_max),
        description: asString(first.description) || "conditions unavailable",
        pop: Number.isNaN(asNumber(step.pop)) ? 0 : asNumber(step.pop),
        noonDistance: 0,
    };
}

/**
 * Builds the OpenWeather provider.
 *
 * `current` and `forecast` share one transport ({@link getJson}) and differ
 * only in endpoint and location params; text queries go out as `q=`, device
 * coordinates as `lat`/`lon`.
 */
export function createOpenWeatherClient(
    opts: OpenWeatherOptions,
): WeatherProvider {
    const locationParams = (location: WeatherLocation) =>
        "query" in location
            ? { q: location.query }
            : {
                  lat: String(location.lat),
                  lon: String(location.lon),
              };
    return {
        name: "openweather",
        async current(
            location: WeatherLocation,
            signal?: AbortSignal,
        ): Promise<CurrentConditions> {
            return normalizeCurrent(
                await getJson(
                    "/weather",
                    { units: opts.units, ...locationParams(location) },
                    opts,
                    signal,
                ),
            );
        },
        async forecast(
            location: WeatherLocation,
            signal?: AbortSignal,
        ): Promise<Forecast> {
            return normalizeForecast(
                await getJson(
                    "/forecast",
                    { units: opts.units, ...locationParams(location) },
                    opts,
                    signal,
                ),
            );
        },
    };
}
