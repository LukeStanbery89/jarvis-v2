/**
 * Unified presentation for timers, reminders, and notifications (#156).
 *
 * One pure function per shape, so every surface renders the three classes
 * through the same hierarchy: the class's primary fact is the most prominent
 * element. A timer's time remaining is primary, a reminder's moment is
 * primary, a notification's message is primary.
 */
import type { Job } from "./api";
import type { ClientNotification } from "./notifications";
import { describeRunAt, formatCountdown, jobBody, repeatText } from "./jobs";
import { describeBody, describeNotice } from "./notifications";

/** Structured parts a row/card renders, per class. */
export interface Presented {
    /** The row's eyebrow: its class, and any state worth naming. */
    kind: string;
    /** The one fact the class exists to tell. */
    primary: string;
    /** The thing itself — the user's label or the message's title. */
    title: string;
    /**
     * The message's body, when it says more than the title. Rendered as
     * Markdown (so links survive), never as raw text. A job's own body reads
     * the same way; `null` when the title says it all.
     */
    body: string | null;
    /** Plain lines under the title: a job's cadence, "waiting for your answer". */
    details: string[];
    /** Whether `primary` is a live countdown (the timer case). */
    countdown: boolean;
}

/**
 * Present a job (timer/reminder/notification scheduled) for rendering.
 * Timer: time remaining primary; Reminder: moment primary.
 */
export function presentJob(job: Job, now: Date): Presented {
    const details: string[] = [];
    const repeat = repeatText(job);
    if (repeat !== null) {
        details.push(`repeats ${repeat}`);
    }

    if (job.class === "timer") {
        // A timer's primary fact is the time remaining, as a clock face the
        // countdown can tick (#156 review): `hh:mm:ss`, not the coarse prose a
        // moment gets. A running timer has no remaining time left to show.
        if (job.state === "running") {
            return {
                kind: "Timer",
                primary: "running now",
                title: job.label,
                body: jobBody(job),
                details,
                countdown: false,
            };
        }
        return {
            kind: "Timer",
            primary: formatCountdown(job.runAt, now),
            title: job.label,
            body: jobBody(job),
            details,
            countdown: true,
        };
    }

    if (job.class === "reminder") {
        const primary =
            job.state === "running"
                ? "running now"
                : describeRunAt(job.runAt, now);
        return {
            kind: "Reminder",
            primary,
            title: job.label,
            body: jobBody(job),
            details,
            countdown: false,
        };
    }

    // notification class (scheduled note)
    const primary =
        job.state === "running" ? "running now" : describeRunAt(job.runAt, now);
    return {
        kind: "Notification",
        primary,
        title: job.label,
        body: jobBody(job),
        details,
        countdown: false,
    };
}

/**
 * Present a notification record for rendering.
 *
 * The **message is primary**: `primary` is the record's title — the headline
 * the user was shown — and `body` carries the detail under it, rendered as
 * Markdown so links survive. `details` holds the non-message notes only
 * ("waiting for your answer").
 */
export function presentNotification(
    notification: ClientNotification,
    _now: Date,
): Presented {
    const details: string[] = [];
    if (notification.requiresAnswer === true) {
        details.push("waiting for your answer");
    }

    return {
        kind: describeNotice(notification),
        primary: notification.title,
        title: notification.title,
        body: describeBody(notification),
        details,
        countdown: false,
    };
}
