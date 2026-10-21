/**
 * GitHub tracker tools (#140).
 *
 * The tools are thin by design: the client owns the REST shape and the
 * allowlist/owner gates stay in the tool. What is worth asserting is exactly
 * that seam — who may act, which repository a call lands on, and what the
 * model is told when GitHub refuses. The permission hint matters most: the App
 * without Issues access answers "Resource not accessible by integration",
 * which a person cannot act on.
 */
import { describe, expect, it, vi } from "vitest";
import type { IssueSnapshot, PullRequestSnapshot } from "../src/github/client";
import {
    createGitHubTools,
    renderIssue,
    renderIssues,
    renderPullRequest as renderPullRequestText,
    type GitHubToolDeps,
} from "../src/llm/tools/github";

const ISSUE: IssueSnapshot = {
    number: 140,
    url: "https://github.com/luke/app/issues/140",
    title: "Work with the GitHub tracker",
    body: "Read and comment on issues.",
    state: "open",
    labels: ["enhancement", "server"],
    author: "luke",
    pullRequest: false,
    commentCount: 2,
    createdAt: "2026-10-19T10:00:00.000Z",
};

const PULL: PullRequestSnapshot = {
    owner: "luke",
    repo: "app",
    number: 165,
    url: "https://github.com/luke/app/pull/165",
    title: "A change",
    body: "",
    head: "jarvis/a-change-1234",
    base: "main",
    state: "open",
    headRepo: "luke/app",
    comments: [],
    commentsTruncated: false,
    conversationUnavailable: false,
};

const OWNER_RUNTIME = {
    configurable: { sessionId: "s1", clientIp: "10.0.0.1", userId: 7 },
};
const GUEST_RUNTIME = {
    configurable: { sessionId: "s1", clientIp: "10.0.0.1" },
};

/** A client over recording fakes. */
function makeTools(
    overrides: Partial<GitHubToolDeps["client"]> = {},
    repos: readonly string[] = ["luke/app"],
) {
    const client = {
        getIssue: vi.fn(async () => ISSUE),
        readPullRequest: vi.fn(async () => PULL),
        listIssues: vi.fn(async () => [ISSUE]),
        createIssue: vi.fn(async () => ({
            number: 142,
            url: "https://github.com/luke/app/issues/142",
        })),
        commentOnIssue: vi.fn(async () => ({
            number: 987,
            url: "https://github.com/luke/app/issues/140#issuecomment-987",
        })),
        ...overrides,
    };
    const tools = createGitHubTools({
        client,
        repos,
        isOwner: (userId) => userId === 7,
    });
    const invoke = async (
        name: string,
        input: Record<string, unknown>,
        runtime: unknown = OWNER_RUNTIME,
    ): Promise<string> => {
        const found = tools.find((candidate) => candidate.name === name);
        if (found === undefined) {
            throw new Error(`no tool ${name}`);
        }
        return (await found.invoke(input, runtime as never)) as string;
    };
    return { client, invoke };
}

describe("GitHub tracker tools", () => {
    it("refuses a guest and a non-owner before the client is reached", async () => {
        const { client, invoke } = makeTools();

        const guest = await invoke(
            "getGitHubIssue",
            { number: 140 },
            GUEST_RUNTIME,
        );
        expect(guest.toLowerCase()).toContain("sign");
        expect(client.getIssue).not.toHaveBeenCalled();

        const stranger = await invoke(
            "getGitHubIssue",
            { number: 140 },
            { configurable: { sessionId: "s1", userId: 9 } },
        );
        expect(stranger).toContain("owner account");
        expect(client.getIssue).not.toHaveBeenCalled();
    });

    it("reads an issue in the only allowed repository", async () => {
        const { client, invoke } = makeTools();

        const text = await invoke("getGitHubIssue", { number: 140 });

        expect(client.getIssue).toHaveBeenCalledWith(
            "luke",
            "app",
            140,
            expect.anything(),
        );
        expect(text).toContain("#140 open — Work with the GitHub tracker");
        expect(text).toContain("labels: enhancement, server");
        expect(text).toContain("Read and comment on issues.");
        expect(text).toContain("https://github.com/luke/app/issues/140");
    });

    it("points an issue read at the PR tool without fetching comments", async () => {
        const { invoke, client } = makeTools({
            getIssue: vi.fn(async () => ({
                ...ISSUE,
                number: 165,
                pullRequest: true,
            })),
        });

        const text = await invoke("getGitHubIssue", { number: 165 });

        expect(text).toContain("is a pull request, not an issue");
        expect(text).toContain("getGitHubPullRequest");
        expect(client.readPullRequest).not.toHaveBeenCalled();
    });

    it("points a pull request read at the issue tool for an issue", async () => {
        const { invoke, client } = makeTools();

        const text = await invoke("getGitHubPullRequest", { number: 140 });

        expect(text).toContain("is an issue, not a pull request");
        expect(text).toContain("getGitHubIssue");
        expect(client.readPullRequest).not.toHaveBeenCalled();
    });

    it("says when a number is a pull request, and points at the job tool", async () => {
        const text = renderIssue({ ...ISSUE, pullRequest: true });

        expect(text).toContain("is a pull request");
        expect(text).toContain("startCodingJob");
    });

    it("shows a pull request's review comments, which the issue count hides", async () => {
        // The live bug: the issue endpoint said "0 comments" because the note
        // was an inline review comment, not a conversation message.
        const { invoke, client } = makeTools({
            getIssue: vi.fn(async () => ({
                ...ISSUE,
                number: 165,
                pullRequest: true,
                commentCount: 0,
            })),
            readPullRequest: vi.fn(async () => ({
                ...PULL,
                comments: [
                    {
                        author: "luke",
                        body: "Make the comment say Hello, World!",
                        path: "README.md",
                        line: 1,
                    },
                ],
            })),
        });

        const text = await invoke("getGitHubPullRequest", { number: 165 });

        expect(client.readPullRequest).toHaveBeenCalledWith(
            "luke",
            "app",
            165,
            expect.anything(),
        );
        expect(text).toContain("Make the comment say Hello, World!");
        expect(text).toContain("README.md:1");
        expect(text).not.toContain("0 comment(s)");
        // The tail names the call that actually changes the branch.
        expect(text).toContain("startCodingJob");
        expect(text).toContain("pullRequest: 165");
    });

    it("still shows the pull request when its comments cannot be read", async () => {
        const { invoke } = makeTools({
            getIssue: vi.fn(async () => ({
                ...ISSUE,
                number: 165,
                pullRequest: true,
            })),
            readPullRequest: vi.fn(async () => {
                throw new Error(
                    "GitHub /repos/luke/app/pulls/165/comments failed: 403 Forbidden",
                );
            }),
        });

        const text = await invoke("getGitHubPullRequest", { number: 165 });

        expect(text).toContain("Work with the GitHub tracker");
        expect(text).toContain("Review comments could not be read");
    });

    it("says a pull request has no comments only when the thread is empty", () => {
        const text = renderPullRequestText(
            { ...ISSUE, pullRequest: true, commentCount: 0 },
            PULL,
        );

        expect(text).toContain("No review comments or conversation yet.");
    });

    it("asks which repository when several are allowed and none was named", async () => {
        const { client, invoke } = makeTools({}, ["luke/app", "luke/other"]);

        const text = await invoke("getGitHubIssue", { number: 140 });

        expect(text).toContain("Which repository?");
        expect(text).toContain("luke/app, luke/other");
        expect(client.getIssue).not.toHaveBeenCalled();
    });

    it("refuses a repository outside the allowlist", async () => {
        const { client, invoke } = makeTools();

        const text = await invoke("getGitHubIssue", {
            repo: "someone/else",
            number: 140,
        });

        expect(text).toContain("not configured for GitHub");
        expect(text).toContain("luke/app");
        expect(client.getIssue).not.toHaveBeenCalled();
    });

    it("lists issues and says when the list is empty", async () => {
        const { invoke, client } = makeTools();

        const text = await invoke("listGitHubIssues", {});
        expect(client.listIssues).toHaveBeenCalledWith(
            "luke",
            "app",
            { state: "open", limit: 20 },
            expect.anything(),
        );
        expect(text).toContain("#140 Work with the GitHub tracker");
        expect(text).toContain("labels: enhancement, server");

        const empty = renderIssues([], "luke/app");
        expect(empty).toBe("No issues matched in luke/app.");
    });

    it("creates an issue and comments on one", async () => {
        const { invoke, client } = makeTools();

        const created = await invoke("createGitHubIssue", {
            title: "A bug",
            body: "It breaks.",
        });
        expect(client.createIssue).toHaveBeenCalledWith(
            "luke",
            "app",
            { title: "A bug", body: "It breaks." },
            expect.anything(),
        );
        expect(created).toContain("Created issue #142");

        const commented = await invoke("commentOnGitHub", {
            number: 140,
            body: "On it.",
        });
        expect(client.commentOnIssue).toHaveBeenCalledWith(
            "luke",
            "app",
            140,
            "On it.",
            expect.anything(),
        );
        expect(commented).toContain("Commented on #140");
    });

    it("names the missing permission when GitHub refuses", async () => {
        const { invoke } = makeTools({
            getIssue: vi.fn(async () => {
                throw new Error(
                    "GitHub /repos/luke/app/issues/140 failed: 403 Resource not accessible by integration",
                );
            }),
        });

        const text = await invoke("getGitHubIssue", { number: 140 });

        expect(text).toContain("Resource not accessible by integration");
        expect(text).toContain("Issues permission");
    });

    it("renders a body that is too long as a bounded excerpt", () => {
        const text = renderIssue({ ...ISSUE, body: "x".repeat(10_000) });

        expect(text.length).toBeLessThan(5_000);
        expect(text.endsWith("…")).toBe(true);
    });
});
