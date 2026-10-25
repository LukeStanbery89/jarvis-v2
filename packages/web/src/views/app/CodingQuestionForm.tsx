/**
 * The form for a coding job's structured questions (#180).
 *
 * One control per question — a textarea, a radio group, or a checkbox group —
 * plus an **Other** field when the question allows it. The form owns the draft
 * and the submit state; the page owns the request, so a failed resume leaves
 * the draft in place and the user can retry.
 */
import { useId, useState, type FormEvent } from "react";
import type { CodingAnswer, CodingJobQuestion } from "../../notifications";
import {
    codingAnswersFromDraft,
    codingDraftComplete,
    emptyCodingDraft,
    type CodingDraft,
    type CodingDraftAnswer,
} from "../../codingAnswers";

/** Props for {@link CodingQuestionForm}. */
export interface CodingQuestionFormProps {
    /** The job's questions, with any answers already recorded. */
    questions: readonly CodingJobQuestion[];
    /** Sends the whole answer set; a rejection keeps the form open. */
    onSubmit(answers: CodingAnswer[]): Promise<void>;
}

/**
 * The answer form itself.
 *
 * @param props - See {@link CodingQuestionFormProps}.
 */
export function CodingQuestionForm({
    questions,
    onSubmit,
}: CodingQuestionFormProps) {
    const formId = useId();
    const [draft, setDraft] = useState<CodingDraft>(() =>
        emptyCodingDraft(questions),
    );
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Merges one question's change into the draft. */
    function update(id: string, patch: Partial<CodingDraftAnswer>): void {
        setDraft((current) => ({
            ...current,
            [id]: {
                ...(current[id] ?? { value: "", values: [], other: "" }),
                ...patch,
            },
        }));
    }

    const complete = codingDraftComplete(questions, draft);

    function submit(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        if (!complete || sending) {
            return;
        }
        setSending(true);
        setError(null);
        onSubmit(codingAnswersFromDraft(questions, draft))
            .catch((err: unknown) => {
                setError(
                    err instanceof Error
                        ? err.message
                        : "could not send the answers",
                );
            })
            .finally(() => setSending(false));
    }

    return (
        <form className="notification-answer coding-answer" onSubmit={submit}>
            <p className="coding-answer-lead">
                Answer every required question, then send them together.
            </p>
            <ol className="coding-answer-questions">
                {questions.map((question) => {
                    const answer = draft[question.id] ?? {
                        value: "",
                        values: [],
                        other: "",
                    };
                    const inputId = `${formId}-${question.id}`;
                    return (
                        <li
                            key={question.id}
                            className="coding-answer-question"
                        >
                            <fieldset>
                                <legend>
                                    {question.text}
                                    {question.required ? " *" : " (optional)"}
                                </legend>
                                {question.kind === "text" && (
                                    <textarea
                                        id={inputId}
                                        aria-label={question.text}
                                        value={answer.value}
                                        onChange={(event) =>
                                            update(question.id, {
                                                value: event.target.value,
                                            })
                                        }
                                        rows={2}
                                        disabled={sending}
                                        placeholder="Type your answer…"
                                    />
                                )}
                                {question.kind === "single" && (
                                    <div className="coding-answer-options">
                                        {question.options.map((option) => (
                                            <label
                                                key={option.id}
                                                className="coding-answer-option"
                                            >
                                                <input
                                                    type="radio"
                                                    name={inputId}
                                                    value={option.id}
                                                    checked={
                                                        answer.value ===
                                                        option.id
                                                    }
                                                    onChange={() =>
                                                        update(question.id, {
                                                            value: option.id,
                                                        })
                                                    }
                                                    disabled={sending}
                                                />
                                                <span>{option.label}</span>
                                            </label>
                                        ))}
                                        {question.allowOther && (
                                            <label className="coding-answer-option coding-answer-option-other">
                                                <input
                                                    type="radio"
                                                    name={inputId}
                                                    value="other"
                                                    checked={
                                                        answer.value === "other"
                                                    }
                                                    onChange={() =>
                                                        update(question.id, {
                                                            value: "other",
                                                        })
                                                    }
                                                    disabled={sending}
                                                />
                                                <span>Other</span>
                                                <input
                                                    className="coding-answer-other"
                                                    type="text"
                                                    aria-label={`Other answer for ${question.text}`}
                                                    value={answer.other}
                                                    onChange={(event) =>
                                                        update(question.id, {
                                                            value: "other",
                                                            other: event.target
                                                                .value,
                                                        })
                                                    }
                                                    disabled={sending}
                                                    placeholder="Write it…"
                                                />
                                            </label>
                                        )}
                                    </div>
                                )}
                                {question.kind === "multi" && (
                                    <div className="coding-answer-options">
                                        {question.options.map((option) => (
                                            <label
                                                key={option.id}
                                                className="coding-answer-option"
                                            >
                                                <input
                                                    type="checkbox"
                                                    value={option.id}
                                                    checked={answer.values.includes(
                                                        option.id,
                                                    )}
                                                    onChange={(event) => {
                                                        const values = event
                                                            .target.checked
                                                            ? [
                                                                  ...answer.values,
                                                                  option.id,
                                                              ]
                                                            : answer.values.filter(
                                                                  (value) =>
                                                                      value !==
                                                                      option.id,
                                                              );
                                                        update(question.id, {
                                                            values,
                                                        });
                                                    }}
                                                    disabled={sending}
                                                />
                                                <span>{option.label}</span>
                                            </label>
                                        ))}
                                        {question.allowOther && (
                                            <label className="coding-answer-option coding-answer-option-other">
                                                <span>Other</span>
                                                <input
                                                    className="coding-answer-other"
                                                    type="text"
                                                    aria-label={`Other answer for ${question.text}`}
                                                    value={answer.other}
                                                    onChange={(event) =>
                                                        update(question.id, {
                                                            other: event.target
                                                                .value,
                                                        })
                                                    }
                                                    disabled={sending}
                                                    placeholder="Write it…"
                                                />
                                            </label>
                                        )}
                                    </div>
                                )}
                            </fieldset>
                        </li>
                    );
                })}
            </ol>
            <div className="notification-answer-actions">
                <button type="submit" disabled={sending || !complete}>
                    {sending ? "Sending…" : "Send answers"}
                </button>
                {error !== null && (
                    <p className="notification-answer-error" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </form>
    );
}
