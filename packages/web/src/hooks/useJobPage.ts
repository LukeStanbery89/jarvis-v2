/**
 * A job page's form lifecycle (#90 phase 7).
 *
 * Three pages now open the same form — Timers, Reminders, and the Notifications
 * page's scheduled section — and each needs the same three things: which object
 * the form has open, what the last save left to say, and the transitions between
 * them. Kept together because it is one lifecycle (opening the form clears the
 * previous note, a save replaces it, closing the form leaves it in place) and
 * because a second copy would be the place the pages disagreed about what
 * "saved" means.
 */
import { useState } from "react";
import { describeQuiet } from "../jobs";
import type { Job, JobSaved } from "../api";

/** What {@link useJobPage} exposes to a page. */
export interface JobPageState {
    /** `null` while closed; `{ job: null }` to create; `{ job }` to edit. */
    form: { job: Job | null } | null;
    /** The line the last save left behind (the server's quiet-hours forecast). */
    note: string | null;
    /** Opens the form for a new job. */
    create(): void;
    /** Opens the form for one job. */
    edit(job: Job): void;
    /** Closes the form, leaving `note` alone. */
    close(): void;
    /** A save landed: say what the server said about how it will arrive. */
    saved(saved: JobSaved): void;
}

/**
 * Owns the state one job page's form and its confirmation line need.
 *
 * @returns The form's open state, the note, and the transitions.
 */
export function useJobPage(): JobPageState {
    const [form, setForm] = useState<{ job: Job | null } | null>(null);
    const [note, setNote] = useState<string | null>(null);

    return {
        form,
        note,
        create(): void {
            setNote(null);
            setForm({ job: null });
        },
        edit(job: Job): void {
            setNote(null);
            setForm({ job });
        },
        close(): void {
            setForm(null);
        },
        saved(saved: JobSaved): void {
            const quiet = describeQuiet(saved.quiet, saved.job.class);
            setNote(
                quiet === null
                    ? `Saved · “${saved.job.label}” is set.`
                    : `Saved · ${quiet}`,
            );
        },
    };
}
