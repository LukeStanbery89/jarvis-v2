/**
 * The GitHub App client (#140).
 *
 * The token exchange is exercised with a real RSA key: the JWT's signature is
 * verified against the public half, which is the property that matters — GitHub
 * accepts the assertion only if the App key signed it. The REST calls are a
 * fake fetch, because the shape being tested is what we send and what we do
 * with what comes back, not GitHub's availability.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GitHubConfig } from "../src/config";
import { createGitHubClient, signAppJwt } from "../src/github/client";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CONFIG: GitHubConfig = {
    appId: "12345",
    privateKey,
    installationId: "67890",
    apiBaseUrl: "https://api.github.test",
    repos: ["luke/app"],
    reviewer: null,
};

/** A JSON response. */
function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** The payload of the bearer JWT a request carried. */
function jwtPayload(authorization: string | undefined): {
    header: string;
    payload: Record<string, unknown>;
    signature: string;
} {
    const token = (authorization ?? "").replace(/^Bearer\s+/i, "");
    const [header, payload, signature] = token.split(".");
    if (
        header === undefined ||
        payload === undefined ||
        signature === undefined
    ) {
        throw new Error(`not a JWT: ${token.slice(0, 12)}…`);
    }
    return {
        header,
        payload: JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        ) as Record<string, unknown>,
        signature,
    };
}

describe("the App JWT", () => {
    it("is signed by the App key and carries iss/iat/exp", () => {
        const now = Date.UTC(2026, 9, 20, 12, 0, 0);
        const jwt = signAppJwt(CONFIG.appId, privateKey, now);
        const [header, payload, signature] = jwt.split(".");
        if (
            header === undefined ||
            payload === undefined ||
            signature === undefined
        ) {
            throw new Error("not a JWT");
        }

        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${header}.${payload}`);
        expect(
            verifier.verify(publicKey, Buffer.from(signature, "base64url")),
        ).toBe(true);

        const claims = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        ) as { iat: number; exp: number; iss: unknown };
        // GitHub requires an integer issuer: a string is rejected with
        // "'Issuer' claim ('iss') must be an Integer".
        expect(claims.iss).toBe(12345);
        expect(claims.exp - claims.iat).toBe(600);
        // GitHub rejects an iat in the future; a minute in the past is safe.
        expect(claims.iat).toBeLessThanOrEqual(Math.floor(now / 1000));
    });
});

describe("the installation token", () => {
    it("exchanges a signed JWT once and caches the result", async () => {
        const fetchImpl = vi.fn(async () =>
            json({ token: "ghs_secret", expires_at: "2026-10-20T13:00:00Z" }),
        );
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        const first = await client.installationToken();
        const second = await client.installationToken();

        expect(first.token).toBe("ghs_secret");
        expect(second).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe(
            "https://api.github.test/app/installations/67890/access_tokens",
        );
        expect(init.method).toBe("POST");
        const authorization = (init.headers as Record<string, string>)
            .authorization;
        const jwt = jwtPayload(authorization);
        expect(jwt.payload.iss).toBe(12345);
        // The installation token is what the response carried, never the JWT.
        expect(jwt.signature.length).toBeGreaterThan(0);
    });

    it("refreshes a token that is about to expire", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                json({ token: "first", expires_at: "2026-10-20T12:03:00Z" }),
            )
            .mockResolvedValueOnce(
                json({ token: "second", expires_at: "2026-10-20T13:00:00Z" }),
            );
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        expect((await client.installationToken()).token).toBe("first");
        // Three minutes left is inside the five-minute refresh margin.
        expect((await client.installationToken()).token).toBe("second");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe("repository and pull request calls", () => {
    it("reads the default branch and opens a pull request with the token", async () => {
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            if (url.endsWith("/repos/luke/app")) {
                return json({ default_branch: "trunk" });
            }
            if (url.endsWith("/repos/luke/app/pulls")) {
                expect(init.method).toBe("POST");
                expect(
                    (init.headers as Record<string, string>).authorization,
                ).toBe("Bearer ghs_secret");
                const body = JSON.parse(String(init.body)) as Record<
                    string,
                    string
                >;
                expect(body).toMatchObject({
                    title: "Add a greeting",
                    head: "jarvis/add-a-greeting-1234",
                    base: "trunk",
                });
                return json({
                    number: 42,
                    html_url: "https://github.com/luke/app/pull/42",
                });
            }
            throw new Error(`unexpected url ${url}`);
        });
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        expect(await client.defaultBranch("luke", "app")).toBe("trunk");
        const pr = await client.createPullRequest({
            owner: "luke",
            repo: "app",
            head: "jarvis/add-a-greeting-1234",
            base: "trunk",
            title: "Add a greeting",
            body: "the body",
        });
        expect(pr).toEqual({
            number: 42,
            url: "https://github.com/luke/app/pull/42",
        });
    });

    it("surfaces GitHub's message without the token", async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            return json({ message: "Validation Failed" }, 422);
        });
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        const failure = client.createPullRequest({
            owner: "luke",
            repo: "app",
            head: "jarvis/x",
            base: "main",
            title: "x",
            body: "x",
        });
        await expect(failure).rejects.toThrow(
            "GitHub /repos/luke/app/pulls failed: 422 Validation Failed",
        );
        await expect(failure).rejects.not.toThrow(/ghs_secret/);
    });
});

describe("reading a pull request", () => {
    /** A client whose fetch answers the PR, its two comment feeds, and a token. */
    function clientFor(pull: Record<string, unknown>): {
        client: ReturnType<typeof createGitHubClient>;
        urls: string[];
    } {
        const urls: string[] = [];
        const fetchImpl = vi.fn(async (url: string) => {
            urls.push(url);
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            if (url.endsWith("/graphql")) {
                return json({
                    data: {
                        repository: {
                            pullRequest: {
                                reviewThreads: { nodes: [] },
                            },
                        },
                    },
                });
            }
            if (url.includes("/pulls/7/comments")) {
                return json([
                    {
                        user: { login: "reviewer" },
                        body: "This line is wrong.",
                        path: "src/app.ts",
                        line: 42,
                        created_at: "2026-10-20T10:05:00Z",
                    },
                    {
                        user: { login: "second" },
                        body: "Also add a test.",
                        path: "src/app.ts",
                        original_line: 50,
                        created_at: "2026-10-20T10:07:00Z",
                    },
                ]);
            }
            if (url.includes("/issues/7/comments")) {
                return json([
                    {
                        user: { login: "luke" },
                        body: "Please address these.",
                        created_at: "2026-10-20T10:06:00Z",
                    },
                ]);
            }
            if (url.endsWith("/repos/luke/app/pulls/7")) {
                return json(pull);
            }
            throw new Error(`unexpected url ${url}`);
        });
        return {
            client: createGitHubClient(CONFIG, {
                fetch: fetchImpl as unknown as typeof fetch,
                now: () => Date.parse("2026-10-20T12:00:00Z"),
            }),
            urls,
        };
    }

    it("reads the PR, its branch and both comment feeds oldest first", async () => {
        const { client } = clientFor({
            html_url: "https://github.com/luke/app/pull/7",
            title: "Add a greeting",
            body: "The body",
            state: "open",
            merged: false,
            head: {
                ref: "jarvis/add-a-greeting",
                repo: { full_name: "luke/app" },
            },
            base: { ref: "main" },
        });

        const pull = await client.readPullRequest("luke", "app", 7);

        expect(pull).toMatchObject({
            owner: "luke",
            repo: "app",
            number: 7,
            url: "https://github.com/luke/app/pull/7",
            title: "Add a greeting",
            body: "The body",
            head: "jarvis/add-a-greeting",
            base: "main",
            state: "open",
            headRepo: "luke/app",
            commentsTruncated: false,
            conversationUnavailable: false,
        });
        // Review note at 10:05, conversation at 10:06, review note at 10:07.
        expect(pull.comments.map((comment) => comment.body)).toEqual([
            "This line is wrong.",
            "Please address these.",
            "Also add a test.",
        ]);
        expect(pull.comments[0]).toMatchObject({
            author: "reviewer",
            path: "src/app.ts",
            line: 42,
        });
        // A conversation message has no file.
        expect(pull.comments[1]?.path).toBeUndefined();
        // `original_line` covers a comment on an outdated diff hunk.
        expect(pull.comments[2]?.line).toBe(50);
    });

    it("reads the review notes even when the conversation is denied", async () => {
        // An App with Pull requests but not Issues can read inline notes and
        // should still be able to continue the review.
        const fetchImpl = vi.fn(async (url: string) => {
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            if (url.endsWith("/graphql")) {
                return json({
                    data: {
                        repository: {
                            pullRequest: {
                                reviewThreads: { nodes: [] },
                            },
                        },
                    },
                });
            }
            if (url.includes("/pulls/7/comments")) {
                return json([
                    {
                        user: { login: "reviewer" },
                        body: "Use a constant.",
                        path: "src/app.ts",
                        line: 3,
                        created_at: "2026-10-20T10:00:00Z",
                    },
                ]);
            }
            if (url.includes("/issues/7/comments")) {
                return json(
                    { message: "Resource not accessible by integration" },
                    403,
                );
            }
            if (url.endsWith("/repos/luke/app/pulls/7")) {
                return json({
                    html_url: "https://github.com/luke/app/pull/7",
                    title: "A change",
                    body: "",
                    state: "open",
                    merged: false,
                    head: { ref: "jarvis/x", repo: { full_name: "luke/app" } },
                    base: { ref: "main" },
                });
            }
            throw new Error(`unexpected url ${url}`);
        });
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        const pull = await client.readPullRequest("luke", "app", 7);

        expect(pull.comments.map((comment) => comment.body)).toEqual([
            "Use a constant.",
        ]);
        expect(pull.conversationUnavailable).toBe(true);
    });

    it("dates each comment and stamps the read", async () => {
        const { client } = clientFor({
            html_url: "https://github.com/luke/app/pull/7",
            title: "A change",
            body: "",
            state: "open",
            merged: false,
            head: { ref: "jarvis/x", repo: { full_name: "luke/app" } },
            base: { ref: "main" },
        });

        const pull = await client.readPullRequest("luke", "app", 7);

        expect(pull.comments[0]).toMatchObject({
            createdAt: "2026-10-20T10:05:00Z",
            updatedAt: "2026-10-20T10:05:00Z",
        });
        // The clock is injectable; the watermark is when the read finished.
        expect(pull.readAt).toBe("2026-10-20T12:00:00.000Z");
    });

    it("passes since to both comment feeds", async () => {
        const { client, urls } = clientFor({
            html_url: "https://github.com/luke/app/pull/7",
            title: "A change",
            body: "",
            state: "open",
            merged: false,
            head: { ref: "jarvis/x", repo: { full_name: "luke/app" } },
            base: { ref: "main" },
        });

        await client.readPullRequest("luke", "app", 7, {
            since: "2026-10-20T23:50:00Z",
        });

        const commentCalls = urls.filter(
            (url) =>
                url.includes("/pulls/7/comments") ||
                url.includes("/issues/7/comments"),
        );
        expect(commentCalls).toHaveLength(2);
        for (const url of commentCalls) {
            expect(url).toContain("since=2026-10-20T23%3A50%3A00Z");
        }
    });

    it("reports a merged PR and a fork's head repository", async () => {
        const { client } = clientFor({
            html_url: "https://github.com/luke/app/pull/7",
            title: "From a fork",
            body: "",
            state: "closed",
            merged: true,
            head: { ref: "topic", repo: { full_name: "someone/app" } },
            base: { ref: "main" },
        });

        const pull = await client.readPullRequest("luke", "app", 7);

        expect(pull.state).toBe("merged");
        expect(pull.headRepo).toBe("someone/app");
    });

    it("surfaces GitHub's message when the PR cannot be read", async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            return json({ message: "Not Found" }, 404);
        });
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        await expect(client.readPullRequest("luke", "app", 99)).rejects.toThrow(
            "GitHub /repos/luke/app/pulls/99 failed: 404 Not Found",
        );
    });
});

describe("issues", () => {
    /** A client over one router: token, one issue, a list, create, comment. */
    function clientFor(): {
        client: ReturnType<typeof createGitHubClient>;
        calls: Array<{ url: string; init: RequestInit }>;
    } {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            if (url.includes("/issues?state=open&per_page=20")) {
                return json([
                    {
                        number: 140,
                        html_url: "https://github.com/luke/app/issues/140",
                        title: "Work with the GitHub tracker",
                        body: "Read and comment.",
                        state: "open",
                        labels: [{ name: "enhancement" }, "server"],
                        user: { login: "luke" },
                        comments: 2,
                        created_at: "2026-10-19T10:00:00Z",
                    },
                    {
                        // The issues endpoint also returns pull requests; a
                        // backlog is about issues.
                        number: 141,
                        html_url: "https://github.com/luke/app/pull/141",
                        title: "A pull request",
                        state: "open",
                        pull_request: { url: "…" },
                    },
                ]);
            }
            if (url.endsWith("/issues/140") && init.method !== "POST") {
                return json({
                    number: 140,
                    html_url: "https://github.com/luke/app/issues/140",
                    title: "Work with the GitHub tracker",
                    body: "Read and comment.",
                    state: "open",
                    labels: [{ name: "enhancement" }, "server"],
                    user: { login: "luke" },
                    comments: 2,
                    created_at: "2026-10-19T10:00:00Z",
                });
            }
            if (
                url.endsWith("/issues/140/comments") &&
                init.method === "POST"
            ) {
                return json({
                    id: 987,
                    html_url:
                        "https://github.com/luke/app/issues/140#issuecomment-987",
                });
            }
            if (url.endsWith("/issues") && init.method === "POST") {
                return json({
                    number: 142,
                    html_url: "https://github.com/luke/app/issues/142",
                });
            }
            throw new Error(`unexpected url ${url} ${init.method ?? "GET"}`);
        });
        return {
            client: createGitHubClient(CONFIG, {
                fetch: fetchImpl as unknown as typeof fetch,
                now: () => Date.parse("2026-10-20T12:00:00Z"),
            }),
            calls,
        };
    }

    it("reads one issue with labels, author and state", async () => {
        const { client } = clientFor();

        const issue = await client.getIssue("luke", "app", 140);

        expect(issue).toEqual({
            number: 140,
            url: "https://github.com/luke/app/issues/140",
            title: "Work with the GitHub tracker",
            body: "Read and comment.",
            state: "open",
            labels: ["enhancement", "server"],
            author: "luke",
            pullRequest: false,
            commentCount: 2,
            createdAt: "2026-10-19T10:00:00Z",
        });
    });

    it("lists issues and filters the pull requests out", async () => {
        const { client, calls } = clientFor();

        const issues = await client.listIssues("luke", "app", {
            state: "open",
            limit: 20,
        });

        expect(issues.map((issue) => issue.number)).toEqual([140]);
        expect(issues[0]?.labels).toEqual(["enhancement", "server"]);
        const url = calls.find((call) => call.url.includes("/issues?"))?.url;
        expect(url).toContain("state=open");
        expect(url).toContain("per_page=20");
    });

    it("creates an issue with a JSON body", async () => {
        const { client, calls } = clientFor();

        const created = await client.createIssue("luke", "app", {
            title: "A bug",
            body: "It breaks.",
        });

        expect(created).toEqual({
            number: 142,
            url: "https://github.com/luke/app/issues/142",
        });
        const post = calls.find(
            (call) =>
                call.init.method === "POST" && call.url.endsWith("/issues"),
        );
        expect(JSON.parse(String(post?.init.body))).toEqual({
            title: "A bug",
            body: "It breaks.",
        });
    });

    it("comments on an issue and returns the comment URL", async () => {
        const { client, calls } = clientFor();

        const created = await client.commentOnIssue(
            "luke",
            "app",
            140,
            "On it.",
        );

        expect(created).toEqual({
            number: 987,
            url: "https://github.com/luke/app/issues/140#issuecomment-987",
        });
        const post = calls.find(
            (call) =>
                call.init.method === "POST" &&
                call.url.endsWith("/issues/140/comments"),
        );
        expect(JSON.parse(String(post?.init.body))).toEqual({ body: "On it." });
    });
});

describe("review requests", () => {
    it("posts the logins a review was requested from", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            return json({ requested_reviewers: [{ login: "luke" }] });
        });
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        await client.requestReviewers("luke", "app", 7, ["luke"]);

        const post = calls.find((call) =>
            call.url.includes("/requested_reviewers"),
        );
        expect(post?.url).toBe(
            "https://api.github.test/repos/luke/app/pulls/7/requested_reviewers",
        );
        expect(JSON.parse(String(post?.init.body))).toEqual({
            reviewers: ["luke"],
        });
    });

    it("does nothing when no login is given", async () => {
        const fetchImpl = vi.fn();
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
        });

        await client.requestReviewers("luke", "app", 7, []);

        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("resolved review threads", () => {
    /** A PR with one resolved note, one open note, and a GraphQL answer. */
    function clientForResolved(
        graphql: (init: RequestInit) => Response,
    ): ReturnType<typeof createGitHubClient> {
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            if (url.endsWith("/graphql")) {
                return graphql(init);
            }
            if (url.includes("/pulls/7/comments")) {
                return json([
                    {
                        id: 1,
                        html_url:
                            "https://github.com/luke/app/pull/7#discussion_r1",
                        user: { login: "reviewer" },
                        body: "Already fixed.",
                        path: "src/app.ts",
                        line: 1,
                        created_at: "2026-10-20T10:00:00Z",
                    },
                    {
                        id: 2,
                        html_url:
                            "https://github.com/luke/app/pull/7#discussion_r2",
                        user: { login: "reviewer" },
                        body: "Still open.",
                        path: "src/app.ts",
                        line: 2,
                        created_at: "2026-10-20T10:01:00Z",
                    },
                ]);
            }
            if (url.includes("/issues/7/comments")) {
                return json([]);
            }
            if (url.endsWith("/repos/luke/app/pulls/7")) {
                return json({
                    html_url: "https://github.com/luke/app/pull/7",
                    title: "A change",
                    body: "",
                    state: "open",
                    merged: false,
                    head: { ref: "jarvis/x", repo: { full_name: "luke/app" } },
                    base: { ref: "main" },
                });
            }
            throw new Error(`unexpected url ${url}`);
        });
        return createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });
    }

    /** A GraphQL body marking thread comment 1 resolved. */
    function threads(): Response {
        return json({
            data: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            nodes: [
                                {
                                    isResolved: true,
                                    comments: { nodes: [{ databaseId: 1 }] },
                                },
                                {
                                    isResolved: false,
                                    comments: { nodes: [{ databaseId: 2 }] },
                                },
                            ],
                        },
                    },
                },
            },
        });
    }

    it("hides resolved notes by default and counts them", async () => {
        const client = clientForResolved(() => threads());

        const pull = await client.readPullRequest("luke", "app", 7);

        expect(pull.comments.map((comment) => comment.body)).toEqual([
            "Still open.",
        ]);
        expect(pull.resolvedHidden).toBe(1);
        expect(pull.resolutionUnavailable).toBe(false);
    });

    it("shows and marks them when asked", async () => {
        const client = clientForResolved(() => threads());

        const pull = await client.readPullRequest("luke", "app", 7, {
            includeResolved: true,
        });

        expect(pull.comments.map((comment) => comment.body)).toEqual([
            "Already fixed.",
            "Still open.",
        ]);
        expect(pull.comments[0]?.resolved).toBe(true);
        expect(pull.comments[1]?.resolved).toBe(false);
        expect(pull.resolvedHidden).toBe(0);
    });

    it("shows everything when resolution cannot be read", async () => {
        const client = clientForResolved(() =>
            json({ message: "Resource not accessible" }, 403),
        );

        const pull = await client.readPullRequest("luke", "app", 7);

        expect(pull.comments).toHaveLength(2);
        expect(pull.resolvedHidden).toBe(0);
        expect(pull.resolutionUnavailable).toBe(true);
    });

    it("gives each comment its id and URL for a reply", async () => {
        const client = clientForResolved(() => threads());

        const pull = await client.readPullRequest("luke", "app", 7, {
            includeResolved: true,
        });

        expect(pull.comments[0]).toMatchObject({
            id: 1,
            url: "https://github.com/luke/app/pull/7#discussion_r1",
        });
    });
});
