/**
 * The caller's scheduled jobs, for the dashboard and the pages (#90 phases 6b,
 * 7).
 *
 * One list for the whole app, because several surfaces read the same thing: the
 * dashboard's "coming up", the Timers and Reminders lists, the notifications
 * page's scheduled section, and the history each page shows. It lives with the
 * shell for the same reason the socket does — navigating between pages must not
 * throw it away and start a fetch again.
 *
 * **One read, two halves.** The server's list has an `includeSettled` switch and
 * no way to ask for settled rows *alone* (its page is newest-created first, so a
 * settled-only read would come back as pending rows and then filter to nothing),
 * and retention caps a user's jobs at ~50 rows in total — so one read at the
 * server's maximum carries everything and `splitJobs` divides it. That is what
 * gives a page its history without a second request, and it is why the hook
 * holds one `rows` array and publishes two lists.
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { splitJobs } from "../jobs";
import type { Job, JobCreateRequest, JobSaved, JobUpdateRequest } from "../api";

/** How often a visible tab re-reads the list. */
export const JOBS_POLL_MS = 30_000;

/**
 * How many rows one read asks for (#90 phase 7).
 *
 * The read carries settled rows too (see the module doc), and this is the
 * server's own maximum page — a user's table is capped well below it by
 * retention, so this is "everything" rather than a page to walk.
 */
export const JOBS_READ_LIMIT = 200;

/**
 * What a create or an edit answered (#90 phase 7).
 *
 * A value rather than a throw, like `cancel` and `snooze`, because a form has
 * something to do either way — and richer than they are, because a form needs
 * the quiet-hours forecast the server computed and the refusal's own words.
 */
export type JobSaveResult =
    ({ ok: true } & JobSaved) | { ok: false; error: string };

/** What {@link useJobs} exposes. */
export interface JobsState {
    /**
     * The work still owed (`pending` and `running`), as last read — newest-created
     * first, as the server sends it.
     */
    jobs: Job[];
    /** The rows that have settled, for a page's history (#90 phase 7). */
    settled: Job[];
    /** Whether a read is in flight (the list can render empty meanwhile). */
    loading: boolean;
    /** Whether the first read has come back (see the dashboard's "Loading…"). */
    loaded: boolean;
    /** Why the last read or write failed, if it did. */
    error: string | null;
    /** Re-reads the list now (the visibility change, a `jobId` frame). */
    refresh(): void;
    /**
     * Cancels one job and re-reads the list (#90 phase 6c).
     *
     * @returns True when it landed; false when the server refused, with `error`
     *   set — a value rather than a throw, because every caller has something to
     *   do either way and an unhandled rejection is not a UI.
     */
    cancel(id: string): Promise<boolean>;
    /**
     * Snoozes one reminder and re-reads the list (#90 phase 6c).
     *
     * The same request settles the notification that announced it, server-side
     * (the deferral *is* the acknowledgement), so a caller that has the row to
     * hand should settle it locally once this resolves true.
     *
     * @param minutes - How long from now. The short end is the server's
     *   (`MIN_SNOOZE_MINUTES`); the presets the UI offers are `SNOOZE_PRESETS`.
     */
    snooze(id: string, minutes: number): Promise<boolean>;
    /**
     * Creates a job from a page (#90 phase 7).
     *
     * @param input - The label, class, detail and moment. A page-created job is
     *   always a `message` job; the server's creation policy owns every bound.
     * @returns The stored job and its quiet-hours forecast, or the server's
     *   refusal in its own words.
     */
    create(input: JobCreateRequest): Promise<JobSaveResult>;
    /**
     * Edits a pending job's label, detail or moment (#90 phase 7).
     *
     * @param id - The job to edit. A settled or running job is refused (409).
     * @param patch - At least one field; `class` and `kind` are not editable.
     * @returns The job as it now stands and its forecast, or the refusal.
     */
    update(id: string, patch: JobUpdateRequest): Promise<JobSaveResult>;
}

/**
 * Owns the caller's job list.
 *
 * @param options.token - The device credential the REST call authenticates with.
 * @returns The two lists, their read state, `refresh`, the two actions, and the
 *   two writes.
 */
export function useJobs(options: { token: string }): JobsState {
    const { token } = options;
    const [rows, setRows] = useState<Job[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(() => {
        setLoading(true);
        api.listJobs(token, {
            limit: JOBS_READ_LIMIT,
            includeSettled: true,
        })
            .then((page) => {
                setRows(page.jobs);
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

    // One read, two lists: what is owed and what is history (see the module doc).
    const { owed, settled } = useMemo(() => splitJobs(rows), [rows]);

    /**
     * Runs one mutation, re-reads the list, and reports rather than throws.
     *
     * Both list actions need exactly this: the write, the re-read (the list is
     * the server's answer, not the client's guess — a snooze of a settled
     * reminder creates a *new* job, so patching locally would be inventing an
     * id), and a value the caller can branch on.
     */
    const mutate = useCallback(
        async (call: () => Promise<unknown>): Promise<boolean> => {
            try {
                await call();
                setError(null);
                refresh();
                return true;
            } catch (err: unknown) {
                // A 401 means the credential is dead: the app is about to drop
                // to login, so a jobs error would be noise.
                if (err instanceof ApiError && err.status === 401) {
                    return false;
                }
                setError(
                    err instanceof Error ? err.message : "the request failed",
                );
                return false;
            }
        },
        [refresh],
    );

    /**
     * Runs one create or edit, re-reads the list, and hands back the answer.
     *
     * Deliberately not `mutate` with a richer return: a write a *form* made
     * reports its failure in the form, which is still open and still holding what
     * the user typed — a message behind the dialog would be invisible. So this
     * leaves the page-level `error` alone (it is the read's and the list
     * actions') and always answers with words, including a 401, whose only
     * observer is the form about to be unmounted by the login gate.
     */
    const save = useCallback(
        async (call: () => Promise<JobSaved>): Promise<JobSaveResult> => {
            try {
                const saved = await call();
                setError(null);
                refresh();
                return { ok: true, ...saved };
            } catch (err: unknown) {
                return {
                    ok: false,
                    error:
                        err instanceof Error
                            ? err.message
                            : "the request failed",
                };
            }
        },
        [refresh],
    );

    const cancel = useCallback(
        (id: string) => mutate(() => api.cancelJob(token, id)),
        [mutate, token],
    );

    const snooze = useCallback(
        (id: string, minutes: number) =>
            mutate(() => api.snoozeJob(token, id, minutes)),
        [mutate, token],
    );

    const create = useCallback(
        (input: JobCreateRequest) => save(() => api.createJob(token, input)),
        [save, token],
    );

    const update = useCallback(
        (id: string, patch: JobUpdateRequest) =>
            save(() => api.updateJob(token, id, patch)),
        [save, token],
    );

    return {
        jobs: owed,
        settled,
        loading,
        loaded,
        error,
        refresh,
        cancel,
        snooze,
        create,
        update,
    };
}
