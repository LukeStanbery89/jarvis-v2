/**
 * The SDLC artifacts a coding job leaves in its workspace (#94, #180).
 *
 * A job never holds a GitHub credential: its network is the broker plus the
 * egress proxy, and no token for the tracker exists inside the container. So
 * the agent communicates through files instead:
 *
 * - `.jarvis/plan.md` — the plan it wrote before editing.
 * - `.jarvis/questions.json` — the questions it needs answered before it can
 *   continue, or absent when the task was clear enough.
 *
 * The supervisor reads both after the run, posts the plan/questions as an issue
 * comment, and **deletes the directory before any host git command**, so it can
 * never reach the branch, the diff or the pull request.
 *
 * A question may be free text, a single choice, or a multiple choice (#180).
 * The legacy `{"questions":["...","..."]}` shape still parses as text, so a
 * small model that has not learned the richer shape is not silenced.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
    CodingQuestion,
    CodingQuestionKind,
    CodingQuestionOption,
} from "@lukestanbery/jarvis-auth";
import { logger } from "../logger";

/** The directory (relative to the clone root) that carries the artifacts. */
export const JOB_ARTIFACT_DIR = ".jarvis";

/** How much of the plan is kept. */
const PLAN_MAX_BYTES = 16 * 1024;

/** How much of the questions file is read. */
const QUESTIONS_MAX_BYTES = 8 * 1024;

/** How many questions one run may ask. */
const MAX_QUESTIONS = 20;

/** Longest question text kept. */
const QUESTION_TEXT_MAX_CHARS = 2000;

/** How many choices one question may offer. */
const MAX_OPTIONS = 20;

/** Longest choice label kept. */
const OPTION_LABEL_MAX_CHARS = 200;

/** Longest id kept (question or option). */
const ID_MAX_CHARS = 64;

/** What the agent left behind, as the supervisor reads it. */
export interface JobArtifacts {
    /** The plan, or `null` when the agent wrote none. */
    plan: string | null;
    /**
     * The questions as plain text, for the in-session relay and the legacy
     * notification body. `structuredQuestions` is the source of truth.
     */
    questions: readonly string[];
    /** The normalized questions, with their kind, choices and flags. */
    structuredQuestions: readonly CodingQuestion[];
}

/**
 * Reads a text file up to a byte cap.
 *
 * @param file - The absolute path.
 * @param maxBytes - The cap; the text is cut, never rejected.
 * @returns The text, or `null` when the file is missing or unreadable.
 */
async function readCapped(
    file: string,
    maxBytes: number,
): Promise<string | null> {
    try {
        const text = await readFile(file, "utf8");
        return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    } catch {
        return null;
    }
}

/**
 * Reads the text out of one entry.
 *
 * A small model may write `"what database?"`, `{ "question": "..." }` or
 * `{ "text": "..." }`; all three are an answerable question, so none is
 * discarded over shape.
 *
 * @param value - The raw entry.
 * @returns The bounded question text, or `null` when it is empty.
 */
function questionText(value: unknown): string | null {
    if (typeof value === "string") {
        const text = value.trim();
        return text.length > 0 ? text.slice(0, QUESTION_TEXT_MAX_CHARS) : null;
    }
    if (typeof value === "object" && value !== null) {
        const record = value as { question?: unknown; text?: unknown };
        for (const candidate of [record.text, record.question]) {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
                return candidate.trim().slice(0, QUESTION_TEXT_MAX_CHARS);
            }
        }
    }
    return null;
}

/**
 * Turns a raw id into a safe, stable id.
 *
 * @param value - The raw id, when the model supplied one.
 * @param fallback - The id to use when it did not.
 * @returns A lowercase slug, bounded and never empty.
 */
function idText(value: unknown, fallback: string): string {
    const raw =
        typeof value === "string" || typeof value === "number"
            ? String(value).trim()
            : "";
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, ID_MAX_CHARS);
    return slug.length > 0 ? slug : fallback;
}

/**
 * Makes an id unique within one set by suffixing a counter.
 *
 * @param base - The candidate id.
 * @param used - The ids already taken; updated with the result.
 * @returns The unique id.
 */
function uniqueId(base: string, used: Set<string>): string {
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
        id = `${base.slice(0, ID_MAX_CHARS - 4)}-${suffix}`;
        suffix += 1;
    }
    used.add(id);
    return id;
}

/**
 * Normalizes one choice.
 *
 * Accepts a bare string (`"Rail"`) or an object with `id` plus
 * `label`/`text`/`value`.
 *
 * @param value - The raw choice.
 * @param index - Its position, for the fallback id.
 * @param used - The choice ids already taken in this question.
 * @returns The normalized choice, or `null` when it has no label.
 */
function optionFrom(
    value: unknown,
    index: number,
    used: Set<string>,
): CodingQuestionOption | null {
    if (typeof value === "string") {
        const label = value.trim().slice(0, OPTION_LABEL_MAX_CHARS);
        if (label.length === 0) {
            return null;
        }
        return {
            id: uniqueId(idText(undefined, `opt${index + 1}`), used),
            label,
        };
    }
    if (typeof value === "object" && value !== null) {
        const record = value as {
            id?: unknown;
            label?: unknown;
            text?: unknown;
            value?: unknown;
        };
        const candidate = [record.label, record.text, record.value].find(
            (entry) => typeof entry === "string" && entry.trim().length > 0,
        );
        if (typeof candidate !== "string") {
            return null;
        }
        return {
            id: uniqueId(idText(record.id, `opt${index + 1}`), used),
            label: candidate.trim().slice(0, OPTION_LABEL_MAX_CHARS),
        };
    }
    return null;
}

/**
 * Normalizes one question.
 *
 * The legacy string/`{question}`/`{text}` shapes become a required `text`
 * question. A choice question with no usable choices is downgraded to `text`
 * rather than left unanswerable. When `kind` is absent but choices are present,
 * `single` is inferred.
 *
 * @param value - The raw entry.
 * @param index - Its position, for the fallback id.
 * @param used - The question ids already taken.
 * @returns The normalized question, or `null` when it has no text.
 */
function questionFrom(
    value: unknown,
    index: number,
    used: Set<string>,
): CodingQuestion | null {
    const text = questionText(value);
    if (text === null) {
        return null;
    }
    const record =
        typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const optionIds = new Set<string>();
    const options = rawOptions
        .map((option, position) => optionFrom(option, position, optionIds))
        .filter((option): option is CodingQuestionOption => option !== null)
        .slice(0, MAX_OPTIONS);

    const declared = record.kind ?? record.type;
    const kind: CodingQuestionKind =
        declared === "single" || declared === "multi"
            ? declared
            : declared === undefined && options.length > 0
              ? "single"
              : "text";
    const effectiveKind: CodingQuestionKind =
        kind !== "text" && options.length === 0 ? "text" : kind;

    return {
        id: uniqueId(idText(record.id, `q${index + 1}`), used),
        text,
        kind: effectiveKind,
        options: effectiveKind === "text" ? [] : options,
        required: typeof record.required === "boolean" ? record.required : true,
        allowOther:
            effectiveKind !== "text" && record.allowOther === true
                ? true
                : false,
    };
}

/**
 * Normalizes the entries of a questions file.
 *
 * @param entries - The parsed array.
 * @returns The normalized, bounded questions.
 */
function questionsFrom(entries: readonly unknown[]): CodingQuestion[] {
    const used = new Set<string>();
    return entries
        .map((entry, index) => questionFrom(entry, index, used))
        .filter((question): question is CodingQuestion => question !== null)
        .slice(0, MAX_QUESTIONS);
}

/**
 * The fallback for a file that is not the expected JSON: one text question
 * carrying the file's own words, so the ask is not lost.
 *
 * @param raw - The file's text.
 * @returns One text question.
 */
function rawQuestion(raw: string): CodingQuestion {
    return {
        id: "q1",
        text: raw.trim().slice(0, QUESTION_TEXT_MAX_CHARS),
        kind: "text",
        options: [],
        required: true,
        allowOther: false,
    };
}

/**
 * Reads a job's plan and questions.
 *
 * A malformed questions file is not silence: its text becomes a single
 * question, so a model that wrote prose instead of JSON still reaches the
 * user rather than the job finishing as if it had no doubts.
 *
 * @param workspacePath - The clone's root (the server-side path).
 * @returns The plan and normalized questions.
 */
export async function readJobArtifacts(
    workspacePath: string,
): Promise<JobArtifacts> {
    const dir = path.join(workspacePath, JOB_ARTIFACT_DIR);
    const planRaw = await readCapped(path.join(dir, "plan.md"), PLAN_MAX_BYTES);
    const plan =
        planRaw !== null && planRaw.trim().length > 0 ? planRaw.trim() : null;

    const raw = await readCapped(
        path.join(dir, "questions.json"),
        QUESTIONS_MAX_BYTES,
    );
    if (raw === null || raw.trim().length === 0) {
        return { plan, questions: [], structuredQuestions: [] };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logger.warn(
            `coding job artifacts: questions.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); posting its text as one question`,
        );
        const question = rawQuestion(raw);
        return {
            plan,
            questions: [question.text],
            structuredQuestions: [question],
        };
    }

    const entries = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null
          ? (parsed as { questions?: unknown }).questions
          : undefined;
    if (!Array.isArray(entries)) {
        const question = rawQuestion(raw);
        return {
            plan,
            questions: [question.text],
            structuredQuestions: [question],
        };
    }
    const structured = questionsFrom(entries);
    return {
        plan,
        questions: structured.map((question) => question.text),
        structuredQuestions: structured,
    };
}

/**
 * Deletes the artifact directory.
 *
 * Called before any host git command and after the plan/questions have been
 * read. A failure is logged, not fatal: the directory is excluded from git, so
 * a leftover cannot enter the branch.
 *
 * @param workspacePath - The clone's root.
 */
export async function clearJobArtifacts(workspacePath: string): Promise<void> {
    try {
        await rm(path.join(workspacePath, JOB_ARTIFACT_DIR), {
            recursive: true,
            force: true,
        });
    } catch (err) {
        logger.warn(
            `coding job artifacts: could not remove ${JOB_ARTIFACT_DIR}: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}
