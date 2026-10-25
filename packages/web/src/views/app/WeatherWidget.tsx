/**
 * The dashboard's weather widget (#186).
 *
 * It consumes the app shell's location share rather than asking the browser
 * again: one permission prompt belongs to the app, and the fix it already sent
 * over `/ws` is the same one the `getWeather` tool uses. The widget's job is to
 * turn the three failure modes into different sentences — permission not
 * granted (offer the prompt), permission granted but no fix (an error), and a
 * provider failure (a retry) — and to draw the reading when there is one.
 *
 * Graphics are Lucide SVGs, never emoji: day/night and condition come from the
 * pure helpers in `src/weather.ts`, so the choice is testable without a DOM.
 */
import type { ReactNode } from "react";
import {
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudMoon,
    CloudRain,
    CloudSnow,
    CloudSun,
    Cloudy,
    MapPin,
    Moon,
    Sun,
    Wind,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { WeatherNow } from "../../api";
import type { UseLocationSharingResult } from "../../hooks/useLocationSharing";
import { useWeather } from "../../hooks/useWeather";
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
    type WeatherGlyphKind,
} from "../../weather";

/** Props for {@link WeatherWidget}. */
export interface WeatherWidgetProps {
    /** The device credential, for the weather read. */
    token: string;
    /** The shell's location share (position, state, and the retry action). */
    location: UseLocationSharingResult;
}

/** The icon for each condition graphic. */
const GLYPHS: Record<WeatherGlyphKind, LucideIcon> = {
    "clear-day": Sun,
    "clear-night": Moon,
    "partly-day": CloudSun,
    "partly-night": CloudMoon,
    cloudy: Cloudy,
    rain: CloudRain,
    drizzle: CloudDrizzle,
    snow: CloudSnow,
    thunder: CloudLightning,
    fog: CloudFog,
    wind: Wind,
};

/**
 * The dashboard weather card.
 *
 * @param props - See {@link WeatherWidgetProps}.
 */
export function WeatherWidget({ token, location }: WeatherWidgetProps) {
    const weather = useWeather({ token, position: location.position });
    return (
        <section
            className="dashboard-card weather-card"
            aria-labelledby="dashboard-weather-title"
        >
            <div className="weather-head">
                <h2 id="dashboard-weather-title">Weather</h2>
                {weather.data !== null && (
                    <p className="weather-place">
                        <MapPin size={13} aria-hidden="true" />
                        {placeLabel(weather.data.location)}
                    </p>
                )}
            </div>
            {bodyFor(location, weather)}
        </section>
    );
}

/**
 * Chooses the card's body.
 *
 * The location state is checked before the weather fetch state: a page that
 * has not been allowed a location must say that, not "no reading yet". The
 * provider error is only the story once a fix exists to look up.
 */
function bodyFor(
    location: UseLocationSharingResult,
    weather: ReturnType<typeof useWeather>,
): ReactNode {
    switch (location.locationState) {
        case "off":
            return (
                <WeatherPrompt
                    action="Share location"
                    message="Share your location to see the weather here."
                    onAction={location.shareLocation}
                />
            );
        case "unsupported":
            return (
                <p className="weather-note" role="status">
                    Location isn’t available in this browser — weather needs
                    HTTPS or localhost.
                </p>
            );
        case "locating":
            return (
                <p className="weather-note" role="status">
                    Waiting for your location…
                </p>
            );
        case "denied":
            return (
                <WeatherPrompt
                    action="Try again"
                    message="Location access is blocked. Allow location for this site, then try again."
                    onAction={location.shareLocation}
                />
            );
        case "failed":
            return (
                <WeatherPrompt
                    action="Try again"
                    message="We couldn’t determine your location."
                    onAction={location.shareLocation}
                    error
                />
            );
        case "active":
            break;
    }
    if (location.position === null) {
        return (
            <WeatherPrompt
                action="Try again"
                message="Your location was shared, but no coordinates arrived."
                onAction={location.shareLocation}
                error
            />
        );
    }
    if (weather.data === null) {
        if (weather.error !== null) {
            return (
                <WeatherPrompt
                    action="Try again"
                    message={weather.error}
                    onAction={weather.refresh}
                    error
                />
            );
        }
        return (
            <p className="weather-note" role="status">
                Fetching the latest conditions…
            </p>
        );
    }
    return (
        <>
            <WeatherReading data={weather.data} />
            {weather.error !== null && (
                <p className="weather-note" role="status">
                    Couldn’t refresh — showing the last reading.
                </p>
            )}
        </>
    );
}

/** A short location or provider message with one action. */
function WeatherPrompt({
    message,
    action,
    onAction,
    error = false,
}: {
    message: string;
    action: string;
    onAction(): void;
    error?: boolean;
}) {
    return (
        <div className="weather-prompt">
            <p
                className={error ? "weather-error" : "weather-note"}
                role={error ? "alert" : "status"}
            >
                {message}
            </p>
            <button type="button" className="weather-action" onClick={onAction}>
                {action}
            </button>
        </div>
    );
}

/** One successful reading: graphic, temperature, condition and wind. */
function WeatherReading({ data }: { data: WeatherNow }) {
    const day = isDaytime(data);
    const kind = weatherGlyph(data, day);
    const Glyph = GLYPHS[kind];
    const degrees = temperatureUnit(data.units);
    const direction = compassDirection(data.windDeg);
    const wind = `${formatWindSpeed(data.windSpeed)} ${windUnit(data.units)}${direction === null ? "" : ` ${direction}`}`;
    return (
        <div className="weather-body">
            <div className="weather-primary">
                <div className="weather-main">
                    <Glyph
                        className={`weather-glyph weather-glyph-${kind}`}
                        size={58}
                        strokeWidth={1.4}
                        aria-hidden="true"
                    />
                    <p className="weather-temp">
                        {formatTemperature(data.temp)}
                        <span className="weather-unit">{degrees}</span>
                    </p>
                </div>
                <p className="weather-condition">
                    {capitalizeCondition(data.description)}
                </p>
            </div>
            <div className="weather-details">
                <p className="weather-feels">
                    Feels like {formatTemperature(data.feelsLike)}
                    {degrees}
                </p>
                <p className="weather-wind">
                    <Wind size={14} aria-hidden="true" />
                    <span>Wind {wind}</span>
                </p>
            </div>
        </div>
    );
}
