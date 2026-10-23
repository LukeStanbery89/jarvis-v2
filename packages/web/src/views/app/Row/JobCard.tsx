/**
 * The one job row (#156), shared by every surface that lists a job: the Timers
 * and Reminders pages, the Notifications page's scheduled half, and the
 * dashboard's "Coming up".
 *
 * It renders {@link presentJob}'s parts, so the three classes read through one
 * hierarchy — the class's primary fact (a timer's time remaining, a reminder's
 * moment) is the loudest line, the label is the title under it, and the body,
 * cadence and gate are details. It does **not** invent styling: it emits the
 * class names the app already styles (`.job-item .job-text .job-head …`), so a
 * row is a pane on the list pages and the dashboard's compact line keeps the
 * dashboard's own classes.
 *
 * The **gate** is rendered here rather than taken from `presentJob`'s details
 * because it carries a `title` that names the tool being checked — hover
 * information a plain string list cannot hold. The **runs** disclosure is a
 * slot (`runs`) so the caller owns the credential it reads through.
 */
import type { ReactNode } from "react";
import { gateText } from "../../../jobs";
import { Markdown } from "../../../Markdown";
import { presentJob } from "../../../presentation";
import type { Job } from "../../../api";
import { ClassChip } from "./ClassChip";
import { Countdown } from "./Countdown";

/** Props for {@link JobCard}. */
export interface JobCardProps {
    /** The job to render. */
    job: Job;
    /** The clock the moment is compared against (injected, for the tests). */
    now: Date;
    /**
     * `"compact"` is the dashboard's one-line row; `"normal"` is the list
     * page's pane with room for the body, the cadence and the actions.
     */
    variant?: "normal" | "compact";
    /** Whether to lead with the class chip. Defaults to on. */
    showKind?: boolean;
    /** The row's actions, in a `⋯` menu (`RowActions`) on the list pages. */
    actions?: ReactNode;
    /** The job's runs disclosure, when the caller has a credential to read it. */
    runs?: ReactNode;
    /** Makes the whole row a button (unused today; kept for callers). */
    onClick?: () => void;
    /** Extra classes for the row. */
    className?: string;
}

/**
 * One job, in the hierarchy its class calls for.
 *
 * @param props - See {@link JobCardProps}.
 */
export function JobCard({
    job,
    now,
    variant = "normal",
    showKind = true,
    actions,
    runs,
    onClick,
    className = "",
}: JobCardProps) {
    const presented = presentJob(job, now);
    const gate = gateText(job);

    if (variant === "compact") {
        return (
            <li className={`dashboard-job ${className}`.trim()}>
                {showKind && (
                    <span
                        className={`dashboard-class dashboard-class-${job.class}`}
                    >
                        {presented.kind}
                    </span>
                )}
                <span className="dashboard-label">{presented.title}</span>
                {presented.countdown ? (
                    <Countdown
                        runAt={job.runAt}
                        state={job.state}
                        className="dashboard-when"
                    />
                ) : (
                    <span className="dashboard-when">{presented.primary}</span>
                )}
            </li>
        );
    }

    return (
        <li
            className={`job-item job-${job.class} ${className}`.trim()}
            onClick={onClick}
            role={onClick !== undefined ? "button" : undefined}
        >
            <div className="job-text">
                <div className="job-head">
                    {showKind && <ClassChip kind={presented.kind} />}
                    {presented.countdown ? (
                        <Countdown
                            runAt={job.runAt}
                            state={job.state}
                            className="job-when job-primary"
                        />
                    ) : (
                        <span className="job-when job-primary">
                            {presented.primary}
                        </span>
                    )}
                </div>
                <strong>{presented.title}</strong>
                {presented.body !== null && (
                    <div className="row-body">
                        <Markdown text={presented.body} />
                    </div>
                )}
                {presented.details.map((detail) => (
                    <span key={detail} className="job-detail">
                        {" "}
                        {detail}
                    </span>
                ))}
                {gate !== null && (
                    <span
                        className="job-gate"
                        title={
                            job.gate !== undefined
                                ? `only runs when ${job.gate.tool} changes`
                                : undefined
                        }
                    >
                        {gate}
                    </span>
                )}
                {runs}
            </div>
            {actions !== undefined && (
                <div className="job-actions">{actions}</div>
            )}
        </li>
    );
}
