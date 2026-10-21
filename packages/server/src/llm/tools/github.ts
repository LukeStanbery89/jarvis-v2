/**
 * GitHub tracker tools (#140): read an issue, list issues, file one, comment.
 *
 * These are the agent's half of the outbound surface. They hold no policy —
 * the client owns the REST shape, the allowlist decides which repositories may
 * be named, and the owner gate decides who may act as the App — because a
 * comment is a real message sent under JARVIS's identity, not a chat reply.
 *
 * The two write tools are the reason the gate is owner-only: a model that can
 * create issues and comment on pull requests can speak to collaborators, and
 * capability boundaries (#138) have not arrived yet. Reads use the same gate
 * for now — one rule is easier to reason about than "read is fine, write is
 * not", and the owner is the only account that runs coding jobs anyway.
 *
 * Every call threads the turn's abort signal into the client, so a cancelled
 * turn stops waiting on GitHub instead of draining to the client's timeout.
 */
import {
    tool,
    type StructuredToolInterface,
    type ToolRuntime,
} from "@langchain/core/tools";
import { z } from "zod";
import type {
    GitHubClient,
    IssueSnapshot,
    PullRequestSnapshot,
} from "../../github/client";
import { logger } from "../../logger";
import { requireSignedInUser } from "./metering";

/** The GitHub methods these tools call. */
export type GitHubToolsClient = Pick<
    GitHubClient,
    | "getIssue"
    | "readPullRequest"
    | "listIssues"
    | "createIssue"
    | "commentOnIssue"
>;

/** Everything the tools need, injected at wiring time. */
export interface GitHubToolDeps {
    /** The App-backed client. */
    client: GitHubToolsClient;
    /** The `owner/name` allowlist, shared with the coding sandbox. */
    repos: readonly string[];
    /** Whether this account may act as the App (#138's smallest slice). */
    isOwner(userId: number): boolean;
}

/** A repository the allowlist names. */
interface AllowedRepo {
    /** `owner/name`, as configured — what the model is told. */
    label: string;
    owner: string;
    name: string;
}

/** How much of an issue body a tool result carries. */
const MAX_BODY_CHARS = 4_000;

/** GitHub's title limit, kept here so a local error beats a round trip. */
const MAX_TITLE_CHARS = 256;

/** One comment's share of a rendered thread. */
const MAX_COMMENT_CHARS = 1_200;

/** The refusal a non-owner reads. */
const OWNER_ONLY = "GitHub actions can only be used by the owner account.";

/** The repo field every tool shares. */
const repoField = z
    .string()
    .min(1)
    .optional()
    .describe(
        "The repository as `owner/name`. Omit it when exactly one repository is configured; the tool answers with the allowlist when it cannot choose.",
    );

/** The number field every issue-addressed tool shares. */
const numberField = z.coerce
    .number()
    .int()
    .positive()
    .describe("The issue or pull request number.");

/**
 * Splits `owner/name`, refusing anything that is not one.
 *
 * @param entry - An allowlist entry.
 * @returns The parts, or `null`.
 */
function splitRepo(entry: string): AllowedRepo | null {
    const parts = entry.trim().split("/");
    if (parts.length !== 2) {
        return null;
    }
    const [owner, name] = parts;
    if (
        owner === undefined ||
        name === undefined ||
        !/^[A-Za-z0-9._-]+$/.test(owner) ||
        !/^[A-Za-z0-9._-]+$/.test(name)
    ) {
        return null;
    }
    return { label: `${owner}/${name}`, owner, name };
}

/** What resolving the `repo` argument produced. */
type RepoResolution =
    { ok: true; repo: AllowedRepo } | { ok: false; text: string };

/**
 * Resolves the tool's `repo` argument against the allowlist.
 *
 * @param value - What the model passed, if anything.
 * @param repos - The configured allowlist.
 * @returns The repository, or the sentence to answer with.
 */
function resolveRepo(
    value: string | undefined,
    repos: readonly string[],
): RepoResolution {
    const allowed = repos
        .map(splitRepo)
        .filter((repo): repo is AllowedRepo => repo !== null);
    const wanted = value?.trim();
    if (wanted === undefined || wanted.length === 0) {
        if (allowed.length === 1) {
            const only = allowed[0];
            if (only !== undefined) {
                return { ok: true, repo: only };
            }
        }
        return {
            ok: false,
            text:
                allowed.length === 0
                    ? "No repository is configured for GitHub, so there is nothing I can read or write."
                    : `Which repository? Allowed: ${allowed.map((repo) => repo.label).join(", ")}.`,
        };
    }
    const match = allowed.find(
        (repo) => repo.label.toLowerCase() === wanted.toLowerCase(),
    );
    if (match === undefined) {
        return {
            ok: false,
            text:
                allowed.length === 0
                    ? "No repository is configured for GitHub, so there is nothing I can read or write."
                    : `${wanted} is not configured for GitHub. Allowed: ${allowed
                          .map((repo) => repo.label)
                          .join(", ")}.`,
        };
    }
    return { ok: true, repo: match };
}

/**
 * Renders a failure so the model says something true.
 *
 * GitHub's own message is the useful part; a 403 from an App missing the
 * Issues permission says "Resource not accessible by integration", which is
 * opaque to a person, so the likely cause is appended. The token never appears
 * in a client error, so logging this is safe.
 *
 * @param err - What the client threw.
 * @returns Model-facing text.
 */
function failure(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`github tool failed: ${message}`);
    const hint = /not accessible by integration/i.test(message)
        ? " The GitHub App needs the Issues permission (read, plus write to create or comment)."
        : "";
    return `GitHub request failed: ${message}.${hint}`;
}

/** The turn's abort signal, when the runtime carries one. */
function signalOf(runtime: ToolRuntime): { signal?: AbortSignal } {
    return runtime.signal !== undefined ? { signal: runtime.signal } : {};
}

/**
 * Renders one issue for the model.
 *
 * @param issue - The issue.
 * @returns Text with the facts a task needs.
 */
export function renderIssue(issue: IssueSnapshot): string {
    const body = issue.body.trim();
    const lines = [
        `#${issue.number} ${issue.state} — ${issue.title.slice(0, MAX_TITLE_CHARS)}`,
        ...(issue.labels.length > 0
            ? [`labels: ${issue.labels.join(", ")}`]
            : []),
        issue.url,
        `opened by ${issue.author}${
            issue.createdAt.length > 0
                ? ` on ${issue.createdAt.slice(0, 10)}`
                : ""
        }${
            // On a pull request the issue endpoint's count is the
            // conversation only; a review lives elsewhere. Saying "0
            // comment(s)" there is how "address my comment" once became
            // "there is nothing to address".
            issue.pullRequest
                ? issue.commentCount > 0
                    ? `; ${issue.commentCount} conversation comment(s)`
                    : ""
                : `; ${issue.commentCount} comment(s)`
        }`,
    ];
    if (issue.pullRequest) {
        lines.push(
            "(This number is a pull request, not an issue; to continue its review, use startCodingJob with `pullRequest`.)",
        );
    }
    lines.push(
        "",
        body.length > MAX_BODY_CHARS
            ? `${body.slice(0, MAX_BODY_CHARS - 1)}…`
            : body || "(no description)",
    );
    return lines.join("\n");
}

/** Indents a comment so a multi-line body stays inside its list item. */
function quote(body: string): string {
    return body
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
}

/**
 * Renders a pull request's review notes and conversation under its issue text.
 *
 * The issue endpoint reports a PR's **conversation** count and nothing about
 * inline review notes, so a reader that stopped at `getIssue` would answer
 * "0 comments" while a review sat on the diff. The client already merges both
 * feeds; this is where they become model-facing text.
 *
 * @param issue - The issue fields.
 * @param pull - The PR, with its comments.
 * @returns The issue text plus the thread.
 */
export function renderPullRequest(
    issue: IssueSnapshot,
    pull: PullRequestSnapshot,
): string {
    const lines = [renderIssue(issue)];
    if (pull.comments.length === 0) {
        lines.push(
            "",
            pull.conversationUnavailable
                ? "(The conversation could not be read, and there are no inline review notes.)"
                : "No review comments or conversation yet.",
        );
        return lines.join("\n");
    }
    lines.push("", "## Review comments and conversation", "");
    for (const comment of pull.comments) {
        const where =
            comment.path === undefined
                ? "conversation"
                : `${comment.path}${
                      comment.line === undefined ? "" : `:${comment.line}`
                  }`;
        const body = comment.body.trim();
        lines.push(
            `- @${comment.author} on ${where}:`,
            quote(
                body.length > MAX_COMMENT_CHARS
                    ? `${body.slice(0, MAX_COMMENT_CHARS - 1)}…`
                    : body,
            ),
            "",
        );
    }
    if (pull.commentsTruncated) {
        lines.push("(Only the most recent comments are shown.)", "");
    }
    return lines.join("\n");
}

/**
 * Renders an issue list.
 *
 * @param issues - What the client returned.
 * @param label - The repository the list came from.
 * @returns One line per issue.
 */
export function renderIssues(
    issues: readonly IssueSnapshot[],
    label: string,
): string {
    if (issues.length === 0) {
        return `No issues matched in ${label}.`;
    }
    const lines = issues.map((issue) => {
        const labels =
            issue.labels.length > 0
                ? ` — labels: ${issue.labels.join(", ")}`
                : "";
        return `#${issue.number} ${issue.title}${labels}`;
    });
    return [`${issues.length} issue(s) in ${label}:`, ...lines].join("\n");
}

/**
 * Builds the four GitHub tools.
 *
 * @param deps - The client, the allowlist and the owner gate.
 * @returns The tools, in registration order.
 */
export function createGitHubTools(
    deps: GitHubToolDeps,
): StructuredToolInterface[] {
    return [
        tool(
            async (input, runtime: ToolRuntime) => {
                const gate = requireSignedInUser(runtime, {
                    subject: "GitHub",
                    logName: "getGitHubIssue",
                });
                if (!gate.ok) {
                    return gate.text;
                }
                if (!deps.isOwner(gate.userId)) {
                    return OWNER_ONLY;
                }
                const resolved = resolveRepo(input.repo, deps.repos);
                if (!resolved.ok) {
                    return resolved.text;
                }
                try {
                    const issue = await deps.client.getIssue(
                        resolved.repo.owner,
                        resolved.repo.name,
                        input.number,
                        signalOf(runtime),
                    );
                    if (!issue.pullRequest) {
                        return renderIssue(issue);
                    }
                    // A review lives on the pulls endpoints, not in the issue
                    // object: without this read, "address my comment" gets
                    // answered with the issue's (conversation-only) count.
                    try {
                        const pull = await deps.client.readPullRequest(
                            resolved.repo.owner,
                            resolved.repo.name,
                            issue.number,
                            signalOf(runtime),
                        );
                        return renderPullRequest(issue, pull);
                    } catch (err) {
                        const message =
                            err instanceof Error ? err.message : String(err);
                        logger.warn(
                            `github tool: could not read pull request #${issue.number}: ${message}`,
                        );
                        return `${renderIssue(issue)}\n\n(Review comments could not be read: ${message})`;
                    }
                } catch (err) {
                    return failure(err);
                }
            },
            {
                name: "getGitHubIssue",
                description:
                    "Read one GitHub issue or pull request by number — title, state, labels, description and URL, plus a pull request's review comments and conversation. " +
                    "Use it when the user names an issue, for example to implement or summarise it. " +
                    "To act on a pull request's review, use startCodingJob with `pullRequest` instead.",
                schema: z.object({
                    repo: repoField,
                    number: numberField,
                }),
            },
        ),
        tool(
            async (input, runtime: ToolRuntime) => {
                const gate = requireSignedInUser(runtime, {
                    subject: "GitHub",
                    logName: "listGitHubIssues",
                });
                if (!gate.ok) {
                    return gate.text;
                }
                if (!deps.isOwner(gate.userId)) {
                    return OWNER_ONLY;
                }
                const resolved = resolveRepo(input.repo, deps.repos);
                if (!resolved.ok) {
                    return resolved.text;
                }
                try {
                    const issues = await deps.client.listIssues(
                        resolved.repo.owner,
                        resolved.repo.name,
                        {
                            state: input.state ?? "open",
                            limit: input.limit ?? 20,
                            ...(input.labels !== undefined
                                ? { labels: input.labels }
                                : {}),
                        },
                        signalOf(runtime),
                    );
                    return renderIssues(issues, resolved.repo.label);
                } catch (err) {
                    return failure(err);
                }
            },
            {
                name: "listGitHubIssues",
                description:
                    "List a repository's issues (not pull requests), newest first, with their labels. " +
                    "Use it when the user asks what is open, what to work on, or which issues exist.",
                schema: z.object({
                    repo: repoField,
                    state: z
                        .enum(["open", "closed", "all"])
                        .optional()
                        .describe("Which issues to list; `open` by default."),
                    labels: z
                        .string()
                        .min(1)
                        .optional()
                        .describe("Comma-separated label names to filter by."),
                    limit: z.coerce
                        .number()
                        .int()
                        .min(1)
                        .max(50)
                        .optional()
                        .describe("How many to return; 20 by default."),
                }),
            },
        ),
        tool(
            async (input, runtime: ToolRuntime) => {
                const gate = requireSignedInUser(runtime, {
                    subject: "GitHub",
                    logName: "createGitHubIssue",
                });
                if (!gate.ok) {
                    return gate.text;
                }
                if (!deps.isOwner(gate.userId)) {
                    return OWNER_ONLY;
                }
                const resolved = resolveRepo(input.repo, deps.repos);
                if (!resolved.ok) {
                    return resolved.text;
                }
                try {
                    const created = await deps.client.createIssue(
                        resolved.repo.owner,
                        resolved.repo.name,
                        {
                            title: input.title,
                            ...(input.body !== undefined
                                ? { body: input.body }
                                : {}),
                        },
                        signalOf(runtime),
                    );
                    return `Created issue #${created.number}: ${created.url}`;
                } catch (err) {
                    return failure(err);
                }
            },
            {
                name: "createGitHubIssue",
                description:
                    "Create a new GitHub issue in the repository. " +
                    "Use only when the user asks to file, open, or report an issue — not to record your own progress.",
                schema: z.object({
                    repo: repoField,
                    title: z
                        .string()
                        .min(1)
                        .max(MAX_TITLE_CHARS)
                        .describe("The issue title."),
                    body: z
                        .string()
                        .optional()
                        .describe("The issue description, in Markdown."),
                }),
            },
        ),
        tool(
            async (input, runtime: ToolRuntime) => {
                const gate = requireSignedInUser(runtime, {
                    subject: "GitHub",
                    logName: "commentOnGitHub",
                });
                if (!gate.ok) {
                    return gate.text;
                }
                if (!deps.isOwner(gate.userId)) {
                    return OWNER_ONLY;
                }
                const resolved = resolveRepo(input.repo, deps.repos);
                if (!resolved.ok) {
                    return resolved.text;
                }
                try {
                    const created = await deps.client.commentOnIssue(
                        resolved.repo.owner,
                        resolved.repo.name,
                        input.number,
                        input.body,
                        signalOf(runtime),
                    );
                    return `Commented on #${input.number}: ${created.url}`;
                } catch (err) {
                    return failure(err);
                }
            },
            {
                name: "commentOnGitHub",
                description:
                    "Comment on a GitHub issue or pull request. " +
                    "Use only when the user asks you to post something there; never comment to report your own progress.",
                schema: z.object({
                    repo: repoField,
                    number: numberField,
                    body: z
                        .string()
                        .min(1)
                        .describe("The comment, in Markdown."),
                }),
            },
        ),
    ];
}
