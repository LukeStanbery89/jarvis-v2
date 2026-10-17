/**
 * Deferring a reminder from the client (#90 phase 6c).
 *
 * The one place the two halves of a snooze are joined, because three surfaces
 * offer it — the floating toast, the notifications page, the reminder list — and
 * the order matters: the **job** call is the action (it also settles the
 * announcement, server-side, in the same request), and the row is settled locally
 * only once that reported success.
 *
 * `useJobs.snooze` answers with a boolean rather than throwing, so a refusal
 * leaves the row exactly as it was and the failure is already reported on
 * `jobs.error`. That is what makes this callable from an `onClick` with no
 * ceremony.
 */
import type { ClientNotification } from "./notifications";
import type { JobsState } from "./hooks/useJobs";
import type { NotificationsState } from "./hooks/useNotifications";

/**
 * Defers the reminder a notification came from.
 *
 * A silent no-op for a row with no job link (a pruned job nulls it) — the caller
 * only offers Snooze where the link exists, so this is a guard rather than a path
 * a user can reach.
 *
 * @param deps - The shell's two hooks, as passed down.
 * @param item - The notification row the action came from.
 * @param minutes - How long to defer by.
 */
export function snoozeReminder(
    deps: { notifications: NotificationsState; jobs: JobsState },
    item: ClientNotification,
    minutes: number,
): void {
    const jobId = item.jobId;
    if (jobId === undefined) {
        return;
    }
    void deps.jobs.snooze(jobId, minutes).then((landed) => {
        if (landed) {
            deps.notifications.markSnoozed(item.id);
        }
    });
}
