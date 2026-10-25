/**
 * Rendered tests for the dashboard weather widget (#186).
 *
 * The suite renders to static markup, so the point is the branch that chooses
 * the sentence — permission prompt, locating, denied, failed, provider error,
 * or a reading — and the shape of that reading. The condition/day-night choices
 * themselves are unit-tested in `src/weather.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WeatherNow } from "../../api";
import type { UseLocationSharingResult } from "../../hooks/useLocationSharing";
import type { GeoPosition } from "../../location";
import { useWeather } from "../../hooks/useWeather";
import { WeatherWidget } from "./WeatherWidget";

vi.mock("../../hooks/useWeather", () => ({
    useWeather: vi.fn(),
}));

const weatherHook = vi.mocked(useWeather);

const POSITION: GeoPosition = { lat: 45.52, lon: -122.68 };

const READING: WeatherNow = {
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
};

/** The shell's location share, off by default. */
function locationState(
    overrides: Partial<UseLocationSharingResult> = {},
): UseLocationSharingResult {
    return {
        locationOn: false,
        locationState: "off",
        position: null,
        toggleLocation: () => undefined,
        shareLocation: () => undefined,
        ...overrides,
    };
}

/** A weather hook answer with no reading unless overridden. */
function hookState(
    overrides: Partial<ReturnType<typeof useWeather>> = {},
): ReturnType<typeof useWeather> {
    return {
        data: null,
        loading: false,
        error: null,
        refresh: () => undefined,
        ...overrides,
    };
}

/** Renders the widget with one location state and one hook answer. */
function renderWidget(
    location: UseLocationSharingResult,
    hook: ReturnType<typeof useWeather> = hookState(),
): string {
    weatherHook.mockReturnValue(hook);
    return renderToStaticMarkup(
        createElement(WeatherWidget, { token: "device-token", location }),
    );
}

beforeEach(() => {
    weatherHook.mockReset();
    weatherHook.mockReturnValue(hookState());
});

describe("the weather widget's location branches", () => {
    it("prompts an opted-out browser to share", () => {
        const html = renderWidget(locationState());
        expect(html).toContain("Weather");
        expect(html).toContain("Share your location");
        expect(html).toContain("Share location");
    });

    it("says access is blocked, not that weather failed", () => {
        const html = renderWidget(locationState({ locationState: "denied" }));
        expect(html).toContain("Location access is blocked");
        expect(html).toContain("Try again");
        expect(html).toContain('role="status"');
    });

    it("shows an error when permission is granted but no fix arrives", () => {
        const html = renderWidget(
            locationState({
                locationOn: true,
                locationState: "failed",
            }),
        );
        expect(html).toContain("couldn’t determine your location");
        expect(html).toContain("Try again");
        expect(html).toContain('role="alert"');
    });

    it("waits quietly while the browser is locating", () => {
        const html = renderWidget(
            locationState({ locationOn: true, locationState: "locating" }),
        );
        expect(html).toContain("Waiting for your location");
        expect(html).not.toContain("Share location");
    });

    it("names an unsupported browser instead of offering a dead button", () => {
        const html = renderWidget(
            locationState({
                locationOn: true,
                locationState: "unsupported",
            }),
        );
        expect(html).toContain("isn’t available in this browser");
        expect(html).not.toContain("Try again");
    });

    it("reports a shared location that produced no coordinates", () => {
        const html = renderWidget(
            locationState({ locationOn: true, locationState: "active" }),
        );
        expect(html).toContain("no coordinates arrived");
        expect(html).toContain("Try again");
    });

    it("waits for the first reading once a fix exists", () => {
        const html = renderWidget(
            locationState({
                locationOn: true,
                locationState: "active",
                position: POSITION,
            }),
        );
        expect(html).toContain("Fetching the latest conditions");
    });

    it("offers a retry when the provider failed", () => {
        const html = renderWidget(
            locationState({
                locationOn: true,
                locationState: "active",
                position: POSITION,
            }),
            hookState({ error: "weather is temporarily unavailable" }),
        );
        expect(html).toContain("weather is temporarily unavailable");
        expect(html).toContain("Try again");
        expect(html).toContain('role="alert"');
    });
});

describe("the weather widget's reading", () => {
    it("leads with the temperature and names the conditions and wind", () => {
        const html = renderWidget(
            locationState({
                locationOn: true,
                locationState: "active",
                position: POSITION,
            }),
            hookState({ data: READING }),
        );

        expect(html).toContain("Portland, US");
        expect(html).toContain("weather-glyph-rain");
        expect(html).toContain("63");
        expect(html).toContain("°F");
        expect(html).toContain("Feels like 61°F");
        expect(html).toContain("Light rain");
        expect(html).toContain("Wind 8 mph S");
        // The graphic is an SVG, never an emoji.
        expect(html).toContain("<svg");

        // The place is in the card's head (top right), and the secondary facts
        // sit beside the temperature/condition rather than under them.
        const head = html.indexOf("weather-head");
        const place = html.indexOf("weather-place");
        const body = html.indexOf("weather-body");
        const primary = html.indexOf("weather-primary");
        const details = html.indexOf("weather-details");
        const condition = html.indexOf("weather-condition");
        const feels = html.indexOf("weather-feels");
        const wind = html.indexOf("weather-wind");
        expect(head).toBeGreaterThanOrEqual(0);
        expect(place).toBeGreaterThan(head);
        expect(place).toBeLessThan(body);
        expect(primary).toBeGreaterThan(body);
        expect(condition).toBeGreaterThan(primary);
        expect(details).toBeGreaterThan(condition);
        expect(details).toBeGreaterThan(primary);
        expect(feels).toBeGreaterThan(details);
        expect(wind).toBeGreaterThan(feels);
    });
});
