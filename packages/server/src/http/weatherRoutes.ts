/**
 * REST surface for the dashboard's weather widget (#186).
 *
 * `GET /api/weather?lat=…&lon=…` answers the current conditions for the
 * device-reported coordinates. It is the browser-facing half of the same
 * OpenWeather client the `getWeather` tool uses (#31): the widget cannot hold
 * the provider key, so the server makes the call and returns a small,
 * normalized shape the page can render.
 *
 * Auth mirrors the management API exactly: `requireAuth` (device token *or*
 * cookie session). There is no request body and no state change, so cookie
 * callers need no CSRF nonce.
 *
 * The call is metered through the same per-user quota as the tool, checked
 * before any provider fetch. A rate-limited widget degrades to a 429 with the
 * usual retry wait rather than spending the account's OpenWeather budget.
 * Provider failures are a generic 502: the UI gets "temporarily unavailable",
 * never the provider's internals or the key. A deployment without
 * `OPENWEATHER_API_KEY` still has the route (so the widget can say why), and
 * answers 503.
 */
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { createCookieSessionProvider } from "@lukestanbery/jarvis-auth";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { authed, requireAuth } from "./middleware";
import { sessionCookieName } from "./cookies";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import type { QuotaAdmission } from "../rate/fixedWindowQuota";
import {
    WeatherError,
    type CurrentConditions,
    type WeatherProvider,
    type WeatherUnits,
} from "../llm/tools/weather/types";

/** The weather dependencies the REST route reads; the agent's tool deps are structurally compatible. */
export interface WeatherRouteDeps {
    /** The configured OpenWeather provider. */
    readonly provider: WeatherProvider;
    /** Per-user metered-call budget, shared with the `getWeather` tool. */
    readonly quota: { tryAcquire(key: number): QuotaAdmission };
    /** Unit system the provider was configured with. */
    readonly units: WeatherUnits;
}

/** The location name in a weather response. */
export interface WeatherNowLocation {
    /** The provider's resolved place name ("Portland"). */
    name: string;
    /** ISO 3166 country code ("US"), when the provider reports one. */
    country?: string;
}

/**
 * Current conditions as `GET /api/weather` exposes them.
 *
 * Deliberately narrower than the provider's {@link CurrentConditions}: only
 * what the widget renders, with the place nested and the numeric condition
 * code kept for the graphic selection. Everything is normalized at this
 * boundary, so the page never sees a vendor field.
 */
export interface WeatherNowResponse {
    location: WeatherNowLocation;
    /** Current temperature, in `units`. */
    temp: number;
    /** Perceived temperature, in `units`. */
    feelsLike: number;
    /** Human-readable condition ("light rain", "clear sky"). */
    description: string;
    /** Grouped condition ("Rain", "Clouds") for coarse fallback logic. */
    condition: string;
    /** OpenWeather's numeric condition code, when the provider reports one. */
    conditionId?: number;
    /** Wind speed — mph under imperial, m/s under metric. */
    windSpeed: number;
    /** Wind direction in degrees, when reported. */
    windDeg?: number;
    /** Unix (UTC) seconds of the observation. */
    observedAt: number;
    /** The location's UTC offset in seconds, for local display times. */
    timezoneOffsetSeconds: number;
    /** Unix (UTC) seconds of sunrise, when reported. */
    sunrise?: number;
    /** Unix (UTC) seconds of sunset, when reported. */
    sunset?: number;
    /** The unit system used by `temp`, `feelsLike` and `windSpeed`. */
    units: WeatherUnits;
}

/**
 * Maps the provider's normalized conditions onto the wire shape.
 *
 * Pure and exported for tests. The provider normally supplies every required
 * number, but a partial vendor payload must not produce `null`s (JSON turns
 * `NaN` into `null`) that the contract then rejects: the observation time and
 * offset fall back to "now"/UTC, `feelsLike` falls back to the current
 * temperature, and optional fields are simply absent.
 *
 * @param conditions - The provider's normalized current conditions.
 * @param units - The configured unit system.
 */
export function toWeatherNow(
    conditions: CurrentConditions,
    units: WeatherUnits,
): WeatherNowResponse {
    const observedAt = Number.isFinite(conditions.observedAt)
        ? Math.round(conditions.observedAt)
        : Math.floor(Date.now() / 1_000);
    const timezoneOffsetSeconds = Number.isFinite(
        conditions.timezoneOffsetSeconds,
    )
        ? Math.round(conditions.timezoneOffsetSeconds)
        : 0;
    return {
        location: {
            name: conditions.name,
            ...(conditions.country !== undefined && conditions.country !== ""
                ? { country: conditions.country }
                : {}),
        },
        temp: conditions.temp,
        feelsLike: Number.isFinite(conditions.feelsLike)
            ? conditions.feelsLike
            : conditions.temp,
        description: conditions.description,
        condition: conditions.condition,
        ...(conditions.conditionId !== undefined &&
        Number.isFinite(conditions.conditionId)
            ? { conditionId: Math.round(conditions.conditionId) }
            : {}),
        windSpeed: conditions.windSpeed,
        ...(conditions.windDeg !== undefined &&
        Number.isFinite(conditions.windDeg)
            ? { windDeg: conditions.windDeg }
            : {}),
        observedAt,
        timezoneOffsetSeconds,
        ...(conditions.sunrise !== undefined &&
        Number.isFinite(conditions.sunrise)
            ? { sunrise: Math.round(conditions.sunrise) }
            : {}),
        ...(conditions.sunset !== undefined &&
        Number.isFinite(conditions.sunset)
            ? { sunset: Math.round(conditions.sunset) }
            : {}),
        units,
    };
}

/**
 * Reads one required coordinate query value.
 *
 * Returns `null` for anything that is not a finite number within
 * `[-limit, limit]`; an empty string is rejected rather than coerced to zero
 * (the classic `Number("")` trap). The contract validator catches most of
 * this first; the route repeats it so behavior is the same with the validator
 * absent (unit tests, an embedder).
 */
function parseCoordinate(value: unknown, limit: number): number | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string" && typeof raw !== "number") {
        return null;
    }
    if (typeof raw === "string" && raw.trim() === "") {
        return null;
    }
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

/**
 * Builds the weather router.
 *
 * @param store - The auth database, for `requireAuth`.
 * @param appConfig - Supplies the session TTL and TLS mode.
 * @param weather - The configured provider/quota/units, or `undefined` when
 *   no OpenWeather key is configured (then every request answers 503).
 */
export function createWeatherRouter(
    store: AppDatabase,
    appConfig: AppConfig,
    weather?: WeatherRouteDeps,
): Router {
    const router = Router();
    const secure = Boolean(appConfig.tlsCertPath && appConfig.tlsKeyPath);
    const authenticated = requireAuth(store, {
        provider: createCookieSessionProvider(store, {
            ttlMs: appConfig.sessionTtlMs,
        }),
        cookieName: sessionCookieName(secure),
    });

    /** The uniform outermost try/catch, as in the other feature routers. */
    const route =
        (
            handler: (req: Request, res: Response) => Promise<void> | void,
        ): RequestHandler =>
        (req, res) => {
            void Promise.resolve()
                .then(() => handler(req, res))
                .catch((err: unknown) => {
                    logger.error(
                        `weather route failed: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                    if (!res.headersSent) {
                        res.status(500).json({
                            error: "internal server error",
                        });
                    }
                });
        };

    router.get(
        "/weather",
        authenticated,
        route(async (req, res) => {
            res.set("cache-control", "no-store");
            if (!weather) {
                res.status(503).json({
                    error: "weather is not configured on this server",
                });
                return;
            }
            const lat = parseCoordinate(req.query.lat, 90);
            const lon = parseCoordinate(req.query.lon, 180);
            if (lat === null || lon === null) {
                res.status(400).json({
                    error: "lat and lon must be numbers within their ranges",
                });
                return;
            }
            const admission = weather.quota.tryAcquire(
                authed(req).jarv.user.id,
            );
            if (!admission.ok) {
                const retryAfter = Math.max(
                    1,
                    Math.ceil(admission.retryAfterMs / 1_000),
                );
                res.set("retry-after", String(retryAfter));
                res.status(429).json({
                    error: "weather is rate limited — try again shortly",
                });
                return;
            }
            try {
                const conditions = await weather.provider.current({
                    lat,
                    lon,
                });
                res.status(200).json(toWeatherNow(conditions, weather.units));
            } catch (err) {
                // The provider's message can contain a URL/reason; it belongs
                // in the server log, never in a browser response.
                logger.warn(
                    `weather lookup failed — ${
                        err instanceof WeatherError
                            ? err.message
                            : "unexpected error"
                    }`,
                );
                res.status(502).json({
                    error: "weather is temporarily unavailable",
                });
            }
        }),
    );

    return router;
}
