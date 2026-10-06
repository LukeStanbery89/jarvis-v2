/**
 * The `getWeather` tool (#31): the agent's window onto live conditions.
 *
 * One tool for the model with an optional `scope` — current conditions by
 * default, the 5-day forecast on request — served by the OpenWeather client.
 * Location resolves in three steps, in priority order:
 *
 * 1. the model's `location` argument (the user named a place — "Paris"),
 * 2. the device's reported location (the socket's latest `location` frame,
 *    via `configurable.location`), addressed by coordinates,
 * 3. neither → the model is told to ask the user which city.
 *
 * The argument wins deliberately: a user who names a place means that place,
 * even mid-travel with a device fix flowing. Calls are metered per user —
 * the fixed-window quota is checked BEFORE any provider fetch, and its
 * refusal returns model-facing retry text rather than throwing. Provider
 * failures surface as actionable model-facing text too, never as raw
 * exceptions (the model can still answer from its own knowledge).
 *
 * The caller's identity arrives through LangGraph's `configurable.userId`
 * (stamped by `ws.ts` on every authenticated turn — the same verified seam
 * the `analyzeImage` and `webSearch` tools use), so the quota keys on the
 * real account.
 */
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import {
    WeatherError,
    type CurrentConditions,
    type Forecast,
    type WeatherProvider,
    type WeatherUnits,
} from "./weather/types";
import { FixedWindowQuota } from "../../rate/fixedWindowQuota";
import { logger } from "../../logger";
import type { DeviceLocation } from "../../agent";

/** Everything the tool needs, injected at wiring time. */
export interface WeatherDeps {
    /** The configured OpenWeather provider. */
    provider: WeatherProvider;
    /** Per-user metered-call budget. */
    quota: FixedWindowQuota;
    /** Unit system the provider is asked for (drives display glyphs). */
    units: WeatherUnits;
}

/**
 * Formats normalized current conditions as model-facing text.
 *
 * Pure and exported for tests. One compact line — the model relays it, so
 * every token is information: `Portland, US — 63°F (feels like 61°F), light
 * rain. Humidity 78%, wind 8 mph SW. Observed 2:05 PM local.`
 */
export function formatCurrentConditions(
    conditions: CurrentConditions,
    units: WeatherUnits,
): string {
    const temp = units === "imperial" ? "°F" : "°C";
    const speed = units === "imperial" ? "mph" : "m/s";
    const place = conditions.country
        ? `${conditions.name}, ${conditions.country}`
        : conditions.name;
    const lines = [
        `${place} — ${round(conditions.temp)}${temp} (feels like ${round(conditions.feelsLike)}${temp}), ${conditions.description}.`,
        `Humidity ${round(conditions.humidity)}%, wind ${round(conditions.windSpeed)} ${speed}${windCompass(conditions.windDeg)}.`,
    ];
    const local = localClock(
        conditions.observedAt,
        conditions.timezoneOffsetSeconds,
    );
    if (local) {
        lines.push(`Observed ${local} local.`);
    }
    if (conditions.precipitationMm !== undefined) {
        lines.push(
            `Precipitation ${conditions.precipitationMm.toFixed(1)} mm in the last hour.`,
        );
    }
    return lines.join(" ");
}

/**
 * Formats an aggregated forecast as model-facing text.
 *
 * Pure and exported for tests. One line per day:
 * `Portland, US — 5-day forecast:
 * - Tue Oct 6: 52–68°F, partly cloudy (60% rain chance)
 * - …`
 */
export function formatForecast(
    forecast: Forecast,
    units: WeatherUnits,
): string {
    const temp = units === "imperial" ? "°F" : "°C";
    const place = forecast.country
        ? `${forecast.name}, ${forecast.country}`
        : forecast.name;
    const lines = [
        `${place} — ${forecast.days.length}-day forecast:`,
        ...forecast.days.map((day) => {
            const chance =
                day.precipProbability > 0
                    ? ` (${Math.round(day.precipProbability * 100)}% rain chance)`
                    : "";
            return `- ${day.weekday} ${day.date}: ${round(day.tempMin)}–${round(day.tempMax)}${temp}, ${day.description}${chance}`;
        }),
    ];
    return lines.join("\n");
}

/** Rounds a display number to one decimal at most (provider floats are noisy). */
function round(value: number): string {
    const r = Math.round(value * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Eight-point compass label for a meteorological wind direction, or "". */
function windCompass(deg?: number): string {
    if (deg === undefined) {
        return "";
    }
    const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return ` ${points[Math.round((((deg % 360) + 360) % 360) / 45) % 8]}`;
}

/**
 * Renders a unix timestamp as the location's wall clock ("2:05 PM").
 *
 * Pure and exported for tests. Returns "" for a missing or non-finite
 * timestamp — the observation instant is optional information, never worth
 * failing the whole formatting over.
 */
export function localClock(
    observedAt: number,
    timezoneOffsetSeconds: number,
): string {
    if (
        !Number.isFinite(observedAt) ||
        !Number.isFinite(timezoneOffsetSeconds)
    ) {
        return "";
    }
    const local = new Date((observedAt + timezoneOffsetSeconds) * 1000);
    if (Number.isNaN(local.getTime())) {
        return "";
    }
    const hours = local.getUTCHours();
    const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const meridiem = hours < 12 ? "AM" : "PM";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${hour12}:${pad(local.getUTCMinutes())} ${meridiem}`;
}

/** Model-facing text for a failed lookup; never leaks keys or internals. */
function failureText(reason: string): string {
    logger.warn(`getWeather failed — ${reason}`);
    return "Weather lookup failed. Answer from your own knowledge, or tell the user that weather data is temporarily unavailable.";
}

/** Model-facing text when no location source is available (#31). */
const ASK_FOR_CITY =
    "No location is available for this user. Ask the user which city they want the weather for.";

/** Model-facing text when the socket is a guest; mirrors webSearch. */
const SIGN_IN_REQUIRED =
    "Weather lookup requires signing in. Ask the user to authenticate and retry.";

/**
 * Builds the `getWeather` tool over the injected provider, quota, and units.
 */
export function createGetWeatherTool(deps: WeatherDeps) {
    return tool(
        async ({ location, scope }, runtime: ToolRuntime): Promise<string> => {
            const owner = runtime.configurable?.userId;
            if (typeof owner !== "number" || !Number.isInteger(owner)) {
                logger.warn("getWeather called without a user id");
                return SIGN_IN_REQUIRED;
            }
            const admission = deps.quota.tryAcquire(owner);
            if (!admission.ok) {
                const seconds = Math.max(
                    1,
                    Math.ceil(admission.retryAfterMs / 1000),
                );
                return `Weather lookup is rate limited — try again in about ${seconds}s.`;
            }
            const target = resolveLocation(
                location,
                runtime.configurable?.location as DeviceLocation | undefined,
            );
            if (!target) {
                logger.debug(
                    "getWeather has no location source (no argument, no device report)",
                );
                return ASK_FOR_CITY;
            }
            logger.debug(
                `getWeather target: ${
                    "query" in target
                        ? `q=${target.query}`
                        : `lat/lon ~${target.lat.toFixed(2)},${target.lon.toFixed(2)}`
                } (scope ${scope ?? "now"})`,
            );
            const effectiveScope = scope ?? "now";
            try {
                if (effectiveScope === "forecast") {
                    const forecast = await deps.provider.forecast(target);
                    logger.debug(
                        `getWeather(forecast) via ${forecast.provider}: ${forecast.days.length} days`,
                    );
                    return formatForecast(forecast, deps.units);
                }
                const conditions = await deps.provider.current(target);
                logger.debug(
                    `getWeather(now) via ${conditions.provider}: ${conditions.name}`,
                );
                return formatCurrentConditions(conditions, deps.units);
            } catch (err) {
                return failureText(
                    err instanceof WeatherError
                        ? err.message
                        : "unexpected error",
                );
            }
        },
        {
            name: "getWeather",
            description:
                "Returns current weather conditions or a 5-day forecast for a " +
                "location, including temperature, conditions, humidity, wind, " +
                "and rain chances. Pass the place the user named as `location` " +
                "('Portland', 'Tokyo, JP'); OMIT `location` entirely when the " +
                "user does not name one — the server knows the device's " +
                "location and will use it. If a lookup fails, retry once with " +
                "a plainer name or a 2-letter country code ('Chicago,US'). " +
                "Use `scope: 'forecast'` only when " +
                "the user asks about coming days; conditions right now are " +
                "the default. Use it for ANY weather question — never answer " +
                "weather from memory.",
            schema: z.object({
                location: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "The place the user named, verbatim or lightly " +
                            "sharpened; omit when they did not name a place",
                    ),
                scope: z
                    .enum(["now", "forecast"])
                    .optional()
                    .describe(
                        "'now' (the default) for current conditions, " +
                            "'forecast' for the 5-day outlook",
                    ),
            }),
        },
    );
}

/**
 * Resolves the tool's location target (#31).
 *
 * Pure and exported for tests — the fallback order is load-bearing: an
 * explicit (non-blank) model argument wins over the device report, the
 * device report becomes a coordinate lookup, and neither leaves the model
 * to ask the user.
 */
export function resolveLocation(
    argument: string | undefined,
    device: DeviceLocation | undefined,
): { query: string } | { lat: number; lon: number } | undefined {
    const named = argument?.trim();
    if (named) {
        return { query: named };
    }
    if (device && Number.isFinite(device.lat) && Number.isFinite(device.lon)) {
        return { lat: device.lat, lon: device.lon };
    }
    return undefined;
}
