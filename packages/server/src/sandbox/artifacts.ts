/**
 * The SDLC artifacts a coding job leaves in its workspace (#94).
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
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger";

/** The directory (relative to the clone root) that carries the artifacts. */
export const JOB_ARTIFACT_DIR = ".jarvis";

/** How much of the plan is kept. */
const PLAN_MAX_BYTES = 16 * 1024;

/** How much of the questions file is read. */
const QUESTIONS_MAX_BYTES = 8 * 1024;

/** How many questions one run may ask. */
const MAX_QUESTIONS = 20;

/** What the agent left behind, as the supervisor reads it. */
export interface JobArtifacts {
    /** The plan, or `null` when the agent wrote none. */
    plan: string | null;
    /** The questions, normalized and bounded; empty when none were asked. */
    questions: readonly string[];
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
 * Normalizes one entry of `questions.json`.
 *
 * A small model may write `"what database?"`, `{ "question": "..." }` or
 * `{ "text": "..." }`; all three are an answerable question, so none is
 * discarded over shape.
 *
 * @param value - The raw entry.
 * @returns The question text, or `null` when it is empty.
 */
function questionText(value: unknown): string | null {
    if (typeof value === "string") {
        return value.trim().length > 0 ? value.trim() : null;
    }
    if (typeof value === "object" && value !== null) {
        const record = value as { question?: unknown; text?: unknown };
        for (const candidate of [record.question, record.text]) {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
                return candidate.trim();
            }
        }
    }
    return null;
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
        return { plan, questions: [] };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logger.warn(
            `coding job artifacts: questions.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); posting its text as one question`,
        );
        return { plan, questions: [raw.trim().slice(0, 2000)] };
    }

    const entries = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null
          ? (parsed as { questions?: unknown }).questions
          : undefined;
    if (!Array.isArray(entries)) {
        return { plan, questions: [raw.trim().slice(0, 2000)] };
    }
    const questions = entries
        .map(questionText)
        .filter((question): question is string => question !== null)
        .slice(0, MAX_QUESTIONS);
    return { plan, questions };
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
