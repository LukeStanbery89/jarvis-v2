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
 *
 * A terminal pull request is read once: its `closed`/`merged` state is recorded
 * on the rows so the feed no longer selects it (#192). A rate-limit answer ends
 * the pass after one warning; the next pass retries rather than staying off.
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

/**
 * GitHub's rate-limit answer.
 *
 * The client keeps the status and GitHub's own message in one `Error`, so the
 * watcher can distinguish a quota exhaustion from a permission problem without
 * treating every failed read as a reason to stop. Secondary-limit and abuse
 * bodies count too; a 429 is a rate limit even when the body is terse.
 *
 * @param err - A rejected GitHub call.
 * @returns True when the failure means "stop asking GitHub for now".
 */
export function isRateLimitError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
        /\b429\b/.test(message) ||
        (/\b403\b/.test(message) && /rate limit|abuse detection/i.test(message))
    );
}

/** The seams the watcher needs; a test supplies fakes for all three. */
export interface CodingWatchOptions {
    ledger: Pick<
        CodingJobLedger,
        | "listAwaitingCodingJobs"
        | "listCodingJobsWithPr"
        | "markCodingJobsWithPrTerminal"
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
     * Set by the first rate-limit failure in a pass. The rest of that pass
     * stops, so an exhausted installation quota costs one warning and one
     * failed call rather than one failure per tracked PR (#192).
     */
    let rateLimited = false;

    /**
     * Stops the current pass on a rate-limit failure.
     *
     * @param err - The caught failure.
     * @returns True when the caller must stop walking its queue.
     */
    function noteRateLimit(err: unknown): boolean {
        if (!isRateLimitError(err)) {
            return false;
        }
        if (!rateLimited) {
            rateLimited = true;
            logger.warn(
                "coding watch: GitHub rate limit reached; skipping the rest of this pass",
            );
        }
        return true;
    }

    /**
     * Answers on an awaiting job's issue.
     *
     * @param bot - The App's login.
     */
    async function watchIssues(bot: string): Promise<void> {
        for (const job of options.ledger.listAwaitingCodingJobs(limit)) {
            // A PR follow-up has no issue, but its questions are posted on the
            // pull request's own thread (GitHub's issue-comment API), so the
            // same answer poller covers both.
            const thread =
                job.issueNumber ??
                (job.prUrl !== null ? pullNumberFromUrl(job.prUrl) : null);
            if (thread === null || job.questionCommentId === null) {
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
                    thread,
                );
                if (issue.state !== "open") {
                    // The user closed the issue/PR: there is nothing left to
                    // continue, and the parked workspace is not a promise.
                    await options.service.stop(job.userId, job.id);
                    logger.info(
                        `coding watch: thread #${thread} closed; cancelled parked job ${job.id}`,
                    );
                    continue;
                }
                const comments = await options.github.readIssueComments(
                    parts.owner,
                    parts.name,
                    thread,
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
                    .catch((err: unknown) => {
                        noteRateLimit(err);
                        return null;
                    });
                if (rateLimited) {
                    break;
                }
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
                        `coding watch: resumed job ${job.id} from thread #${thread}`,
                    );
                } else {
                    logger.warn(
                        `coding watch: could not resume job ${job.id}: ${resumed.reason}`,
                    );
                }
            } catch (err) {
                if (noteRateLimit(err)) {
                    break;
                }
                logger.warn(
                    `coding watch: thread #${thread} failed: ${
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
                    // Record the one terminal observation so this URL leaves
                    // the feed: a merged or closed PR has no feedback left to
                    // follow, and re-reading it forever exhausted the
                    // installation quota (#192).
                    options.ledger.markCodingJobsWithPrTerminal(
                        job.prUrl,
                        pull.state,
                    );
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
                        if (noteRateLimit(err)) {
                            break;
                        }
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
                                if (noteRateLimit(err)) {
                                    return;
                                }
                                logger.warn(
                                    `coding watch: could not react to ${reply.kind} comment ${reply.id}: ${
                                        err instanceof Error
                                            ? err.message
                                            : String(err)
                                    }`,
                                );
                            });
                        if (rateLimited) {
                            break;
                        }
                    }
                } else {
                    logger.warn(
                        `coding watch: could not follow up on PR #${number}: ${started.reason}`,
                    );
                }
            } catch (err) {
                if (noteRateLimit(err)) {
                    break;
                }
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
        // A new pass gets a fresh chance: the reset is what lets the watch
        // recover once GitHub's window rolls over (#192).
        rateLimited = false;
        try {
            const bot = await options.github
                .botLogin()
                .catch((err: unknown) => {
                    if (!noteRateLimit(err)) {
                        logger.warn(
                            `coding watch: could not read the App login: ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        );
                    }
                    return null;
                });
            if (bot === null) {
                return;
            }
            await watchIssues(bot);
            if (!rateLimited) {
                await watchPulls(bot);
            }
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
