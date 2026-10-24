/**
 * The in-session ask relay (#94).
 *
 * The block is prompt text, so the tests are about the three things that can go
 * wrong without a code error: a greeting being treated as an answer, another
 * conversation being told about work it did not ask for, and one artifact
 * filling the prompt. The wording itself is asserted only where it carries
 * meaning ("do not answer these yourself", the job id, the resume tool).
 */
import { describe, expect, it } from "vitest";
import type { AppCodingJob } from "@lukestanbery/jarvis-auth";
import {
    codingAskContext,
    MAX_RELAYED_JOBS,
    withCodingAsks,
} from "../src/sandbox/ask";

/** A parked job; every field the relay reads is overridable. */
function parked(overrides: Partial<AppCodingJob> = {}): AppCodingJob {
    return {
        id: "job-1",
        userId: 7,
        repo: "luke/app",
        branch: "jarvis/fix-it",
        prompt: "Fix it.",
        state: "awaiting-answer",
        crashPolicy: "prune",
        model: "big-pickle",
        containerId: null,
        workspacePath: "/jobs/job-1/repo",
        logTail: "",
        diffSummary: null,
        prUrl: null,
        issueNumber: null,
        questionCommentId: null,
        plan: "Plan.",
        lastSeenCommentId: null,
        attempts: 1,
        lastError: null,
        createdAt: "2026-10-19T12:00:00.000Z",
        startedAt: "2026-10-19T12:01:00.000Z",
        finishedAt: null,
        sessionId: "ses_chat",
        questions: ["Which database?", "Which port?"],
        ...overrides,
    };
}

describe("the in-session ask relay (#94)", () => {
    it("is absent when nothing is parked", () => {
        expect(codingAskContext([])).toBeNull();
        expect(codingAskContext([parked({ questions: null })])).toBeNull();
        expect(codingAskContext([parked({ questions: [] })])).toBeNull();
    });

    it("names the job, its questions, and forbids inventing an answer", () => {
        const block = codingAskContext([parked()]) ?? "";

        expect(block).toContain("job-1");
        expect(block).toContain("luke/app");
        expect(block).toContain("Which database?");
        expect(block).toContain("Which port?");
        expect(block).toContain("Do not answer these yourself");
        expect(block).toContain("resumeCodingJob");
    });

    it("prefixes the turn without losing the user's words", () => {
        const prompt = withCodingAsks([parked()], "Use Postgres.");

        expect(prompt).toContain("Which database?");
        expect(prompt.endsWith("Use Postgres.")).toBe(true);
    });

    it("leaves the prompt alone when there is nothing to relay", () => {
        expect(withCodingAsks([], "hello")).toBe("hello");
    });

    it("bounds how many jobs and how much text one turn carries", () => {
        const long = "x".repeat(2000);
        const many = Array.from({ length: MAX_RELAYED_JOBS + 2 }, (_, index) =>
            parked({
                id: `job-${index}`,
                questions: [long, long],
            }),
        );

        const block = codingAskContext(many) ?? "";

        // The oldest jobs are the ones that get the room; the extras are not
        // silently pretending to be covered.
        expect(block).toContain("job-0");
        expect(block).not.toContain(`job-${MAX_RELAYED_JOBS + 1}`);
        expect(block.length).toBeLessThanOrEqual(2500);
        expect(block).toContain("[truncated]");
    });
});
