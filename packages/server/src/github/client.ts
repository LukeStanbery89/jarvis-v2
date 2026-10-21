/**
 * The GitHub side of a coding job (#140).
 *
 * The App holds the permission; the server asks it for a short-lived
 * installation token when a job is ready to publish, and that token is used
 * only on the host — to push the finished branch and open one pull request.
 * Nothing here touches a job container, and nothing here is stored on a row.
 *
 * Two properties matter more than the API surface:
 *
 *  - the token is **cached** until shortly before it expires, because a push
 *    and a pull-request call share one credential and GitHub rate-limits the
 *    token exchange;
 *  - no error ever carries the token. GitHub's own `message` is the useful
 *    part, so that is what an error quotes.
 */
import { createSign } from "node:crypto";
import type { GitHubConfig } from "../config";

/** One installation token and when GitHub stops accepting it. */
export interface InstallationToken {
    readonly token: string;
    /** ISO-8601, as GitHub reports it. */
    readonly expiresAt: string;
}

/** The pull request a job produced. */
export interface CreatedPullRequest {
    readonly number: number;
    /** The browser URL (`html_url`). */
    readonly url: string;
}

/** One review comment or conversation message on a pull request. */
export interface PullRequestComment {
    /** The GitHub login, or `ghost` for a deleted account (as GitHub reports it). */
    readonly author: string;
    readonly body: string;
    /** The file a review comment is attached to; absent for conversation. */
    readonly path?: string;
    /** The line in that file, when GitHub reports one. */
    readonly line?: number;
}

/** A pull request as a follow-up job needs it (#140). */
export interface PullRequestSnapshot {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    /** The browser URL (`html_url`). */
    readonly url: string;
    readonly title: string;
    readonly body: string;
    /** The branch the pull request is from — the branch a follow-up works on. */
    readonly head: string;
    /** The branch it targets. */
    readonly base: string;
    readonly state: "open" | "closed" | "merged";
    /** `owner/name` of the head branch's repository (the fork, for a fork PR). */
    readonly headRepo: string | null;
    /** Newest last, capped — long discussions would not fit a job's prompt. */
    readonly comments: readonly PullRequestComment[];
    /** True when older comments were left out. */
    readonly commentsTruncated: boolean;
    /**
     * True when the conversation could not be read.
     *
     * Inline review notes are covered by the Pull requests permission, the
     * conversation by Issues. An App granted the former but not the latter
     * should still be able to continue a review; the prompt says the thread is
     * missing rather than implying the reviewers said nothing.
     */
    readonly conversationUnavailable: boolean;
}

/** What a caller needs from GitHub. */
export interface GitHubClient {
    /** A live installation token, cached until it is nearly expired. */
    installationToken(): Promise<InstallationToken>;
    /** The repository's default branch, which a pull request targets. */
    defaultBranch(owner: string, repo: string): Promise<string>;
    /**
     * Reads one pull request with the conversation a follow-up job needs.
     *
     * @throws When GitHub answers 404/403 or an unexpected shape.
     */
    readPullRequest(
        owner: string,
        repo: string,
        number: number,
    ): Promise<PullRequestSnapshot>;
    /** Opens a pull request and returns it. */
    createPullRequest(input: {
        owner: string;
        repo: string;
        head: string;
        base: string;
        title: string;
        body: string;
    }): Promise<CreatedPullRequest>;
}

/** How many comments a follow-up's prompt carries: the newest are the point. */
const MAX_PR_COMMENTS = 40;

/** Refresh a token this long before GitHub expires it. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** A slow GitHub is still a job that can finish without a PR. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Base64url, the only encoding a JWT accepts. */
function base64url(value: string | Buffer): string {
    return Buffer.from(value).toString("base64url");
}

/**
 * Signs the App's JWT.
 *
 * GitHub wants `iat` slightly in the past (clock skew is real) and `exp` no
 * more than ten minutes ahead; nine is used here.
 *
 * @param appId - The App's numeric id.
 * @param privateKey - Its PEM key.
 * @param nowMs - The current time.
 * @returns The signed assertion.
 */
export function signAppJwt(
    appId: string,
    privateKey: string,
    nowMs: number,
): string {
    // GitHub rejects a string issuer ("'Issuer' claim ('iss') must be an
    // Integer"), even though the App id arrives from the environment as text.
    const issuer = Number(appId);
    if (!Number.isFinite(issuer)) {
        throw new Error(
            "the GitHub App id must be numeric (use the App ID, not its name)",
        );
    }
    const issuedAt = Math.floor(nowMs / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(
        JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: issuer }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
}

/** One raw comment, defensively read. */
interface RawComment {
    readonly at: string;
    readonly comment: PullRequestComment;
}

/**
 * Normalizes the two comment endpoints into one newest-last list.
 *
 * The list is capped from the **old** end: a long discussion's last few
 * comments are the ones a follow-up is answering, and a prompt cannot carry a
 * hundred threads. `commentsTruncated` tells the caller that something was
 * left out, so the task can say so rather than implying a complete record.
 *
 * @param review - `pulls/{n}/comments` (inline notes).
 * @param conversation - `issues/{n}/comments` (the thread).
 * @returns The capped comments and the truncation flag.
 */
function commentsFrom(
    review: readonly unknown[],
    conversation: readonly unknown[],
): { comments: PullRequestComment[]; commentsTruncated: boolean } {
    const rows: RawComment[] = [];
    const collect = (raw: readonly unknown[], inline: boolean): void => {
        for (const entry of raw) {
            if (typeof entry !== "object" || entry === null) {
                continue;
            }
            const value = entry as {
                user?: { login?: unknown };
                body?: unknown;
                path?: unknown;
                line?: unknown;
                original_line?: unknown;
                created_at?: unknown;
            };
            if (
                typeof value.body !== "string" ||
                value.body.trim().length === 0
            ) {
                continue;
            }
            const author =
                typeof value.user?.login === "string"
                    ? value.user.login
                    : "ghost";
            const path =
                inline && typeof value.path === "string"
                    ? value.path
                    : undefined;
            const rawLine = value.line ?? value.original_line;
            const line =
                typeof rawLine === "number" && Number.isFinite(rawLine)
                    ? rawLine
                    : undefined;
            rows.push({
                at:
                    typeof value.created_at === "string"
                        ? value.created_at
                        : "",
                comment: {
                    author,
                    body: value.body,
                    ...(path !== undefined ? { path } : {}),
                    ...(line !== undefined ? { line } : {}),
                },
            });
        }
    };
    collect(review, true);
    collect(conversation, false);
    // `created_at` is ISO-8601, so lexical order is chronological; a missing
    // timestamp sorts before dated ones rather than displacing them.
    rows.sort((left, right) => left.at.localeCompare(right.at));
    const comments = rows.slice(-MAX_PR_COMMENTS).map((row) => row.comment);
    return {
        comments,
        commentsTruncated: rows.length > comments.length,
    };
}

/**
 * Builds the client.
 *
 * @param config - The App id, key, installation and API host.
 * @param options - A fetch implementation and clock (tests replace both).
 * @returns The client.
 */
export function createGitHubClient(
    config: GitHubConfig,
    options: { fetch?: typeof fetch; now?: () => number } = {},
): GitHubClient {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? (() => Date.now());
    let cached: InstallationToken | null = null;

    /** One REST call, with GitHub's message surfaced and the token kept out. */
    async function api<T>(
        path: string,
        init: { method?: string; token?: string; body?: unknown },
    ): Promise<T> {
        const headers: Record<string, string> = {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
        };
        if (init.token !== undefined) {
            headers.authorization = `Bearer ${init.token}`;
        }
        if (init.body !== undefined) {
            headers["content-type"] = "application/json";
        }
        const response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
            method: init.method ?? "GET",
            headers,
            ...(init.body !== undefined
                ? { body: JSON.stringify(init.body) }
                : {}),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            let detail = text.slice(0, 300);
            try {
                const parsed = JSON.parse(text) as { message?: unknown };
                if (typeof parsed.message === "string") {
                    detail = parsed.message;
                }
            } catch {
                // A non-JSON body is still a useful detail as text.
            }
            throw new Error(
                `GitHub ${path} failed: ${response.status}${detail.length > 0 ? ` ${detail}` : ""}`,
            );
        }
        return (await response.json()) as T;
    }

    const installationToken = async (): Promise<InstallationToken> => {
        if (
            cached !== null &&
            Date.parse(cached.expiresAt) - now() > REFRESH_MARGIN_MS
        ) {
            return cached;
        }
        const jwt = signAppJwt(config.appId, config.privateKey, now());
        const issued = await api<{ token: string; expires_at: string }>(
            `/app/installations/${config.installationId}/access_tokens`,
            { method: "POST", token: jwt },
        );
        cached = { token: issued.token, expiresAt: issued.expires_at };
        return cached;
    };

    return {
        installationToken,

        async readPullRequest(
            owner: string,
            repo: string,
            number: number,
        ): Promise<PullRequestSnapshot> {
            const token = await installationToken();
            const pull = await api<{
                html_url?: unknown;
                title?: unknown;
                body?: unknown;
                state?: unknown;
                merged?: unknown;
                head?: { ref?: unknown; repo?: { full_name?: unknown } | null };
                base?: { ref?: unknown };
            }>(`/repos/${owner}/${repo}/pulls/${number}`, {
                token: token.token,
            });
            if (
                typeof pull.html_url !== "string" ||
                typeof pull.title !== "string" ||
                typeof pull.head?.ref !== "string" ||
                typeof pull.base?.ref !== "string"
            ) {
                throw new Error(
                    `GitHub returned an unexpected pull request shape for #${number}`,
                );
            }
            // Review notes and conversation are two endpoints with one
            // meaning to the person reading them; a follow-up wants both.
            // The conversation is best-effort: it is governed by the Issues
            // permission, and an App with only Pull requests access would
            // otherwise be unable to continue any review at all.
            const review = await api<unknown[]>(
                `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
                { token: token.token },
            );
            const conversation = await api<unknown[]>(
                `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
                { token: token.token },
            ).catch(() => null);
            const merged = pull.merged === true;
            const state = merged
                ? "merged"
                : pull.state === "open"
                  ? "open"
                  : "closed";
            const headRepo =
                typeof pull.head.repo?.full_name === "string"
                    ? pull.head.repo.full_name
                    : null;
            return {
                owner,
                repo,
                number,
                url: pull.html_url,
                title: pull.title,
                body: typeof pull.body === "string" ? pull.body : "",
                head: pull.head.ref,
                base: pull.base.ref,
                state,
                headRepo,
                ...commentsFrom(review, conversation ?? []),
                conversationUnavailable: conversation === null,
            };
        },

        async defaultBranch(owner: string, repo: string): Promise<string> {
            const token = await installationToken();
            const repository = await api<{ default_branch?: unknown }>(
                `/repos/${owner}/${repo}`,
                { token: token.token },
            );
            return typeof repository.default_branch === "string"
                ? repository.default_branch
                : "main";
        },

        async createPullRequest(input): Promise<CreatedPullRequest> {
            const token = await installationToken();
            const created = await api<{ number?: unknown; html_url?: unknown }>(
                `/repos/${input.owner}/${input.repo}/pulls`,
                {
                    method: "POST",
                    token: token.token,
                    body: {
                        title: input.title,
                        head: input.head,
                        base: input.base,
                        body: input.body,
                    },
                },
            );
            if (
                typeof created.number !== "number" ||
                typeof created.html_url !== "string"
            ) {
                throw new Error(
                    "GitHub created a pull request but returned no url",
                );
            }
            return { number: created.number, url: created.html_url };
        },
    };
}
