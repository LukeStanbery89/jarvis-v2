/**
 * Shared job card (#156). Replaces JobRow body and dashboard item.
 */
import type { ReactNode } from "react";
import { presentJob } from "../../../presentation";
import type { Job } from "../../../api";
import { ClassChip } from "./ClassChip";
import { Countdown } from "./Countdown";
import { gateText } from "../../../jobs";

export interface JobCardProps {
    job: Job;
    now: Date;
    variant?: "normal" | "compact";
    showKind?: boolean;
    actions?: ReactNode | null;
    onClick?: () => void;
    className?: string;
}

export function JobCard({
    job,
    now,
    variant = "normal",
    showKind = variant === "compact",
    actions = null,
    onClick,
    className = "",
}: JobCardProps) {
    const presented = presentJob(job, now);
    const isCompact = variant === "compact";
    const gate = gateText(job);

    return (
        <li
            className={`job-card job-card-${job.class} job-card-${variant} ${className}`.trim()}
            onClick={onClick}
            role={onClick ? "button" : undefined}
        >
            <div className="job-card-main">
                <div className="job-card-header">
                    {showKind && <ClassChip kind={presented.kind} />}
                    {job.class === "timer" ? (
                        <Countdown
                            runAt={job.runAt}
                            state={job.state}
                            className="job-card-primary"
                        />
                    ) : (
                        <span className="job-card-primary">
                            {presented.primary}
                        </span>
                    )}
                </div>
                <div className="job-card-title">{presented.title}</div>
                {presented.details.length > 0 && (
                    <div className="job-card-details">
                        {presented.details.map((d, i) => (
                            <div key={i} className="job-card-detail">
                                {d}
                            </div>
                        ))}
                    </div>
                )}
                {gate !== null && (
                    <span
                        className="job-gate"
                        title={
                            job.gate
                                ? `only runs when ${job.gate.tool} changes`
                                : undefined
                        }
                    >
                        {gate}
                    </span>
                )}
            </div>
            {!isCompact && actions !== undefined && (
                <div className="job-card-actions">{actions}</div>
            )}
        </li>
    );
}
