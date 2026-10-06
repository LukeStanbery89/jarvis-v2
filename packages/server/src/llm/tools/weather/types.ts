/**
 * Shared contracts for the weather provider (#31).
 *
 * Normalization happens at the provider boundary, mirroring the search
 * providers: the OpenWeather client maps the vendor's JSON onto ONE shape the
 * `getWeather` tool can format for the model, so swapping or adding providers
 * never touches the tool logic. Everything returned from a provider is
 * untrusted external data — shapes are checked defensively, and a malformed
 * response is a typed error, not a crash.
 */

/** What one `getWeather` call asks the provider for. */
export type WeatherScope = "now" | "forecast";

/** How a weather request addresses its location. */
export type WeatherLocation =
    /** A free-text place: "Portland", "Springfield,IL,US", a ZIP. */
    | { query: string }
    /** Device-reported coordinates (the `location` frame's payload). */
    | { lat: number; lon: number };

/** Unit systems the provider is asked for; mirrors `WeatherUnits` in config. */
export type WeatherUnits = "metric" | "imperial";

/** One provider's answer for "conditions right now". */
export interface CurrentConditions {
    /** Which provider produced this (surfaced in tool telemetry). */
    provider: "openweather";
    /** The resolved place name ("Portland" — also returned for lat/lon calls). */
    name: string;
    /** ISO 3166 country code ("US"), when the provider reports one. */
    country?: string;
    /** Current temperature, in the configured unit. */
    temp: number;
    /** Perceived temperature, in the configured unit. */
    feelsLike: number;
    /** Human-readable condition ("light rain", "clear sky"). */
    description: string;
    /** Grouped condition ("Rain", "Snow", "Clouds") for coarse logic. */
    condition: string;
    /** Relative humidity, percent. */
    humidity: number;
    /** Wind speed — mph under imperial, m/s under metric. */
    windSpeed: number;
    /** Wind direction in degrees (meteorological), when reported. */
    windDeg?: number;
    /** Cloud cover, percent, when reported. */
    cloudCover?: number;
    /**
     * Precipitation over the last hour (rain or snow), millimeters, when any
     * is falling. Absent otherwise — the provider omits the field entirely
     * rather than sending zero.
     */
    precipitationMm?: number;
    /** Unix (UTC) seconds of the observation. */
    observedAt: number;
    /** The location's UTC offset in seconds, for local display times. */
    timezoneOffsetSeconds: number;
}

/** One aggregated forecast day (the provider's 3-hour steps, folded). */
export interface ForecastDay {
    /** Local calendar date, "YYYY-MM-DD" in the location's timezone. */
    date: string;
    /** Day-of-week name ("Tuesday") — calendar dates have fixed weekdays. */
    weekday: string;
    /** Lowest temperature across the day's steps, in the configured unit. */
    tempMin: number;
    /** Highest temperature across the day's steps, in the configured unit. */
    tempMax: number;
    /** The day's headline condition — the step closest to local noon. */
    description: string;
    /** Peak precipitation probability across the day's steps, 0–1. */
    precipProbability: number;
}

/** One provider's answer for "the next few days". */
export interface Forecast {
    /** Which provider produced this (surfaced in tool telemetry). */
    provider: "openweather";
    /** The resolved place name. */
    name: string;
    /** ISO 3166 country code, when the provider reports one. */
    country?: string;
    /** One entry per forecast day, in order (at most 5). */
    days: ForecastDay[];
}

/** A configured weather provider the tool can call. */
export interface WeatherProvider {
    /** Human-readable provider name for logs and telemetry. */
    readonly name: "openweather";
    /**
     * Fetches current conditions. Throws `WeatherError` on transport or
     * shape failure — never leaks the API key into a message.
     */
    current(
        location: WeatherLocation,
        signal?: AbortSignal,
    ): Promise<CurrentConditions>;
    /**
     * Fetches the 5-day/3-hour forecast, aggregated to days. Throws
     * `WeatherError` on transport or shape failure — never leaks the key.
     */
    forecast(
        location: WeatherLocation,
        signal?: AbortSignal,
    ): Promise<Forecast>;
}

/** Why a weather call failed; drives the tool's user-facing error text. */
export class WeatherError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WeatherError";
    }
}
