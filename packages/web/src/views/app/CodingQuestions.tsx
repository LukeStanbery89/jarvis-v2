/**
 * The settled view of a coding job's questions and answers (#180).
 *
 * A notification's answer row only keeps a short summary; the full Q/A set is
 * the job's own record, so a settled card offers this disclosure and fetches
 * `GET /api/coding-jobs/{id}/questions` on mount. It is collapsed by default:
 * the summary is enough for a glance, and the full set is one click away.
 */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { describeCodingAnswer } from "../../codingAnswers";
import type { CodingJobQuestion } from "../../notifications";

/** Props for {@link CodingQuestions}. */
export interface CodingQuestionsProps {
    /** The device credential. */
    token: string;
    /** The job whose questions should be shown. */
    jobId: string;
}

/**
 * The questions-and-answers disclosure.
 *
 * @param props - See {@link CodingQuestionsProps}.
 */
export function CodingQuestions({ token, jobId }: CodingQuestionsProps) {
    const [questions, setQuestions] = useState<CodingJobQuestion[] | null>(
        null,
    );
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setQuestions(null);
        setError(null);
        api.getCodingJobQuestions(token, jobId)
            .then((result) => {
                if (!cancelled) {
                    setQuestions(result.questions);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "could not load the questions",
                    );
                }
            });
        return () => {
            cancelled = true;
        };
    }, [token, jobId]);

    if (error !== null) {
        return (
            <p className="notification-answer-error" role="alert">
                {error}
            </p>
        );
    }
    if (questions === null) {
        return (
            <p className="notification-answer-loading" role="status">
                Loading questions…
            </p>
        );
    }
    if (questions.length === 0) {
        return null;
    }
    return (
        <details className="coding-questions">
            <summary>Questions and answers</summary>
            <ol className="coding-questions-list">
                {questions.map((question) => (
                    <li key={question.id}>
                        <p className="coding-questions-text">
                            {question.text}
                            {question.required ? "" : " (optional)"}
                        </p>
                        <p className="coding-questions-answer">
                            {describeCodingAnswer(question)}
                        </p>
                    </li>
                ))}
            </ol>
        </details>
    );
}
