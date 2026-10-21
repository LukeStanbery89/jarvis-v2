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

/** What a caller needs from GitHub. */
export interface GitHubClient {
    /** A live installation token, cached until it is nearly expired. */
    installationToken(): Promise<InstallationToken>;
    /** The repository's default branch, which a pull request targets. */
    defaultBranch(owner: string, repo: string): Promise<string>;
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
        throw new Error("the GitHub App id must be numeric");
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
