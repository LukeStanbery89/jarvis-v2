/**
 * Presentation helpers for the dashboard weather widget (#186).
 *
 * Pure and framework-free, so the web package's node-environment suite can
 * drive every condition/day-night decision without a DOM. The server returns
 * OpenWeather's normalized numbers; these helpers decide what a person sees:
 * which graphic (never an emoji), whether the moon or the sun belongs there,
 * and the wind's compass word.
 */
import type { WeatherNow } from "./api";

/** The condition graphics the widget can draw. */
export type WeatherGlyphKind =
    | "clear-day"
    | "clear-night"
    | "partly-day"
    | "partly-night"
    | "cloudy"
    | "rain"
    | "drizzle"
    | "snow"
    | "thunder"
    | "fog"
    | "wind";

/** The subset of a weather response that decides day vs night. */
export type DayNightInput = Pick<
    WeatherNow,
    "observedAt" | "timezoneOffsetSeconds" | "sunrise" | "sunset"
>;

/**
 * Whether the observation happened in daylight at its own location.
 *
 * Sunrise/sunset win when the provider supplied both: they are the real
 * boundary at high latitudes and across DST, whereas a fixed 6-to-6 clock is
 * only a fallback. The fallback shifts the observation into local time and
 * treats 06:00–17:59 as day — the shape a missing `sys` block leaves.
 *
 * @param weather - The observation instant, its offset, and optional sun times.
 */
export function isDaytime(weather: DayNightInput): boolean {
    const { observedAt, timezoneOffsetSeconds, sunrise, sunset } = weather;
    if (
        sunrise !== undefined &&
        sunset !== undefined &&
        Number.isFinite(sunrise) &&
        Number.isFinite(sunset) &&
        sunrise < sunset
    ) {
        return observedAt >= sunrise && observedAt < sunset;
    }
    if (
        !Number.isFinite(observedAt) ||
        !Number.isFinite(timezoneOffsetSeconds)
    ) {
        return true;
    }
    const local = new Date(
        (observedAt + timezoneOffsetSeconds) * 1_000,
    ).getUTCHours();
    return local >= 6 && local < 18;
}

/**
 * Chooses the condition graphic.
 *
 * The numeric provider code is authoritative when present (OpenWeather groups
 * thunder 2xx, drizzle 3xx, rain 5xx, snow 6xx, atmosphere 7xx, and clouds
 * 80x); the text is the fallback for another provider or a partial payload.
 * Day/night only changes the clear and partly-cloudy graphics — rain at night
 * is still rain.
 *
 * @param weather - The condition code/text.
 * @param day - Whether the observation was in daylight (see {@link isDaytime}).
 */
export function weatherGlyph(
    weather: Pick<WeatherNow, "conditionId" | "condition" | "description">,
    day: boolean,
): WeatherGlyphKind {
    const id = weather.conditionId;
    if (id !== undefined && Number.isFinite(id)) {
        if (id >= 200 && id < 300) {
            return "thunder";
        }
        if (id >= 300 && id < 400) {
            return "drizzle";
        }
        if (id >= 500 && id < 600) {
            return "rain";
        }
        if (id >= 600 && id < 700) {
            return "snow";
        }
        if (id >= 700 && id < 800) {
            return id === 771 || id === 781 ? "wind" : "fog";
        }
        if (id === 800) {
            return day ? "clear-day" : "clear-night";
        }
        if (id === 801 || id === 802) {
            return day ? "partly-day" : "partly-night";
        }
        if (id >= 803) {
            return "cloudy";
        }
    }

    const text = `${weather.condition} ${weather.description}`.toLowerCase();
    if (/thunder|storm/.test(text)) {
        return "thunder";
    }
    if (/snow|sleet|blizzard|ice pellets/.test(text)) {
        return "snow";
    }
    if (/drizzle/.test(text)) {
        return "drizzle";
    }
    if (/rain|shower/.test(text)) {
        return "rain";
    }
    if (/fog|mist|haze|smoke|dust|sand|ash/.test(text)) {
        return "fog";
    }
    if (/tornado|squall|wind/.test(text)) {
        return "wind";
    }
    if (/few|scattered|partly/.test(text)) {
        return day ? "partly-day" : "partly-night";
    }
    if (/cloud|overcast/.test(text)) {
        return "cloudy";
    }
    if (/clear|sunny/.test(text)) {
        return day ? "clear-day" : "clear-night";
    }
    return "cloudy";
}

/**
 * The eight-point compass word for a meteorological wind direction.
 *
 * @param degrees - Wind direction in degrees, when the provider reported one.
 * @returns `"SW"`, for example, or `null` when there is no usable direction.
 */
export function compassDirection(degrees?: number): string | null {
    if (degrees === undefined || !Number.isFinite(degrees)) {
        return null;
    }
    const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const normalized = ((degrees % 360) + 360) % 360;
    return points[Math.round(normalized / 45) % 8] ?? null;
}

/** The temperature suffix for the response's unit system. */
export function temperatureUnit(units: WeatherNow["units"]): "°F" | "°C" {
    return units === "imperial" ? "°F" : "°C";
}

/** The wind-speed suffix for the response's unit system. */
export function windUnit(units: WeatherNow["units"]): "mph" | "m/s" {
    return units === "imperial" ? "mph" : "m/s";
}

/** Rounds a temperature for display (provider values are usually fractional). */
export function formatTemperature(value: number): string {
    return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

/** Renders a wind speed to at most one decimal place. */
export function formatWindSpeed(value: number): string {
    if (!Number.isFinite(value)) {
        return "—";
    }
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Capitalizes the first letter of the provider's lowercase condition text. */
export function capitalizeCondition(text: string): string {
    const trimmed = text.trim();
    if (trimmed === "") {
        return "";
    }
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** The place line: "Portland, US", or just the name when no country is known. */
export function placeLabel(location: WeatherNow["location"]): string {
    return location.country
        ? `${location.name}, ${location.country}`
        : location.name;
}
