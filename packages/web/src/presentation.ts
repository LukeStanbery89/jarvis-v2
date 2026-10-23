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
import { describeRunAt, jobBody, repeatText, gateText } from "./jobs";
import { describeBody, describeNotice } from "./notifications";

/** Structured parts a row/card renders, per class. */
export interface Presented {
    /** The row's eyebrow: its class, and any state worth naming. */
    kind: string;
    /** The one fact the class exists to tell. */
    primary: string;
    /** The thing itself — the user's label or the message's title. */
    title: string;
    /** Everything else: body, repeats, gate, "waiting for your answer". */
    details: string[];
    /** Whether `primary` is a live countdown (the timer case). */
    countdown: boolean;
}

/**
 * Present a job (timer/reminder/notification scheduled) for rendering.
 * Timer: time remaining primary; Reminder: moment primary.
 */
export function presentJob(job: Job, now: Date): Presented {
    const body = jobBody(job);
    const details: string[] = [];
    if (body !== null) {
        details.push(body);
    }
    const repeat = repeatText(job);
    if (repeat !== null) {
        details.push(`repeats ${repeat}`);
    }
    if (job.gate !== undefined) {
        const g = gateText(job);
        if (g !== null) {
            details.push(g);
        }
    }

    if (job.class === "timer") {
        const primary =
            job.state === "running"
                ? "running now"
                : describeRunAt(job.runAt, now);
        const isWithinHour =
            job.state !== "running" &&
            (() => {
                const at = new Date(job.runAt).getTime();
                if (Number.isNaN(at)) return false;
                const diff = at - now.getTime();
                return diff >= -60000 && diff < 60 * 60_000;
            })();
        return {
            kind: "Timer",
            primary,
            title: job.label,
            details,
            countdown: job.state !== "running" && isWithinHour,
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
        details,
        countdown: false,
    };
}

/**
 * Present a notification record for rendering.
 * Notification: message is primary (title/body as message).
 */
export function presentNotification(
    notification: ClientNotification,
    _now: Date,
): Presented {
    const body = describeBody(notification);
    const details: string[] = [];
    if (body !== null) {
        details.push(body);
    }
    if (notification.requiresAnswer === true) {
        details.push("waiting for your answer");
    }

    const kind = describeNotice(notification);
    const title = notification.title;
    // Message is primary for notifications - put the full message as primary
    const primary = body !== null ? `${title} ${body}` : title;

    return {
        kind,
        primary,
        title,
        details: body !== null ? details.filter((d) => d !== body) : details,
        countdown: false,
    };
}
