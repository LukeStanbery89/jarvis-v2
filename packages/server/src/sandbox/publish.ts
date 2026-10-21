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
 */
import type { GitHubClient } from "../github/client";
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
    /** `collect`'s summary, so the pull request says what changed. */
    diffSummary: string;
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

/** The pull request title: the task's first line, prefixed. */
function titleFor(task: string): string {
    const firstLine = task.split("\n")[0]?.trim() ?? "";
    const subject = firstLine.length > 0 ? firstLine : "coding job";
    const room = MAX_TITLE_CHARS - "JARVIS: ".length;
    return `JARVIS: ${
        subject.length > room ? `${subject.slice(0, room - 1)}…` : subject
    }`;
}

/** The pull request body: what was asked, what changed, and which job. */
function bodyFor(input: PublishInput): string {
    const body = [
        "## Task",
        "",
        input.task.trim(),
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
        "installationToken" | "defaultBranch" | "createPullRequest"
    >;
    push(input: {
        workspacePath: string;
        branch: string;
        auth?: { username: string; token: string };
    }): Promise<void>;
}): JobPublisher {
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
            return { prUrl: created.url };
        },
    };
}
