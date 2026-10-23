/**
 * The coding watch (#94): the re-arm half of the SDLC loop.
 *
 * A job that needs answers parks itself (`awaiting-answer`) and its questions
 * are posted on the issue. This module is what notices a human answered, and
 * what notices a human reviewed a pull request JARVIS opened — or commented on
 * the issue that started it, which is where people often write follow-up
 * feedback. It turns either into a follow-up run through the same service the
 * chat tools use — no second implementation of "can this job run".
 *
 * One in-process interval, an overlap guard, and a per-tick cap. Every GitHub
 * read is per awaiting job or per JARVIS PR, and comments by the App itself
 * (its questions, replies, and PR bodies) are never treated as input.
 */
import type { AppCodingJob, CodingJobLedger } from "@lukestanbery/jarvis-auth";
import { parseCommentRef } from "../github/comment";
import type {
    GitHubClient,
    IssueComment,
    PullRequestComment,
} from "../github/client";
import { logger } from "../logger";
import type { CodingJobService } from "./service";

/** How many jobs one tick examines. */
const DEFAULT_LIMIT = 20;

/** How long after boot the first tick runs, so the server is settled. */
const FIRST_TICK_MS = 5_000;

/** The most issue feedback one follow-up prompt carries. */
const MAX_ISSUE_FEEDBACK_CHARS = 4_000;

/** The seams the watcher needs; a test supplies fakes for all three. */
export interface CodingWatchOptions {
    ledger: Pick<
        CodingJobLedger,
        "listAwaitingCodingJobs" | "listCodingJobsWithPr"
    >;
    github: Pick<
        GitHubClient,
        | "botLogin"
        | "readIssueComments"
        | "readPullRequest"
        | "getIssue"
        | "getIssueComment"
        | "reactToComment"
    >;
    service: Pick<CodingJobService, "resume" | "start" | "stop">;
    /** How often to poll. */
    intervalMs: number;
    /** Jobs per tick (default 20). */
    limit?: number;
}

/** A running watcher; `tick` is exposed for tests. */
export interface CodingWatch {
    stop(): void;
    tick(): Promise<void>;
}

/**
 * The repo's two halves, or `null` when the row is malformed.
 *
 * @param repo - `owner/name`.
 * @returns The parts.
 */
function repoParts(repo: string): { owner: string; name: string } | null {
    const [owner, name] = repo.split("/");
    return owner !== undefined && name !== undefined && owner.length > 0
        ? { owner, name }
        : null;
}

/**
 * The pull request number in a browser URL.
 *
 * @param url - `https://github.com/owner/name/pull/9`.
 * @returns The number, or `null`.
 */
export function pullNumberFromUrl(url: string): number | null {
    const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
    if (match === null) {
        return null;
    }
    const number = Number(match[1]);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Whether a comment is JARVIS's own, rather than a person's.
 *
 * Both checks matter: the author catches questions/replies the App posted, and
 * the marker catches a deployment whose installation login differs from the
 * one the row was created under.
 *
 * @param comment - The comment.
 * @param bot - The App installation's login.
 * @returns True when the watcher should ignore it.
 */
function isJarvis(
    comment:
        | Pick<IssueComment, "author" | "body">
        | Pick<PullRequestComment, "author" | "body">,
    bot: string,
): boolean {
    return comment.author === bot || comment.body.includes("<!-- jarvis:");
}

/**
 * Starts the watcher.
 *
 * @param options - The repo, GitHub, the service and the cadence.
 * @returns The running watcher; `stop` clears both timers.
 */
export function startCodingWatch(options: CodingWatchOptions): CodingWatch {
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    let running = false;
    let stopped = false;

    /**
     * Answers on an awaiting job's issue.
     *
     * @param bot - The App's login.
     */
    async function watchIssues(bot: string): Promise<void> {
        for (const job of options.ledger.listAwaitingCodingJobs(limit)) {
            if (job.issueNumber === null || job.questionCommentId === null) {
                continue;
            }
            const parts = repoParts(job.repo);
            if (parts === null) {
                continue;
            }
            try {
                const issue = await options.github.getIssue(
                    parts.owner,
                    parts.name,
                    job.issueNumber,
                );
                if (issue.state !== "open") {
                    // The user closed the issue: there is nothing left to
                    // continue, and the parked workspace is not a promise.
                    await options.service.stop(job.userId, job.id);
                    logger.info(
                        `coding watch: issue #${job.issueNumber} closed; cancelled parked job ${job.id}`,
                    );
                    continue;
                }
                const comments = await options.github.readIssueComments(
                    parts.owner,
                    parts.name,
                    job.issueNumber,
                    { since: job.startedAt ?? job.createdAt },
                );
                const answers = comments.filter(
                    (comment) =>
                        comment.id > (job.lastSeenCommentId ?? 0) &&
                        !isJarvis(comment, bot),
                );
                if (answers.length === 0) {
                    continue;
                }
                // The answer often reads "Postgres" without restating the
                // question; give the resumed agent both halves.
                const question = await options.github
                    .getIssueComment(
                        parts.owner,
                        parts.name,
                        job.questionCommentId,
                    )
                    .catch(() => null);
                const text = [
                    question === null
                        ? ""
                        : `Questions I asked:\n${question.body}`,
                    `Answers:\n${answers
                        .map((answer) => answer.body.trim())
                        .filter((body) => body.length > 0)
                        .join("\n\n")}`,
                ]
                    .filter((part) => part.length > 0)
                    .join("\n\n");
                const seen = Math.max(...answers.map((answer) => answer.id));
                const resumed = await options.service.resume(
                    job.userId,
                    job.id,
                    text,
                    { lastSeenCommentId: seen },
                );
                if (resumed.ok) {
                    logger.info(
                        `coding watch: resumed job ${job.id} from issue #${job.issueNumber}`,
                    );
                } else {
                    logger.warn(
                        `coding watch: could not resume job ${job.id}: ${resumed.reason}`,
                    );
                }
            } catch (err) {
                logger.warn(
                    `coding watch: issue #${job.issueNumber} failed: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
    }

    /**
     * New human feedback on a PR JARVIS opened.
     *
     * The pull request is the work, but the issue that started it is often
     * where the person writes the follow-up; both are read, and either starts
     * the same kind of follow-up (#94). A follow-up row may not carry the
     * originating issue, so it is recovered from an earlier row for the same
     * PR; the issue is then recorded on the new row so its questions are
     * posted there and `watchIssues` can resume it.
     *
     * @param bot - The App's login.
     */
    async function watchPulls(bot: string): Promise<void> {
        // Newest first: the first row per URL is the latest attempt, with the
        // state and watermark to use. An earlier row for the same PR still
        // knows the issue the whole conversation started on.
        const byPr = new Map<
            string,
            { job: AppCodingJob; issueNumber: number | null }
        >();
        for (const job of options.ledger.listCodingJobsWithPr(limit)) {
            if (job.prUrl === null) {
                continue;
            }
            const known = byPr.get(job.prUrl);
            if (known === undefined) {
                byPr.set(job.prUrl, {
                    job,
                    issueNumber: job.issueNumber,
                });
            } else if (known.issueNumber === null && job.issueNumber !== null) {
                known.issueNumber = job.issueNumber;
            }
        }
        for (const { job, issueNumber } of byPr.values()) {
            if (job.prUrl === null) {
                continue;
            }
            if (job.state === "running" || job.state === "awaiting-answer") {
                continue;
            }
            const parts = repoParts(job.repo);
            const number = pullNumberFromUrl(job.prUrl);
            if (parts === null || number === null) {
                continue;
            }
            try {
                const pull = await options.github.readPullRequest(
                    parts.owner,
                    parts.name,
                    number,
                );
                if (pull.state !== "open") {
                    continue;
                }
                const human = pull.comments.filter(
                    (comment) =>
                        !comment.resolved &&
                        comment.id > (job.lastSeenCommentId ?? 0) &&
                        !isJarvis(comment, bot),
                );
                // The issue is the other home of the conversation. A failure
                // to read it must not hide the pull request's own comments.
                const since = job.startedAt ?? job.createdAt;
                const sinceMs = Date.parse(since);
                let fromIssue: IssueComment[] = [];
                if (issueNumber !== null && !Number.isNaN(sinceMs)) {
                    try {
                        fromIssue = (
                            await options.github.readIssueComments(
                                parts.owner,
                                parts.name,
                                issueNumber,
                                { since },
                            )
                        ).filter(
                            (comment) =>
                                !isJarvis(comment, bot) &&
                                Date.parse(comment.createdAt) > sinceMs,
                        );
                    } catch (err) {
                        logger.warn(
                            `coding watch: issue #${issueNumber} comments failed: ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        );
                    }
                }
                if (human.length === 0 && fromIssue.length === 0) {
                    continue;
                }
                // The newest note, on either surface, is what the final
                // message answers; the publisher reads its body by id.
                const latest = [...human, ...fromIssue].reduce((a, b) =>
                    Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a,
                );
                const reply = parseCommentRef(latest.url);
                const issueWhere =
                    issueNumber === null
                        ? "the issue"
                        : `issue #${issueNumber}`;
                const issueText = fromIssue
                    .map((comment) => {
                        const body = comment.body.trim();
                        return `@${comment.author} wrote:\n\n${
                            body.length > MAX_ISSUE_FEEDBACK_CHARS
                                ? `${body.slice(0, MAX_ISSUE_FEEDBACK_CHARS - 1)}…`
                                : body
                        }`;
                    })
                    .join("\n\n");
                const task = [
                    "Address the new review feedback on this pull request.",
                    ...(issueText.length > 0
                        ? [`Feedback from ${issueWhere}:\n\n${issueText}`]
                        : []),
                ].join("\n\n");
                const started = await options.service.start({
                    userId: job.userId,
                    repo: job.repo,
                    task,
                    pullRequest: number,
                    ...(issueNumber !== null
                        ? { issueForQuestions: issueNumber }
                        : {}),
                    ...(reply !== null ? { replyTo: reply } : {}),
                });
                if (started.ok) {
                    logger.info(
                        `coding watch: started follow-up ${started.job.id} for PR #${number}` +
                            (issueNumber === null
                                ? ""
                                : ` (issue #${issueNumber})`),
                    );
                    if (reply !== null) {
                        await options.github
                            .reactToComment(
                                {
                                    owner: parts.owner,
                                    repo: parts.name,
                                    kind: reply.kind,
                                    id: reply.id,
                                },
                                "eyes",
                            )
                            .catch((err: unknown) => {
                                logger.warn(
                                    `coding watch: could not react to ${reply.kind} comment ${reply.id}: ${
                                        err instanceof Error
                                            ? err.message
                                            : String(err)
                                    }`,
                                );
                            });
                    }
                } else {
                    logger.warn(
                        `coding watch: could not follow up on PR #${number}: ${started.reason}`,
                    );
                }
            } catch (err) {
                logger.warn(
                    `coding watch: PR #${number} failed: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
    }

    /**
     * One pass: issue answers, then PR feedback. A failure in one job never
     * stops the rest.
     */
    async function tick(): Promise<void> {
        if (running || stopped) {
            return;
        }
        running = true;
        try {
            const bot = await options.github
                .botLogin()
                .catch((err: unknown) => {
                    logger.warn(
                        `coding watch: could not read the App login: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                    return null;
                });
            if (bot === null) {
                return;
            }
            await watchIssues(bot);
            await watchPulls(bot);
        } finally {
            running = false;
        }
    }

    const timer = setInterval(
        () => {
            void tick();
        },
        Math.max(1_000, options.intervalMs),
    );
    timer.unref?.();
    const first = setTimeout(
        () => {
            void tick();
        },
        Math.min(FIRST_TICK_MS, Math.max(1_000, options.intervalMs)),
    );
    first.unref?.();

    return {
        stop(): void {
            stopped = true;
            clearInterval(timer);
            clearTimeout(first);
        },
        tick,
    };
}
