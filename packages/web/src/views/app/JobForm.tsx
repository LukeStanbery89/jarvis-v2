/**
 * The create/edit form for a scheduled job (#90 phase 7).
 *
 * One dialog for all three classes, because the differences are small and the
 * fields they share are load-bearing: a **timer** is created by a length (a
 * countdown is what it is, and ten seconds is a legitimate one), while a
 * **reminder** and a **notification** are created by a moment; an edit always
 * uses the moment, because "when this fires" is what is being changed and the
 * row already says it in clock time. The class itself is never a field — it is
 * the page's, since the class decides how loudly the user is interrupted, and a
 * control that could change it would be a way to turn a reminder into a timer.
 *
 * Mount it while it is open (the `TimerRing` shape), so a fresh mount *is* a
 * fresh form: the fields initialise from the job being edited, and a cancelled
 * edit leaves nothing behind.
 *
 * What it sends is a *request*. Every bound it knows (the name and detail
 * lengths, a moment in the future, the horizon, a timer's day ceiling) mirrors
 * `scheduler/create.ts` so it can answer without a round trip, and the server's
 * own refusal is shown verbatim when one still gets through — the two can
 * disagree about who noticed first, never about the truth.
 */
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { X } from "lucide-react";
import {
    checkJobInput,
    defaultMoment,
    editPatchFor,
    instantFromDuration,
    jobBody,
    momentInputValue,
    parseMomentInput,
    DURATION_PRESETS,
    MOMENT_CHIPS,
} from "../../jobs";
import type { DurationUnit, JobClass } from "../../jobs";
import type { JobsState } from "../../hooks/useJobs";
import type { Job, JobSaved } from "../../api";

/** The units the countdown control offers, in the order it lists them. */
const UNITS: DurationUnit[] = ["seconds", "minutes", "hours"];

/** Props for {@link JobForm}. */
export interface JobFormProps {
    /** The class this form writes — the page's, never a field of its own. */
    jobClass: JobClass;
    /** The job being edited, or `null` to create one. */
    editing: Job | null;
    /** The writes (the shell's `useJobs`). */
    jobs: JobsState;
    /** Closes the dialog: Cancel, Escape, or a save that landed. */
    onClose(): void;
    /**
     * A save landed. The page shows what the server said about quiet hours —
     * "it will wait until 7:00 AM" is not something the user should have to
     * discover by waiting.
     */
    onSaved(saved: JobSaved): void;
}

/**
 * The job form, as a native modal dialog.
 *
 * @param props - See {@link JobFormProps}.
 */
export function JobForm({
    jobClass,
    editing,
    jobs,
    onClose,
    onSaved,
}: JobFormProps) {
    /** The class the job will carry: an edit keeps the job's own. */
    const jobClassOf = editing?.class ?? jobClass;
    /** A timer *created* by hand is a length; everything else is a moment. */
    const byDuration = editing === null && jobClassOf === "timer";
    /**
     * Whether the detail field applies. A stored tool or prompt job has no text
     * to edit — the server refuses the field rather than ignoring it — so the
     * form says why instead of offering something that cannot be saved.
     */
    const hasDetail = editing === null || editing.kind === "message";

    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const labelRef = useRef<HTMLInputElement | null>(null);
    const [label, setLabel] = useState(editing?.label ?? "");
    /**
     * The detail as the row would show it. A stored message that only repeats the
     * label is not something the user typed twice, and showing it would invite
     * them to "fix" a field the server has no empty value for.
     */
    const [message, setMessage] = useState(() =>
        editing === null ? "" : (jobBody(editing) ?? ""),
    );
    const [amount, setAmount] = useState("10");
    const [unit, setUnit] = useState<DurationUnit>("minutes");
    const [moment, setMoment] = useState(() =>
        momentInputValue(
            editing === null
                ? defaultMoment(new Date())
                : new Date(editing.runAt),
        ),
    );
    const [problem, setProblem] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const dialog = dialogRef.current;
        // Open on mount — and never close here. The `onClose` handler above is
        // what tells the page to unmount this form, so a cleanup that calls
        // `dialog.close()` fires that handler and unmounts the form it just
        // opened. StrictMode's double-invoke does exactly that (setup → cleanup
        // → setup), which is why "New" first looked like a dead button; the
        // guard keeps the second setup from re-opening a dialog already open.
        if (dialog !== null && !dialog.open) {
            dialog.showModal();
        }
        // Straight to the name: it is the first field and the only one that is
        // always empty on a new job.
        labelRef.current?.focus();
    }, []);

    /** The draft as the pure checks (and the patch builder) read it. */
    function draft() {
        return {
            label,
            message,
            runAt: byDuration
                ? instantFromDuration(new Date(), {
                      amount: Number(amount),
                      unit,
                  })
                : parseMomentInput(moment),
            jobClass: jobClassOf,
        };
    }

    /**
     * Saves the job, or says what is wrong with it.
     *
     * A refusal from the server lands in the same slot as a local one, in the
     * server's own words: the form never rewrites a message it was given, which
     * is what keeps the client and the server from disagreeing about why.
     */
    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault();
        if (saving) {
            return;
        }
        const input = draft();
        const refusal = checkJobInput(input, new Date());
        if (refusal !== null) {
            setProblem(refusal);
            return;
        }
        if (input.runAt === null) {
            // Unreachable: the check above refuses an unreadable moment. Kept so
            // the narrowing is the type system's, not a comment's.
            return;
        }
        if (editing !== null) {
            const patch = editPatchFor(editing, input);
            if (patch === null) {
                setProblem("nothing has changed.");
                return;
            }
            setProblem(null);
            setSaving(true);
            try {
                const result = await jobs.update(editing.id, patch);
                if (!result.ok) {
                    setProblem(result.error);
                    return;
                }
                onSaved({ job: result.job, quiet: result.quiet });
                onClose();
            } finally {
                setSaving(false);
            }
            return;
        }
        setProblem(null);
        setSaving(true);
        try {
            const result = await jobs.create({
                label: input.label.trim(),
                class: jobClassOf,
                runAt: input.runAt.toISOString(),
                message:
                    input.message.trim() === ""
                        ? input.label.trim()
                        : input.message.trim(),
            });
            if (!result.ok) {
                setProblem(result.error);
                return;
            }
            onSaved({ job: result.job, quiet: result.quiet });
            onClose();
        } finally {
            setSaving(false);
        }
    }

    /** The verb on the save button: what the user is about to have done. */
    const action =
        editing !== null
            ? "Save changes"
            : jobClassOf === "timer"
              ? "Set timer"
              : jobClassOf === "reminder"
                ? "Set reminder"
                : "Schedule note";

    return (
        <dialog
            ref={dialogRef}
            className="job-form"
            aria-labelledby="job-form-title"
            onClose={onClose}
        >
            <div className="job-form-head">
                <h2 id="job-form-title">
                    {editing !== null
                        ? `Edit ${jobClassOf}`
                        : jobClassOf === "timer"
                          ? "New timer"
                          : jobClassOf === "reminder"
                            ? "New reminder"
                            : "New note"}
                </h2>
                <button
                    type="button"
                    className="icon-btn small"
                    aria-label="Close"
                    title="Close"
                    onClick={() => dialogRef.current?.close()}
                >
                    <X size={16} aria-hidden="true" />
                </button>
            </div>
            <form
                className="job-form-body"
                onSubmit={(event) => void submit(event)}
            >
                <label className="job-form-row">
                    <span>Name</span>
                    <input
                        ref={labelRef}
                        type="text"
                        value={label}
                        placeholder={
                            jobClassOf === "timer" ? "Kettle" : "Call Mum"
                        }
                        onChange={(event) => setLabel(event.target.value)}
                    />
                </label>
                {byDuration ? (
                    <div className="job-form-row">
                        <span>For</span>
                        <div className="job-form-chips">
                            {DURATION_PRESETS.map((preset) => (
                                <button
                                    key={preset.label}
                                    type="button"
                                    className={
                                        unit === "minutes" &&
                                        Number(amount) === preset.minutes
                                            ? "job-form-chip current"
                                            : "job-form-chip"
                                    }
                                    onClick={() => {
                                        setAmount(String(preset.minutes));
                                        setUnit("minutes");
                                    }}
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </div>
                        <div className="job-form-custom">
                            <input
                                type="number"
                                min="1"
                                step="1"
                                value={amount}
                                aria-label="How long"
                                onChange={(event) =>
                                    setAmount(event.target.value)
                                }
                            />
                            <select
                                value={unit}
                                aria-label="Unit"
                                onChange={(event) =>
                                    setUnit(event.target.value as DurationUnit)
                                }
                            >
                                {UNITS.map((value) => (
                                    <option key={value} value={value}>
                                        {value}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                ) : (
                    <div className="job-form-row">
                        <span>When</span>
                        <input
                            type="datetime-local"
                            value={moment}
                            onChange={(event) => setMoment(event.target.value)}
                        />
                        <div className="job-form-chips">
                            {MOMENT_CHIPS.map((chip) => (
                                <button
                                    key={chip.label}
                                    type="button"
                                    className="job-form-chip"
                                    onClick={() =>
                                        setMoment(
                                            momentInputValue(
                                                chip.at(new Date()),
                                            ),
                                        )
                                    }
                                >
                                    {chip.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {hasDetail && (
                    <label className="job-form-row">
                        <span>Detail</span>
                        <input
                            type="text"
                            value={message}
                            placeholder="optional"
                            onChange={(event) => setMessage(event.target.value)}
                        />
                    </label>
                )}
                {!hasDetail && (
                    <p className="job-form-note">
                        This is a {editing?.kind} job, so it has no detail to
                        edit — its label and its time are what a page can
                        change.
                    </p>
                )}
                {problem !== null && (
                    <p className="job-form-error" role="alert">
                        {problem}
                    </p>
                )}
                <div className="job-form-actions">
                    <button
                        type="button"
                        onClick={() => dialogRef.current?.close()}
                    >
                        Cancel
                    </button>
                    <button type="submit" className="primary" disabled={saving}>
                        {saving ? "Saving…" : action}
                    </button>
                </div>
            </form>
        </dialog>
    );
}
