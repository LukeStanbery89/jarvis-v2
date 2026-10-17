/**
 * The caller's scheduled jobs, for the dashboard (#90 phase 6b).
 *
 * One list for the whole app, because three surfaces read the same thing: the
 * dashboard's "coming up" now, and the Timers and Reminders pages next phase.
 * It lives with the shell for the same reason the socket does — navigating
 * between pages must not throw it away and start a fetch again.
 *
 * **Polling is deliberate.** The scheduler has no push channel for state: a
 * notification fires when a job's moment arrives, which is the end of a job, not
 * the state of one. A cheap poll is what makes "4 minutes left" true. Two
 * bounds keep it from being expensive: the poll runs only while the tab is
 * visible (a background tab asking for data nobody is looking at is battery for
 * nothing), and the moment it becomes visible the list is re-read, so the first
 * thing a returning user sees is current rather than up to 30 seconds stale.
 *
 * A job that just ran also changes the list, which the shell signals by calling
 * `refresh` when a notification frame carries a `jobId` — the one moment a state
 * change is already being pushed.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Job } from "../api";

/** How often a visible tab re-reads the list. */
export const JOBS_POLL_MS = 30_000;

/** What {@link useJobs} exposes. */
export interface JobsState {
    /** The work still owed, as last read (newest-created first, as the server sends it). */
    jobs: Job[];
    /** Whether a read is in flight (the list can render empty meanwhile). */
    loading: boolean;
    /** Whether the first read has come back (see the dashboard's "Loading…"). */
    loaded: boolean;
    /** Why the last read failed, if it did. */
    error: string | null;
    /** Re-reads the list now (the visibility change, a `jobId` frame). */
    refresh(): void;
}

/**
 * Owns the caller's job list.
 *
 * @param options.token - The device credential the REST call authenticates with.
 * @returns The list, its read state, and `refresh`.
 */
export function useJobs(options: { token: string }): JobsState {
    const { token } = options;
    const [jobs, setJobs] = useState<Job[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(() => {
        setLoading(true);
        api.listJobs(token)
            .then((page) => {
                setJobs(page.jobs);
                setLoaded(true);
                setError(null);
            })
            .catch((err: unknown) => {
                // A 401 means the credential is dead: the app is about to drop
                // to login, so a jobs error would be noise.
                if (err instanceof ApiError && err.status === 401) {
                    return;
                }
                setError(
                    err instanceof Error
                        ? err.message
                        : "could not load your scheduled jobs",
                );
            })
            .finally(() => setLoading(false));
    }, [token]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    /** The poll, gated by visibility (see the module doc). */
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const stop = (): void => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
        const start = (): void => {
            stop();
            timer = setInterval(refresh, JOBS_POLL_MS);
        };
        const onVisibilityChange = (): void => {
            if (document.visibilityState === "visible") {
                refresh();
                start();
            } else {
                stop();
            }
        };
        if (document.visibilityState === "visible") {
            start();
        }
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            stop();
            document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
        };
    }, [refresh]);

    return { jobs, loading, loaded, error, refresh };
}
