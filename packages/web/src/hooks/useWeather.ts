/**
 * Current weather for the dashboard widget (#186).
 *
 * One read per coordinate fix, then a slow poll while the tab is visible. The
 * location share is the only producer of coordinates; when it has no fix (off,
 * refused, or failed) this hook clears its answer and makes no request, so the
 * widget's permission/error copy is the whole story.
 *
 * The data is deliberately not lifted into the shell: the dashboard is its only
 * reader, and navigating away and back is a fresh read of a value that changes
 * over hours. The poll is visibility-gated for the same reason as the jobs
 * list — a hidden tab has nobody looking at the sky.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type WeatherNow } from "../api";
import type { GeoPosition } from "../location";

/** How often a visible dashboard re-reads the conditions. */
export const WEATHER_REFRESH_MS = 10 * 60 * 1_000;

/** What {@link useWeather} exposes to the widget. */
export interface WeatherState {
    /** The last successful reading, kept while a refresh is in flight. */
    data: WeatherNow | null;
    /** Whether a request is in flight. */
    loading: boolean;
    /** Why the last request failed, if it did. */
    error: string | null;
    /** Reads again now (the error action, visibility, and the poll). */
    refresh(): void;
}

/**
 * Owns the weather reading for one coordinate pair.
 *
 * @param options.token - The device credential the REST call authenticates with.
 * @param options.position - The location share's last fix, or `null`.
 */
export function useWeather(options: {
    token: string;
    position: GeoPosition | null;
}): WeatherState {
    const { token, position } = options;
    const lat = position?.lat ?? null;
    const lon = position?.lon ?? null;
    const [data, setData] = useState<WeatherNow | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Bumped by `refresh`; the read effect watches it. */
    const [generation, setGeneration] = useState(0);
    /** The coordinates the current `data` belongs to. */
    const lastKey = useRef<string | null>(null);

    const refresh = useCallback((): void => {
        setGeneration((current) => current + 1);
    }, []);

    useEffect(() => {
        if (lat === null || lon === null) {
            lastKey.current = null;
            setData(null);
            setError(null);
            setLoading(false);
            return;
        }
        const key = `${lat},${lon}`;
        if (lastKey.current !== key) {
            // A new fix is a new subject: never show the old city's weather
            // under the new place name while the request is in flight.
            lastKey.current = key;
            setData(null);
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.getWeather(token, lat, lon)
            .then((next) => {
                if (cancelled) {
                    return;
                }
                setData(next);
                setError(null);
            })
            .catch((err: unknown) => {
                if (cancelled) {
                    return;
                }
                // A 401 means the credential is dead: the app is about to drop
                // to login, so a widget error would be noise.
                if (err instanceof ApiError && err.status === 401) {
                    return;
                }
                setError(messageFor(err));
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [lat, lon, token, generation]);

    /** The visible-tab poll; becoming visible is also an explicit re-read. */
    useEffect(() => {
        if (lat === null || lon === null) {
            return;
        }
        let timer: ReturnType<typeof setInterval> | null = null;
        const stop = (): void => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
        const start = (): void => {
            stop();
            timer = setInterval(refresh, WEATHER_REFRESH_MS);
        };
        const onVisibilityChange = (): void => {
            if (document.visibilityState === "visible") {
                refresh();
                start();
            } else {
                stop();
            }
        };
        start();
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            stop();
            document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
        };
    }, [lat, lon, refresh]);

    return { data, loading, error, refresh };
}

/** The server's own wording when it sent one, else a plain fallback. */
function messageFor(err: unknown): string {
    return err instanceof Error && err.message.length > 0
        ? err.message
        : "could not load the weather";
}
