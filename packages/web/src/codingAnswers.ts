/**
 * Draft handling for a coding job's structured questions (#180).
 *
 * The form keeps one draft entry per question — a text value, a single option
 * id, a set of multiple option ids, and the optional **Other** note — and these
 * pure helpers turn that draft into the answer payload the REST route accepts.
 * Keeping them out of React makes the required-question and Other rules
 * testable without a DOM.
 */
import type {
    CodingAnswer,
    CodingJobQuestion,
    CodingQuestion,
} from "./notifications";

/** One question's draft. */
export interface CodingDraftAnswer {
    /** A text answer, or the single-choice option id (including `"other"`). */
    value: string;
    /** The selected option ids for a multiple-choice question. */
    values: string[];
    /** Free text for an **Other** choice. */
    other: string;
}

/** Every question's draft, keyed by question id. */
export type CodingDraft = Record<string, CodingDraftAnswer>;

/**
 * Builds an empty draft, prefilled from any answers the job already carries.
 *
 * A retry after a failed resume should not make the user re-enter what the
 * server already recorded.
 *
 * @param questions - The job's questions, with their answers.
 * @returns One draft entry per question.
 */
export function emptyCodingDraft(
    questions: readonly CodingJobQuestion[],
): CodingDraft {
    const draft: CodingDraft = {};
    for (const question of questions) {
        const answer = question.answer;
        if (question.kind === "text") {
            draft[question.id] = {
                value: typeof answer?.value === "string" ? answer.value : "",
                values: [],
                other: "",
            };
        } else if (question.kind === "single") {
            draft[question.id] = {
                value: typeof answer?.value === "string" ? answer.value : "",
                values: [],
                other: answer?.other ?? "",
            };
        } else {
            draft[question.id] = {
                value: "",
                values: Array.isArray(answer?.value) ? [...answer.value] : [],
                other: answer?.other ?? "",
            };
        }
    }
    return draft;
}

/**
 * Whether every required question has a usable answer.
 *
 * Optional questions may be left blank; a required single choice with
 * **Other** selected also needs the note.
 *
 * @param questions - The job's questions.
 * @param draft - The current draft.
 * @returns True when the form may be submitted.
 */
export function codingDraftComplete(
    questions: readonly CodingQuestion[],
    draft: CodingDraft,
): boolean {
    for (const question of questions) {
        if (!question.required) {
            continue;
        }
        const answer = draft[question.id];
        if (answer === undefined) {
            return false;
        }
        if (question.kind === "text") {
            if (answer.value.trim().length === 0) {
                return false;
            }
        } else if (question.kind === "single") {
            if (answer.value.trim().length === 0) {
                return false;
            }
            if (answer.value === "other" && answer.other.trim().length === 0) {
                return false;
            }
        } else if (
            answer.values.length === 0 &&
            answer.other.trim().length === 0
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Turns a draft into the answer payload.
 *
 * Optional blank answers are omitted rather than sent as empty strings, so the
 * agent sees "(not answered)" for them.
 *
 * @param questions - The job's questions.
 * @param draft - The current draft.
 * @returns The answers to submit.
 */
export function codingAnswersFromDraft(
    questions: readonly CodingQuestion[],
    draft: CodingDraft,
): CodingAnswer[] {
    const answers: CodingAnswer[] = [];
    for (const question of questions) {
        const answer = draft[question.id];
        if (answer === undefined) {
            continue;
        }
        if (question.kind === "text") {
            const value = answer.value.trim();
            if (value.length === 0 && !question.required) {
                continue;
            }
            answers.push({ questionId: question.id, value });
        } else if (question.kind === "single") {
            const value = answer.value.trim();
            if (value.length === 0) {
                continue;
            }
            const other = answer.other.trim();
            answers.push({
                questionId: question.id,
                value,
                ...(value === "other" && other.length > 0 ? { other } : {}),
            });
        } else {
            const values = answer.values.filter((value) => value.length > 0);
            const other = answer.other.trim();
            if (values.length === 0 && other.length === 0) {
                continue;
            }
            answers.push({
                questionId: question.id,
                value: values,
                ...(other.length > 0 ? { other } : {}),
            });
        }
    }
    return answers;
}
