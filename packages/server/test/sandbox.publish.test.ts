/**
 * The publisher seam (#140).
 *
 * The GitHub client and the workspace push are both tested at their own seams;
 * what is only visible here is the join: which repositories are published, what
 * the pull request says, and that a non-GitHub remote is left alone instead of
 * failing a job that did its work.
 */
import { describe, expect, it, vi } from "vitest";
import { createGitHubPublisher } from "../src/sandbox/publish";

/** The pull request input the fake client sees. */
interface PullRequestInput {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
}

/** A publisher over recording fakes. */
function makePublisher(
    options: {
        pushError?: Error;
        url?: string;
        reviewer?: string;
        reviewError?: Error;
        replyError?: Error;
    } = {},
) {
    const pushes: Array<{
        workspacePath: string;
        branch: string;
        auth?: { username: string; token: string };
    }> = [];
    const createPullRequest = vi.fn(async (_input: PullRequestInput) => ({
        number: 7,
        url: options.url ?? "https://github.com/luke/app/pull/7",
    }));
    const requestReviewers = vi.fn(async () => {
        if (options.reviewError) {
            throw options.reviewError;
        }
    });
    const replyFailure = (): void => {
        if (options.replyError) {
            throw options.replyError;
        }
    };
    const getIssueComment = vi.fn(async () => ({
        body: "Original note.",
        url: "https://github.com/luke/app/pull/7#issuecomment-987",
    }));
    const replyToReviewComment = vi.fn(async () => {
        replyFailure();
        return {
            number: 500,
            url: "https://github.com/luke/app/pull/7#discussion_r500",
        };
    });
    const commentOnIssue = vi.fn(async () => {
        replyFailure();
        return {
            number: 501,
            url: "https://github.com/luke/app/pull/7#issuecomment-501",
        };
    });
    const reactToComment = vi.fn(async () => undefined);
    const client = {
        installationToken: vi.fn(async () => ({
            token: "ghs_secret",
            expiresAt: "2026-10-20T13:00:00Z",
        })),
        defaultBranch: vi.fn(async () => "main"),
        createPullRequest,
        requestReviewers,
        getIssueComment,
        replyToReviewComment,
        commentOnIssue,
        reactToComment,
    };
    const publisher = createGitHubPublisher({
        client,
        push: async (input) => {
            if (options.pushError) {
                throw options.pushError;
            }
            pushes.push(input);
        },
        ...(options.reviewer !== undefined
            ? { reviewer: options.reviewer }
            : {}),
    });
    return {
        publisher,
        pushes,
        client,
        createPullRequest,
        requestReviewers,
        getIssueComment,
        replyToReviewComment,
        commentOnIssue,
        reactToComment,
    };
}

const INPUT = {
    jobId: "job-1",
    workspacePath: "/jobs/job-1/repo",
    repo: "luke/app",
    branch: "jarvis/fix-the-login-bug-1234",
    task: "Fix the login bug\nIt happens on Safari.",
    diffSummary: "new commits:\nabc123 Fix the login bug",
};

describe("the GitHub publisher", () => {
    it("pushes with the installation token and opens one pull request", async () => {
        const { publisher, pushes, createPullRequest, requestReviewers } =
            makePublisher();

        const published = await publisher.publish(INPUT);

        expect(published).toEqual({
            prUrl: "https://github.com/luke/app/pull/7",
        });
        expect(pushes).toEqual([
            {
                workspacePath: "/jobs/job-1/repo",
                branch: "jarvis/fix-the-login-bug-1234",
                auth: { username: "x-access-token", token: "ghs_secret" },
            },
        ]);
        expect(createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: "luke",
                repo: "app",
                head: "jarvis/fix-the-login-bug-1234",
                base: "main",
                title: "JARVIS: Fix the login bug",
            }),
        );
        const body = createPullRequest.mock.calls[0]?.[0].body ?? "";
        expect(body).toContain("## Task");
        expect(body).toContain("It happens on Safari.");
        expect(body).toContain("job-1");
        expect(body).toContain("new commits:");
        // The owner is the human on a personal repository.
        expect(requestReviewers).toHaveBeenCalledWith("luke", "app", 7, [
            "luke",
        ]);
    });

    it("includes the agent's plan in the pull request body", async () => {
        const { publisher, createPullRequest } = makePublisher();

        await publisher.publish({ ...INPUT, plan: "1. Read the test." });

        const body = createPullRequest.mock.calls[0]?.[0].body ?? "";
        expect(body).toContain("## Plan");
        expect(body).toContain("1. Read the test.");
    });

    it("closes the issue the job implements, on its own line", async () => {
        const { publisher, createPullRequest } = makePublisher();

        await publisher.publish({ ...INPUT, issueNumber: 157 });

        const body = createPullRequest.mock.calls[0]?.[0].body ?? "";
        expect(body).toMatch(/^Closes #157$/m);
    });

    it("does not invent a closing link without an issue", async () => {
        const { publisher, createPullRequest } = makePublisher();

        await publisher.publish(INPUT);

        const body = createPullRequest.mock.calls[0]?.[0].body ?? "";
        expect(body).not.toMatch(/^Closes #/m);
    });

    it("asks the configured reviewer instead of the owner", async () => {
        const { publisher, requestReviewers } = makePublisher({
            reviewer: "luke-human",
        });

        await publisher.publish(INPUT);

        expect(requestReviewers).toHaveBeenCalledWith("luke", "app", 7, [
            "luke-human",
        ]);
    });

    it("still publishes when the review request fails", async () => {
        // An org owner cannot be a reviewer; the PR is still the work.
        const { publisher } = makePublisher({
            reviewError: new Error(
                "Reviews may only be requested from collaborators",
            ),
        });

        const published = await publisher.publish(INPUT);

        expect(published).toEqual({
            prUrl: "https://github.com/luke/app/pull/7",
        });
    });

    it("pushes a follow-up to its existing PR instead of opening another", async () => {
        const {
            publisher,
            pushes,
            createPullRequest,
            client,
            requestReviewers,
        } = makePublisher();

        const published = await publisher.publish({
            ...INPUT,
            existing: { url: "https://github.com/luke/app/pull/7" },
        });

        expect(published).toEqual({
            prUrl: "https://github.com/luke/app/pull/7",
        });
        expect(pushes).toHaveLength(1);
        // One PR per branch: a second would split the review.
        expect(createPullRequest).not.toHaveBeenCalled();
        expect(client.defaultBranch).not.toHaveBeenCalled();
        // New commits were pushed to the review; ask for the eyes again.
        expect(requestReviewers).toHaveBeenCalledWith("luke", "app", 7, [
            "luke",
        ]);
    });

    it("replies inside the review thread it was started from", async () => {
        const { publisher, replyToReviewComment, reactToComment } =
            makePublisher();

        await publisher.publish({
            ...INPUT,
            existing: { url: "https://github.com/luke/app/pull/7" },
            reply: {
                comment: {
                    kind: "review",
                    id: 433,
                    url: "https://github.com/luke/app/pull/7#discussion_r433",
                },
                body: "Done.",
            },
        });

        expect(replyToReviewComment).toHaveBeenCalledWith(
            "luke",
            "app",
            7,
            433,
            "Done.",
        );
        expect(reactToComment).toHaveBeenCalledWith(
            { owner: "luke", repo: "app", kind: "review", id: 433 },
            "+1",
        );
    });

    it("quotes a conversation comment when replying", async () => {
        const { publisher, getIssueComment, commentOnIssue, reactToComment } =
            makePublisher();

        await publisher.publish({
            ...INPUT,
            existing: { url: "https://github.com/luke/app/pull/7" },
            reply: {
                comment: { kind: "issue", id: 987, url: null },
                body: "Done.",
            },
        });

        expect(getIssueComment).toHaveBeenCalledWith("luke", "app", 987);
        expect(commentOnIssue).toHaveBeenCalledWith(
            "luke",
            "app",
            7,
            "> Original note.\n\nDone.",
        );
        expect(reactToComment).toHaveBeenCalledWith(
            { owner: "luke", repo: "app", kind: "issue", id: 987 },
            "+1",
        );
    });

    it("still publishes when the reply cannot be posted", async () => {
        const { publisher } = makePublisher({
            replyError: new Error("Resource not accessible by integration"),
        });

        const published = await publisher.publish({
            ...INPUT,
            existing: { url: "https://github.com/luke/app/pull/7" },
            reply: {
                comment: { kind: "review", id: 433, url: null },
                body: "Done.",
            },
        });

        expect(published).toEqual({
            prUrl: "https://github.com/luke/app/pull/7",
        });
    });

    it("leaves a non-GitHub remote unpublished", async () => {
        const { publisher, pushes, createPullRequest } = makePublisher();

        const published = await publisher.publish({
            ...INPUT,
            repo: "file:///tmp/scratch/origin",
        });

        expect(published).toBeNull();
        expect(pushes).toHaveLength(0);
        expect(createPullRequest).not.toHaveBeenCalled();
    });

    it("clamps a long task to a title GitHub accepts", async () => {
        const { publisher, createPullRequest } = makePublisher();
        const long = "x".repeat(400);

        await publisher.publish({ ...INPUT, task: long });

        const title = createPullRequest.mock.calls[0]?.[0].title ?? "";
        expect(title.length).toBeLessThanOrEqual(120);
        expect(title.endsWith("…")).toBe(true);
    });

    it("propagates a push failure instead of opening a pull request", async () => {
        const { publisher, createPullRequest } = makePublisher({
            pushError: new Error("remote rejected the update"),
        });

        await expect(publisher.publish(INPUT)).rejects.toThrow(
            "remote rejected the update",
        );
        expect(createPullRequest).not.toHaveBeenCalled();
    });
});
