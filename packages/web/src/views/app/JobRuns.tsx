/**
 * A job's attempts, as a disclosure on the row (#90 phases 7d, 8f).
 *
 * The notification says what arrived; this says what happened. For a tool job it
 * is the result text ("living room light: on"); for a prompt job it is the reply
 * the model composed; for a failure it is the reason, which is the one thing the
 * record itself cannot show — a failed job's notification carries the error, but
 * the *history* of attempts belongs to the job.
 *
 * Since phase 8f it hangs off the **job row** as well as a notification record,
 * and that is what makes a gated job legible: a firing a gate declined announces
 * nothing at all, so its `skipped` run row (with what the check read) is the only
 * place it exists. It is also the first time a timer's own history is reachable.
 *
 * Two things about it are deliberate:
 *
 * - **The fetch waits for the open.** A `<details>` renders its children whether
 *   or not it is open, so a hook mounted straight into one would fire a
 *   `GET /api/jobs/{id}` per row on every visit to the page — for rows nobody
 *   asked about. The disclosure mounts the reader on the first `toggle` that
 *   opens it and keeps it mounted afterwards, so reopening does not re-read.
 * - **A missing job is not an error.** The schema nulls a record's `job_id` when
 *   its job is pruned, so a fresh list simply offers no disclosure — but a list
 *   read before the prune holds an id that now answers 404, which is the normal
 *   end of a record's life rather than a fault. It is said plainly.
 *
 * Output is not truncated in the DOM — the job's run cap already bounds it at
 * 2,000 characters — but it is styled as a scrollable block, because a model's
 * reply is not a row's worth of text.
 *
 * Since 9b an empty list is a *normal* answer as well as an absence: a plain
 * recurring reminder keeps no per-firing rows at all, because each would be the
 * same sentence. The disclosure then reports the count the job row carries
 * (`emptyRunsNote`) rather than claiming nothing was recorded.
 */
import { useState } from "react";
import { describeRun, emptyRunsNote } from "../../jobs";
import { useJobRuns } from "../../hooks/useJobRuns";

/** Props for {@link JobRuns} — and for the reader it mounts. */
export interface JobRunsProps {
    /** The device credential (the read is the caller's own jobs). */
    token: string;
    /** The job the record came from. */
    jobId: string;
    /**
     * How many times the job has fired, when the caller has the job in hand
     * (#90 phase 9b). It is what the disclosure says instead of a list for a job
     * that keeps none — see `emptyRunsNote`.
     */
    attempts?: number;
}

/**
 * The disclosure a recorded row offers when it knows which job it came from.
 *
 * @param props - See {@link JobRunsProps}.
 */
export function JobRuns({ token, jobId, attempts }: JobRunsProps) {
    /** Whether the reader has been mounted (the first open; see the module doc). */
    const [asked, setAsked] = useState(false);
    return (
        <details
            className="job-runs"
            onToggle={(event) => {
                if (event.currentTarget.open) {
                    setAsked(true);
                }
            }}
        >
            <summary>Runs</summary>
            {asked && <Runs token={token} jobId={jobId} attempts={attempts} />}
        </details>
    );
}

/**
 * One job's attempts, newest first, each numbered from the job's own beginning.
 *
 * The number is counted back from the end because that is the order the server
 * sends them in (newest first) and "attempt 1" has to mean the first one.
 */
function Runs({ token, jobId, attempts }: JobRunsProps) {
    const state = useJobRuns({ token, jobId });

    if (state.status === "loading") {
        return <p className="job-runs-note">Reading…</p>;
    }
    if (state.status === "gone") {
        return (
            <p className="job-runs-note">
                The job is gone. Retention keeps only the newest jobs, so a
                record can outlive the one it came from.
            </p>
        );
    }
    if (state.status === "error") {
        return (
            <p className="page-error" role="alert">
                {state.error}
            </p>
        );
    }
    if (state.runs.length === 0) {
        return <p className="job-runs-note">{emptyRunsNote(attempts)}</p>;
    }
    return (
        <ol className="job-runs-list">
            {state.runs.map((run, index) => {
                const line = describeRun(run);
                return (
                    <li key={run.id}>
                        <span className="job-runs-head">
                            attempt {state.runs.length - index} ·{" "}
                            {line.headline}
                        </span>
                        {run.output !== undefined && (
                            <pre className="job-runs-output">{run.output}</pre>
                        )}
                        {run.error !== undefined && (
                            <p className="job-runs-error">{run.error}</p>
                        )}
                        {/* What the gate read, on a firing it declined and on one
                            it let through: the first is the reason nothing
                            happened, the second is the baseline the next firing
                            compares against. */}
                        {line.check !== null && (
                            <p className="job-runs-gate">{line.check}</p>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}
