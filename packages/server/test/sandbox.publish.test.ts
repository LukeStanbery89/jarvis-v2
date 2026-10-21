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
function makePublisher(options: { pushError?: Error; url?: string } = {}) {
    const pushes: Array<{
        workspacePath: string;
        branch: string;
        auth?: { username: string; token: string };
    }> = [];
    const createPullRequest = vi.fn(async (_input: PullRequestInput) => ({
        number: 7,
        url: options.url ?? "https://github.com/luke/app/pull/7",
    }));
    const client = {
        installationToken: vi.fn(async () => ({
            token: "ghs_secret",
            expiresAt: "2026-10-20T13:00:00Z",
        })),
        defaultBranch: vi.fn(async () => "main"),
        createPullRequest,
    };
    const publisher = createGitHubPublisher({
        client,
        push: async (input) => {
            if (options.pushError) {
                throw options.pushError;
            }
            pushes.push(input);
        },
    });
    return { publisher, pushes, client, createPullRequest };
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
        const { publisher, pushes, createPullRequest } = makePublisher();

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
    });

    it("pushes a follow-up to its existing PR instead of opening another", async () => {
        const { publisher, pushes, createPullRequest, client } =
            makePublisher();

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
