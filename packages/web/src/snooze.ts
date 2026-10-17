/**
 * Deferring a reminder from the client (#90 phase 6c).
 *
 * The one place the halves of a snooze are joined, because three surfaces offer it
 * — the floating toast, the notifications page, the reminder list — and the order
 * matters: the **job** call is the action (it also settles the announcement,
 * server-side, in the same request), and the local notification state follows it.
 *
 * `useJobs.snooze` answers with a boolean rather than throwing, so a refusal
 * leaves every row exactly as it was and the failure is already reported on
 * `jobs.error`. That is what makes this callable from an `onClick` with no
 * ceremony.
 */
import type { ClientNotification } from "./notifications";
import type { JobsState } from "./hooks/useJobs";
import type { NotificationsState } from "./hooks/useNotifications";

/** What a snooze needs to know. */
export interface SnoozeRequest {
    /** The reminder to move. */
    jobId: string;
    /** How long from now. */
    minutes: number;
    /**
     * The notification row that raised this, when the caller has it — the toast
     * and the notifications page do; the reminder list knows only the job.
     */
    notificationId?: string;
}

/**
 * Defers a reminder.
 *
 * Three things happen, in order: the job moves, the row that raised it is settled
 * locally (instant feedback, when the caller holds one), and the notification list
 * is re-read. The re-read is not redundant — a snooze from the reminder list
 * settles an announcement that page never held, so without it the toast would keep
 * arriving for a reminder the user already deferred.
 *
 * @param deps - The shell's two hooks, as passed down.
 * @param request - See {@link SnoozeRequest}.
 */
export function snoozeReminder(
    deps: { notifications: NotificationsState; jobs: JobsState },
    request: SnoozeRequest,
): void {
    void deps.jobs.snooze(request.jobId, request.minutes).then((landed) => {
        if (!landed) {
            return;
        }
        if (request.notificationId !== undefined) {
            deps.notifications.markSnoozed(request.notificationId);
        }
        deps.notifications.refresh();
    });
}

/**
 * The {@link snoozeReminder} request for a notification row.
 *
 * A row with no job link cannot be deferred (the caller only offers Snooze where
 * the link exists), so this is `null` in that case rather than a guessed id.
 *
 * @param item - The notification the action came from.
 * @param minutes - How long to defer by.
 * @returns The request, or `null` when the row has nothing to move.
 */
export function snoozeRequestFor(
    item: ClientNotification,
    minutes: number,
): SnoozeRequest | null {
    if (item.jobId === undefined) {
        return null;
    }
    return { jobId: item.jobId, minutes, notificationId: item.id };
}
