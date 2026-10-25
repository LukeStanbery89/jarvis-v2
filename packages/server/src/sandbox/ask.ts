/**
 * The in-session ask relay (#94).
 *
 * A coding job started from a chat can park on `.jarvis/questions.json`. The
 * user who asked for the work IS in that conversation, so the questions belong
 * there rather than only on GitHub: the next turn in the same session carries a
 * bounded block naming the parked job and its questions, and the agent can
 * relay them and call `resumeCodingJob` with the user's answer.
 *
 * The block is deliberately explicit about *not* inventing an answer. A model
 * handed a question and a user greeting must ask it, not answer it; that
 * distinction is the whole difference between a relay and a hallucination.
 *
 * This module is pure: the caller reads the parked rows (scoped to the user and
 * the session) and passes them in, so the wording is testable without a store.
 */
import type { AppCodingJob } from "@lukestanbery/jarvis-auth";

/** How many parked jobs one turn is told about. */
export const MAX_RELAYED_JOBS = 3;

/** Longest question text relayed per job, so one artifact cannot fill a prompt. */
const MAX_QUESTION_CHARS = 600;

/** Longest whole block, after which further jobs/questions are dropped. */
const MAX_BLOCK_CHARS = 2400;

/**
 * Formats the parked jobs into a prompt prefix.
 *
 * @param jobs - The user's `awaiting-answer` jobs for this session, oldest first.
 * @returns The block, or `null` when there is nothing to relay.
 */
export function codingAskContext(jobs: readonly AppCodingJob[]): string | null {
    const parked = jobs.filter(
        (job) => job.questions !== null && job.questions.length > 0,
    );
    if (parked.length === 0) {
        return null;
    }
    const sections: string[] = [];
    for (const job of parked.slice(0, MAX_RELAYED_JOBS)) {
        const questions = job.questions ?? [];
        const lines = questions.map(
            (question, index) =>
                `${index + 1}. ${question.slice(0, MAX_QUESTION_CHARS)}`,
        );
        sections.push(
            `jobId: ${job.id} (${job.repo}, branch ${job.branch})\nQuestions:\n${lines.join("\n")}`,
        );
    }
    const block = [
        "A coding job started from this conversation is waiting for the user's answers.",
        "Do not answer these yourself or infer an answer from the conversation: relay them if the user has not addressed them.",
        ...sections,
        "If the user's message answers these questions, call `resumeCodingJob` with that `jobId` and their answers in their own words.",
    ].join("\n\n");
    return block.length > MAX_BLOCK_CHARS
        ? `${block.slice(0, MAX_BLOCK_CHARS)}\n\n[truncated]`
        : block;
}

/**
 * Prefixes a turn's prompt with {@link codingAskContext}.
 *
 * @param jobs - The parked jobs for this session.
 * @param prompt - The user's message.
 * @returns The prompt to run, unchanged when nothing is parked.
 */
export function withCodingAsks(
    jobs: readonly AppCodingJob[],
    prompt: string,
): string {
    const context = codingAskContext(jobs);
    return context === null ? prompt : `${context}\n\n---\n\n${prompt}`;
}
