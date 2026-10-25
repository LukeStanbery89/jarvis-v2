/**
 * The create/edit form for a scheduled job (#90 phase 7).
 *
 * One dialog for all three classes, because the differences are small and the
 * fields they share are load-bearing: a **timer** is a length — created or
 * edited — while a **reminder** and a **notification** are a moment; an edit
 * uses the field its class calls for, because a countdown is what a timer is
 * and a clock time is what the other two are. The class itself is never a field
 * — it is the page's, since the class decides how loudly the user is
 * interrupted, and a control that could change it would be a way to turn a
 * reminder into a timer.
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
    describeMoment,
    durationDraftFor,
    editPatchFor,
    instantFromParts,
    jobBody,
    momentInputValue,
    noRepeat,
    parseMomentInput,
    repeatDraftFromRule,
    repeatDraftToRule,
    toggleWeekday,
    DURATION_PRESETS,
    MOMENT_CHIPS,
    MONTH_ORDINALS,
    REPEAT_CHOICES,
    WEEKDAY_CHIPS,
} from "../../jobs";
import type { JobClass, RepeatDraft } from "../../jobs";
import { describeRepeat, nextOccurrence } from "@lukestanbery/jarvis-protocol";
import type { JobsState } from "../../hooks/useJobs";
import type { Job, JobSaved } from "../../api";

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
    /** A timer is a countdown whether it is being created or edited. */
    const byDuration = jobClassOf === "timer";
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
    /**
     * The duration control's opening value. A timer edit opens on the length it
     * was set with (`durationDraftFor`), not on the clock time it currently
     * points at, so saving re-arms that same length from now.
     */
    function initialDuration() {
        return editing !== null && jobClassOf === "timer"
            ? durationDraftFor(editing, new Date())
            : { hours: 0, minutes: 10, seconds: 0 };
    }
    const [hours, setHours] = useState(() => String(initialDuration().hours));
    const [minutes, setMinutes] = useState(() =>
        String(initialDuration().minutes),
    );
    const [seconds, setSeconds] = useState(() =>
        String(initialDuration().seconds),
    );
    /** The current length in seconds, so the preset chips match the boxes. */
    const durationSeconds =
        Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
    const [moment, setMoment] = useState(() =>
        momentInputValue(
            editing === null
                ? defaultMoment(new Date())
                : new Date(editing.runAt),
        ),
    );
    /**
     * The schedule, as the pure helpers read it (#90 phase 8e). An edit opens on
     * the job's own rule, rendered into the controls — a form that could not show
     * a stored rule would change it by saving.
     */
    const [repeat, setRepeat] = useState<RepeatDraft>(() =>
        editing === null ? noRepeat() : repeatDraftFromRule(editing.repeat),
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

    /** The moment the form currently holds, or `null` when it cannot read one. */
    function momentOf(): Date | null {
        return byDuration
            ? instantFromParts(new Date(), {
                  hours: Number(hours),
                  minutes: Number(minutes),
                  seconds: Number(seconds),
              })
            : parseMomentInput(moment);
    }

    /** The draft as the pure checks (and the patch builder) read it. */
    function draft() {
        return {
            label,
            message,
            runAt: momentOf(),
            jobClass: jobClassOf,
            repeat,
        };
    }

    /**
     * The schedule as it stands, live (#90 phase 8e): the cadence in the words
     * the model would use, and when it fires next.
     *
     * `nextOccurrence` is the *server's* function, so the preview cannot disagree
     * with what will happen — and the anchor is the moment in the picker, which
     * is what the rule is built with, so "next" is the first occurrence the user
     * is looking at rather than a guess.
     */
    function repeatPreview(): string | null {
        if (repeat.choice === "never") {
            return null;
        }
        const first = momentOf();
        if (first === null) {
            return null;
        }
        const rule = repeatDraftToRule(repeat, first);
        if (rule === null) {
            return null;
        }
        const now = new Date();
        const next = nextOccurrence(rule, now);
        const cadence = describeRepeat(rule);
        return next.ok
            ? `${cadence} · next ${describeMoment(next.at.toISOString(), now)}`
            : cadence;
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
            const rule = repeatDraftToRule(repeat, input.runAt);
            const result = await jobs.create({
                label: input.label.trim(),
                class: jobClassOf,
                runAt: input.runAt.toISOString(),
                message:
                    input.message.trim() === ""
                        ? input.label.trim()
                        : input.message.trim(),
                ...(rule !== null ? { repeat: rule } : {}),
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
                    <>
                        <div className="job-form-row">
                            <span>For</span>
                            <div className="job-form-chips">
                                {DURATION_PRESETS.map((preset) => (
                                    <button
                                        key={preset.label}
                                        type="button"
                                        className={
                                            durationSeconds ===
                                            preset.minutes * 60
                                                ? "job-form-chip current"
                                                : "job-form-chip"
                                        }
                                        onClick={() => {
                                            setHours(
                                                String(
                                                    Math.floor(
                                                        preset.minutes / 60,
                                                    ),
                                                ),
                                            );
                                            setMinutes(
                                                String(preset.minutes % 60),
                                            );
                                            setSeconds("0");
                                        }}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>
                            <div
                                className="job-form-duration"
                                role="group"
                                aria-label="Duration: hours, minutes and seconds"
                            >
                                <input
                                    type="number"
                                    min="0"
                                    max="24"
                                    step="1"
                                    value={hours}
                                    aria-label="Hours"
                                    onChange={(event) =>
                                        setHours(event.target.value)
                                    }
                                />
                                <span
                                    className="job-form-duration-sep"
                                    aria-hidden="true"
                                >
                                    :
                                </span>
                                <input
                                    type="number"
                                    min="0"
                                    max="59"
                                    step="1"
                                    value={minutes}
                                    aria-label="Minutes"
                                    onChange={(event) =>
                                        setMinutes(event.target.value)
                                    }
                                />
                                <span
                                    className="job-form-duration-sep"
                                    aria-hidden="true"
                                >
                                    :
                                </span>
                                <input
                                    type="number"
                                    min="0"
                                    max="59"
                                    step="1"
                                    value={seconds}
                                    aria-label="Seconds"
                                    onChange={(event) =>
                                        setSeconds(event.target.value)
                                    }
                                />
                            </div>
                        </div>
                        {editing !== null && (
                            <p className="job-form-note">
                                Saving restarts the countdown from now.
                            </p>
                        )}
                    </>
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
                {jobClassOf !== "timer" && (
                    <div className="job-form-row">
                        <span>Repeats</span>
                        <div className="job-form-chips">
                            {REPEAT_CHOICES.map((choice) => (
                                <button
                                    key={choice.id}
                                    type="button"
                                    className={
                                        repeat.choice === choice.id
                                            ? "job-form-chip current"
                                            : "job-form-chip"
                                    }
                                    onClick={() =>
                                        setRepeat({
                                            ...repeat,
                                            choice: choice.id,
                                        })
                                    }
                                >
                                    {choice.label}
                                </button>
                            ))}
                        </div>
                        {repeat.choice !== "never" && (
                            <div className="job-form-repeat">
                                {repeat.choice !== "weekdays" && (
                                    <label className="job-form-repeat-line">
                                        <span>Every</span>
                                        <input
                                            type="number"
                                            min="1"
                                            step="1"
                                            value={repeat.interval}
                                            aria-label="How many between repeats"
                                            onChange={(event) =>
                                                setRepeat({
                                                    ...repeat,
                                                    interval: Number(
                                                        event.target.value,
                                                    ),
                                                })
                                            }
                                        />
                                        <span>
                                            {repeat.choice === "daily"
                                                ? "day(s)"
                                                : repeat.choice === "weekly"
                                                  ? "week(s)"
                                                  : "month(s)"}
                                        </span>
                                    </label>
                                )}
                                {repeat.choice === "weekly" && (
                                    <div className="job-form-chips">
                                        {WEEKDAY_CHIPS.map(({ day, label }) => (
                                            <button
                                                key={day}
                                                type="button"
                                                aria-label={day}
                                                className={
                                                    repeat.weekdays.includes(
                                                        day,
                                                    )
                                                        ? "job-form-chip current"
                                                        : "job-form-chip"
                                                }
                                                onClick={() =>
                                                    setRepeat({
                                                        ...repeat,
                                                        weekdays: toggleWeekday(
                                                            repeat.weekdays,
                                                            day,
                                                        ),
                                                    })
                                                }
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {repeat.choice === "monthly" && (
                                    <div className="job-form-repeat-line">
                                        <select
                                            value={repeat.monthly}
                                            aria-label="What the month names"
                                            onChange={(event) =>
                                                setRepeat({
                                                    ...repeat,
                                                    monthly: event.target
                                                        .value as RepeatDraft["monthly"],
                                                })
                                            }
                                        >
                                            <option value="day">
                                                a day of the month
                                            </option>
                                            <option value="ordinal">
                                                a weekday of the month
                                            </option>
                                        </select>
                                        {repeat.monthly === "day" ? (
                                            <input
                                                type="number"
                                                min="-31"
                                                max="31"
                                                step="1"
                                                value={repeat.monthDay}
                                                aria-label="Day of the month"
                                                onChange={(event) =>
                                                    setRepeat({
                                                        ...repeat,
                                                        monthDay: Number(
                                                            event.target.value,
                                                        ),
                                                    })
                                                }
                                            />
                                        ) : (
                                            <select
                                                value={repeat.weekOrdinal}
                                                aria-label="Which weekday"
                                                onChange={(event) =>
                                                    setRepeat({
                                                        ...repeat,
                                                        weekOrdinal:
                                                            event.target.value,
                                                    })
                                                }
                                            >
                                                {MONTH_ORDINALS.map(
                                                    (ordinal) => (
                                                        <option
                                                            key={ordinal.value}
                                                            value={
                                                                ordinal.value
                                                            }
                                                        >
                                                            {ordinal.label}
                                                        </option>
                                                    ),
                                                )}
                                            </select>
                                        )}
                                    </div>
                                )}
                                <label className="job-form-repeat-line">
                                    <span>Ends</span>
                                    <select
                                        value={repeat.ends}
                                        aria-label="When the schedule ends"
                                        onChange={(event) =>
                                            setRepeat({
                                                ...repeat,
                                                ends: event.target
                                                    .value as RepeatDraft["ends"],
                                            })
                                        }
                                    >
                                        <option value="never">
                                            never (until cancelled)
                                        </option>
                                        <option value="after">after</option>
                                        <option value="until">on a date</option>
                                    </select>
                                    {repeat.ends === "after" && (
                                        <>
                                            <input
                                                type="number"
                                                min="1"
                                                step="1"
                                                value={repeat.after}
                                                aria-label="How many times"
                                                onChange={(event) =>
                                                    setRepeat({
                                                        ...repeat,
                                                        after: Number(
                                                            event.target.value,
                                                        ),
                                                    })
                                                }
                                            />
                                            <span>time(s)</span>
                                        </>
                                    )}
                                    {repeat.ends === "until" && (
                                        <input
                                            type="date"
                                            aria-label="Stop after this date"
                                            value={
                                                repeat.until === null
                                                    ? ""
                                                    : momentInputValue(
                                                          repeat.until,
                                                      ).slice(0, 10)
                                            }
                                            onChange={(event) =>
                                                setRepeat({
                                                    ...repeat,
                                                    until:
                                                        event.target.value ===
                                                        ""
                                                            ? null
                                                            : (parseMomentInput(
                                                                  `${event.target.value}T23:59`,
                                                              ) ?? null),
                                                })
                                            }
                                        />
                                    )}
                                </label>
                                {repeatPreview() !== null && (
                                    <p className="job-form-repeat-preview">
                                        {repeatPreview()}
                                    </p>
                                )}
                            </div>
                        )}
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
