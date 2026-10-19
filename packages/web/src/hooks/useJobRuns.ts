/**
 * One job's attempts, read when a record asks for them (#90 phase 7d).
 *
 * A record's `jobId` is a link to the job that produced it, and the job's runs
 * are where the answer to "what did it actually do?" lives — the tool's result
 * text, or why the attempt failed. The read happens on demand rather than with
 * the list, because a page of notifications is mostly history nobody opens and
 * this endpoint is one request per row.
 *
 * The three ways it can end are deliberately distinct. `loaded` has the runs.
 * `gone` is a 404. The schema nulls a record's `job_id` when its job is deleted,
 * so a *current* list cannot point at a pruned job — but a list read before the
 * prune keeps the id for as long as the page stays open, and retention prunes
 * settled jobs on its own schedule. A stale link is the normal way for this read
 * to come back empty, and "the job is gone" is the honest half of that truth
 * rather than an error to apologise for. `error` is anything else — including a
 * 401, which the app answers by dropping to login, so there is nothing useful to
 * add here.
 *
 * Mount it only once someone has asked to see the runs. A `<details>` renders
 * its children whether or not it is open, so putting this hook inside one
 * directly would fire a request per record on every visit to the page.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { JobRun } from "../api";

/** What {@link useJobRuns} exposes. */
export type JobRunsState =
    | { status: "loading" }
    | { status: "loaded"; runs: JobRun[] }
    | { status: "gone" }
    | { status: "error"; error: string };

/** Options for {@link useJobRuns}. */
export interface UseJobRunsOptions {
    /** The device credential the REST call authenticates with. */
    token: string;
    /** The job whose attempts to read. */
    jobId: string;
}

/**
 * Reads one job's attempts on mount.
 *
 * @param options - See {@link UseJobRunsOptions}.
 * @returns The read's state (see {@link JobRunsState}).
 */
export function useJobRuns({ token, jobId }: UseJobRunsOptions): JobRunsState {
    const [state, setState] = useState<JobRunsState>({ status: "loading" });

    useEffect(() => {
        // A read that lands after unmount (or after the row's job changed) must
        // not set state: the row it belonged to is gone.
        let live = true;
        setState({ status: "loading" });
        api.getJob(token, jobId)
            .then((detail) => {
                if (live) {
                    setState({ status: "loaded", runs: detail.runs });
                }
            })
            .catch((cause: unknown) => {
                if (!live) {
                    return;
                }
                if (cause instanceof ApiError && cause.status === 404) {
                    setState({ status: "gone" });
                    return;
                }
                setState({
                    status: "error",
                    error:
                        cause instanceof Error
                            ? cause.message
                            : "Could not read the runs.",
                });
            });
        return () => {
            live = false;
        };
    }, [token, jobId]);

    return state;
}
