/**
 * The shape of a coding job's questions (#180).
 *
 * A job that parks on `.jarvis/questions.json` may ask free-text questions,
 * single-choice questions, or multiple-choice questions. The supervisor reads
 * the file, stores the normalized set with the job, and the app renders one
 * control per question; the answer travels back as a {@link CodingAnswer} list.
 *
 * This is the canonical row shape: the server's artifact reader normalizes into
 * it, the auth store persists it, and the REST contract mirrors it for the web
 * client. Keeping it here (rather than in the server) lets the store own the
 * rows it writes without importing a higher-level package.
 */

/** The kinds of question an agent may ask. */
export const CODING_QUESTION_KINDS = ["text", "single", "multi"] as const;

/** One kind of question. */
export type CodingQuestionKind = (typeof CODING_QUESTION_KINDS)[number];

/** One choice in a `single` or `multi` question. */
export interface CodingQuestionOption {
    /** Stable id used by the answer payload. */
    id: string;
    /** What the user reads. */
    label: string;
}

/** One normalized question. */
export interface CodingQuestion {
    /** Stable id used by the answer payload; unique within the set. */
    id: string;
    /** The question itself. */
    text: string;
    /** Free text, one choice, or several choices. */
    kind: CodingQuestionKind;
    /** The choices for `single`/`multi`; empty for `text`. */
    options: readonly CodingQuestionOption[];
    /** Whether the user must answer before the job may resume. */
    required: boolean;
    /** Whether the user may add a free-text answer beside the choices. */
    allowOther: boolean;
}

/** One answer to one question. */
export interface CodingAnswer {
    /** The question's `id`. */
    questionId: string;
    /**
     * A free-text answer, one option id, or several option ids.
     *
     * A single-choice answer that picked **Other** uses `"other"` here and
     * carries the text in {@link other}; a multiple-choice answer lists its
     * chosen option ids and may also carry {@link other}.
     */
    value: string | readonly string[];
    /** Free text for an **Other** choice, when the question allows it. */
    other?: string;
}
