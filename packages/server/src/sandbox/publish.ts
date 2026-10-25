/**
 * Publishing a finished coding job (#140).
 *
 * The workspace manager can push and the GitHub client can open a pull
 * request; this is the one place that decides the two belong together, and the
 * boundary the supervisor depends on. It stays a seam — the supervisor calls
 * `publish` and records the URL, without knowing that GitHub exists — so a
 * deployment with no App, or a future forge, changes nothing in the job's life.
 *
 * Only `https://github.com/…` is published. The credential is an installation
 * token and the transport is an HTTP header; an `ssh://` or `file://` remote
 * (the probe's scratch origin) is left alone, and the job keeps its workspace.
 *
 * A follow-up (`existing`) is the same operation minus the PR: push the branch
 * the open pull request already has, and let GitHub update that review.
 */
import type { CommentRef } from "../github/comment";
import { quotedReply } from "../github/comment";
import type { GitHubClient } from "../github/client";
import { logger } from "../logger";
import { parseRepoEntry } from "./workspace";

/** What the supervisor knows when a run has succeeded and changed something. */
export interface PublishInput {
    /** The job id, quoted in the pull request body. */
    jobId: string;
    /** The server-side clone that carries the branch. */
    workspacePath: string;
    /** The row's repository entry (`owner/name`, or a URL). */
    repo: string;
    /** The branch the run is on. */
    branch: string;
    /** The task the user gave, used as the title and the body's opening. */
    task: string;
    /**
     * The issue this job implements (#140).
     *
     * Present means the pull request body carries a standalone `Closes #n`,
     * so merging links and closes the issue the job was started from. A
     * follow-up push leaves the existing PR's body alone.
     */
    issueNumber?: number;
    /** `collect`'s summary, so the pull request says what changed. */
    diffSummary: string;
    /**
     * The plan the agent wrote (`.jarvis/plan.md`, #94), included in the PR
     * body so the reviewer sees the approach and not only the diff.
     */
    plan?: string | null;
    /**
     * The pull request this run continues (#140).
     *
     * Present means "push only": the branch already has a PR, so opening a
     * second one would split the review. The push updates it in place, and the
     * same URL comes back.
     */
    existing?: { url: string };
    /**
     * The comment this job answers (#140).
     *
     * Posted after the push: an inline review note gets a threaded reply, a
     * conversation comment gets a quoted one. Best-effort — the branch is the
     * work, and a failed reply must not fail the job.
     */
    reply?: { comment: CommentRef; body: string };
}

/** The supervisor's view of publishing. */
export interface JobPublisher {
    /**
     * Pushes the branch and opens a pull request.
     *
     * @returns The pull request URL, or `null` when this repository is not one
     * the publisher handles.
     * @throws When GitHub fails; the job still settles, and its ending says so.
     */
    publish(input: PublishInput): Promise<{ prUrl: string } | null>;
}

/** GitHub's title limit is 256; this leaves room for the prefix and an ellipsis. */
const MAX_TITLE_CHARS = 120;

/** GitHub's body limit is 65536; the diff summary is already bounded. */
const MAX_BODY_CHARS = 60_000;

/** A reply is a summary, not a second report. */
const MAX_REPLY_CHARS = 4_000;

/** The pull request title: the task's first line, prefixed. */
function titleFor(task: string): string {
    const firstLine = task.split("\n")[0]?.trim() ?? "";
    const subject = firstLine.length > 0 ? firstLine : "coding job";
    const room = MAX_TITLE_CHARS - "JARVIS: ".length;
    return `JARVIS: ${
        subject.length > room ? `${subject.slice(0, room - 1)}…` : subject
    }`;
}

/** The pull number in a GitHub pull request URL, or `null`. */
function pullNumber(url: string): number | null {
    const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
    if (match === null) {
        return null;
    }
    const number = Number(match[1]);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** The pull request body: what was asked, what changed, and which job. */
function bodyFor(input: PublishInput): string {
    const plan = input.plan?.trim() ?? "";
    const body = [
        "## Task",
        "",
        input.task.trim(),
        ...(input.issueNumber !== undefined
            ? ["", `Closes #${input.issueNumber}`]
            : []),
        ...(plan.length > 0 ? ["", "## Plan", "", plan] : []),
        "",
        "## Change",
        "",
        input.diffSummary.trim() || "(the run left no diff summary)",
        "",
        "---",
        `Opened by JARVIS from coding job \`${input.jobId}\` on branch \`${input.branch}\`.`,
    ].join("\n");
    return body.length > MAX_BODY_CHARS
        ? `${body.slice(0, MAX_BODY_CHARS - 1)}…`
        : body;
}

/**
 * Builds the GitHub publisher.
 *
 * @param options - The client and the push operation (the workspace manager's).
 * @returns The publisher the supervisor calls.
 */
export function createGitHubPublisher(options: {
    client: Pick<
        GitHubClient,
        | "installationToken"
        | "defaultBranch"
        | "createPullRequest"
        | "requestReviewers"
        | "getIssueComment"
        | "replyToReviewComment"
        | "commentOnIssue"
        | "reactToComment"
    >;
    push(input: {
        workspacePath: string;
        branch: string;
        auth?: { username: string; token: string };
    }): Promise<void>;
    /**
     * The login asked to review a published PR (`JARVIS_GITHUB_REVIEWER`).
     * Absent means the repository's owner — the human on a personal repo.
     */
    reviewer?: string;
}): JobPublisher {
    /**
     * Posts the job's summary as a reply to the comment it answers.
     *
     * Inline notes have a thread, so the reply lands under the note itself; a
     * conversation comment has none, so the original is quoted above the reply
     * to keep it attached. A failure is logged: the push already happened.
     *
     * @param repo - The repository.
     * @param number - The pull request number.
     * @param reply - The comment and the job's message, when there is one.
     */
    async function postReply(
        repo: { owner: string; name: string },
        number: number,
        reply: { comment: CommentRef; body: string } | undefined,
    ): Promise<void> {
        if (reply === undefined) {
            return;
        }
        const body =
            reply.body.trim().slice(0, MAX_REPLY_CHARS) ||
            "Addressed in the latest commit.";
        try {
            if (reply.comment.kind === "review") {
                await options.client.replyToReviewComment(
                    repo.owner,
                    repo.name,
                    number,
                    reply.comment.id,
                    body,
                );
                await options.client.reactToComment(
                    {
                        owner: repo.owner,
                        repo: repo.name,
                        kind: reply.comment.kind,
                        id: reply.comment.id,
                    },
                    "+1",
                );
                return;
            }
            const original = await options.client.getIssueComment(
                repo.owner,
                repo.name,
                reply.comment.id,
            );
            await options.client.commentOnIssue(
                repo.owner,
                repo.name,
                number,
                quotedReply(original.body, body),
            );
            await options.client.reactToComment(
                {
                    owner: repo.owner,
                    repo: repo.name,
                    kind: reply.comment.kind,
                    id: reply.comment.id,
                },
                "+1",
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(
                `could not reply to ${reply.comment.kind} comment ${reply.comment.id} on ${repo.owner}/${repo.name}#${number}: ${message}`,
            );
        }
    }

    /**
     * Asks the human to review, once the branch is on the remote.
     *
     * Best-effort by design: the push and the PR are the work, and a reviewer
     * request GitHub refuses (an org owner, a missing collaborator) is a
     * courtesy that failed, not a job that failed.
     */
    async function askForReview(
        repo: { owner: string; name: string },
        number: number,
    ): Promise<void> {
        const reviewer = options.reviewer ?? repo.owner;
        try {
            await options.client.requestReviewers(
                repo.owner,
                repo.name,
                number,
                [reviewer],
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(
                `could not request ${reviewer} as a reviewer for ${repo.owner}/${repo.name}#${number}: ${message}`,
            );
        }
    }

    return {
        async publish(input): Promise<{ prUrl: string } | null> {
            const repo = parseRepoEntry(input.repo);
            if (repo === null || !repo.url.startsWith("https://github.com/")) {
                return null;
            }

            const token = await options.client.installationToken();
            await options.push({
                workspacePath: input.workspacePath,
                branch: input.branch,
                auth: {
                    username: "x-access-token",
                    token: token.token,
                },
            });
            if (input.existing !== undefined) {
                // The PR already describes the work; this push is a new
                // commit on its branch, and GitHub updates the review itself.
                // Re-request the review so the human is told new work landed.
                const number = pullNumber(input.existing.url);
                if (number !== null) {
                    await askForReview(repo, number);
                    await postReply(repo, number, input.reply);
                }
                return { prUrl: input.existing.url };
            }
            const base = await options.client.defaultBranch(
                repo.owner,
                repo.name,
            );
            const created = await options.client.createPullRequest({
                owner: repo.owner,
                repo: repo.name,
                head: input.branch,
                base,
                title: titleFor(input.task),
                body: bodyFor(input),
            });
            await askForReview(repo, created.number);
            await postReply(repo, created.number, input.reply);
            return { prUrl: created.url };
        },
    };
}
