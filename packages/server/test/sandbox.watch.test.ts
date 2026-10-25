/**
 * The coding watch (#94).
 *
 * The watcher is deliberately thin: it reads GitHub, decides whether a human
 * wrote something new, and hands the follow-up to the same service the chat
 * tools use. These tests pin the decisions that matter — App comments are not
 * answers, a closed issue cancels, a resolved thread or an already-seen
 * comment starts nothing, and one failure does not stop the pass.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppCodingJob } from "@lukestanbery/jarvis-auth";
import type {
    IssueComment,
    IssueSnapshot,
    PullRequestSnapshot,
} from "../src/github/client";
import type { CodingJobService } from "../src/sandbox/service";
import { logger } from "../src/logger";
import { startCodingWatch } from "../src/sandbox/watch";

const START = "2026-10-19T12:00:00.000Z";

/** A stored job with every field decided. */
function job(overrides: Partial<AppCodingJob> = {}): AppCodingJob {
    return {
        id: "job-1",
        userId: 7,
        repo: "luke/app",
        branch: "jarvis/fix-it",
        prompt: "Fix it.",
        state: "ok",
        crashPolicy: "prune",
        model: "big-pickle",
        containerId: null,
        workspacePath: "/jobs/job-1/repo",
        logTail: "",
        diffSummary: null,
        prUrl: null,
        issueNumber: null,
        questionCommentId: null,
        plan: null,
        lastSeenCommentId: null,
        attempts: 1,
        lastError: null,
        createdAt: START,
        startedAt: START,
        finishedAt: START,
        sessionId: null,
        questions: null,
        ...overrides,
    } as AppCodingJob;
}

/** An open issue. */
function issue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
    return {
        number: 12,
        url: "https://github.com/luke/app/issues/12",
        title: "Build it",
        body: "",
        state: "open",
        labels: [],
        author: "luke",
        pullRequest: false,
        commentCount: 0,
        createdAt: START,
        ...overrides,
    };
}

/** A pull request with some comments. */
function pull(comments: PullRequestSnapshot["comments"]): PullRequestSnapshot {
    return {
        owner: "luke",
        repo: "app",
        number: 9,
        url: "https://github.com/luke/app/pull/9",
        title: "JARVIS: fix it",
        body: "",
        head: "jarvis/fix-it",
        base: "main",
        state: "open",
        headRepo: "luke/app",
        comments,
        commentsTruncated: false,
        resolvedHidden: 0,
        resolutionUnavailable: false,
        readAt: START,
        conversationUnavailable: false,
    };
}

/** One human comment. */
function comment(
    id: number,
    body: string,
    overrides: Partial<PullRequestSnapshot["comments"][number]> = {},
): PullRequestSnapshot["comments"][number] {
    return {
        id,
        url: `https://github.com/luke/app/pull/9#discussion_r${id}`,
        author: "luke",
        body,
        createdAt: START,
        updatedAt: START,
        resolved: false,
        ...overrides,
    };
}

/** The three fakes, with sensible defaults per test. */
function makeWatch(
    options: {
        awaiting?: AppCodingJob[];
        prs?: AppCodingJob[];
        issueComments?: IssueComment[];
        pull?: PullRequestSnapshot;
        issueState?: "open" | "closed";
    } = {},
) {
    const resume = vi.fn(
        async (
            _userId: number,
            _jobId: string,
            _answers: string,
            _options?: { lastSeenCommentId?: number },
        ) => ({
            ok: true as const,
            job: job({ state: "running" }),
            done: Promise.resolve(),
        }),
    );
    const start = vi.fn(async () => ({
        ok: true as const,
        job: job({ state: "running" }),
        done: Promise.resolve(),
    }));
    const stop = vi.fn(async () => job({ state: "cancelled" }));
    const prs = [...(options.prs ?? [])];
    const terminalPrs = new Set<string>();
    const markPrTerminal = vi.fn((url: string) => {
        terminalPrs.add(url);
        return prs.filter((entry) => entry.prUrl === url).length;
    });
    const github = {
        botLogin: vi.fn(async () => "jarvis[bot]"),
        readIssueComments: vi.fn(
            async () => options.issueComments ?? ([] as IssueComment[]),
        ),
        readPullRequest: vi.fn(async () => options.pull ?? pull([])),
        getIssue: vi.fn(async () =>
            issue({ state: options.issueState ?? "open" }),
        ),
        getIssueComment: vi.fn(async () => ({
            body: "Which database?",
            url: "https://github.com/luke/app/issues/12#issuecomment-77",
        })),
        reactToComment: vi.fn(async () => undefined),
    };
    const service = {
        resume,
        start,
        stop,
    } as unknown as Pick<CodingJobService, "resume" | "start" | "stop">;
    const ledger = {
        listAwaitingCodingJobs: () => options.awaiting ?? [],
        // Mirror the store: a terminal PR is no longer a candidate.
        listCodingJobsWithPr: () =>
            prs.filter(
                (entry) =>
                    entry.prUrl !== null && !terminalPrs.has(entry.prUrl),
            ),
        markCodingJobsWithPrTerminal: markPrTerminal,
    };
    const watch = startCodingWatch({
        ledger,
        github,
        service,
        intervalMs: 300_000,
    });
    return {
        watch,
        resume,
        start,
        stop,
        github,
        markPrTerminal,
        prs,
    };
}

/** Runs a given number of passes and always stops the timers. */
async function ticks(
    fixture: ReturnType<typeof makeWatch>,
    passes = 1,
): Promise<void> {
    try {
        for (let pass = 0; pass < passes; pass += 1) {
            await fixture.watch.tick();
        }
    } finally {
        fixture.watch.stop();
    }
}

/** Runs one tick. */
async function tick(fixture: ReturnType<typeof makeWatch>): Promise<void> {
    await ticks(fixture);
}

describe("coding watch", () => {
    it("resumes a parked job when a human answers on the issue", async () => {
        const fixture = makeWatch({
            awaiting: [
                job({
                    state: "awaiting-answer",
                    issueNumber: 12,
                    questionCommentId: 77,
                    lastSeenCommentId: 77,
                }),
            ],
            issueComments: [
                {
                    id: 78,
                    author: "luke",
                    body: "Use Postgres on 5432.",
                    createdAt: START,
                    url: "https://github.com/luke/app/issues/12#issuecomment-78",
                },
            ],
        });

        await tick(fixture);

        expect(fixture.resume).toHaveBeenCalledTimes(1);
        const [userId, jobId, answers, options] =
            fixture.resume.mock.calls[0] ?? [];
        expect(userId).toBe(7);
        expect(jobId).toBe("job-1");
        expect(answers).toContain("Questions I asked");
        expect(answers).toContain("Which database?");
        expect(answers).toContain("Use Postgres on 5432.");
        expect(options).toEqual({ lastSeenCommentId: 78 });
        expect(fixture.stop).not.toHaveBeenCalled();
    });

    it("resumes a parked PR follow-up from the pull request's thread", async () => {
        const fixture = makeWatch({
            awaiting: [
                job({
                    state: "awaiting-answer",
                    issueNumber: null,
                    prUrl: "https://github.com/luke/app/pull/9",
                    questionCommentId: 77,
                    lastSeenCommentId: 77,
                }),
            ],
            issueComments: [
                {
                    id: 78,
                    author: "luke",
                    body: "Use the rail.",
                    createdAt: START,
                    url: "https://github.com/luke/app/pull/9#issuecomment-78",
                },
            ],
        });

        await tick(fixture);

        expect(fixture.resume).toHaveBeenCalledTimes(1);
        const [userId, jobId, answers, options] =
            fixture.resume.mock.calls[0] ?? [];
        expect(userId).toBe(7);
        expect(jobId).toBe("job-1");
        expect(answers).toContain("Use the rail.");
        expect(options).toEqual({ lastSeenCommentId: 78 });
        // The poller read the PR's thread, not a phantom issue.
        expect(fixture.github.getIssue).toHaveBeenCalledWith("luke", "app", 9);
        expect(fixture.github.readIssueComments).toHaveBeenCalledWith(
            "luke",
            "app",
            9,
            expect.anything(),
        );
    });

    it("does not treat the App's own comment as an answer", async () => {
        const fixture = makeWatch({
            awaiting: [
                job({
                    state: "awaiting-answer",
                    issueNumber: 12,
                    questionCommentId: 77,
                    lastSeenCommentId: 77,
                }),
            ],
            issueComments: [
                {
                    id: 78,
                    author: "jarvis[bot]",
                    body: "Still thinking.",
                    createdAt: START,
                    url: "",
                },
            ],
        });

        await tick(fixture);

        expect(fixture.resume).not.toHaveBeenCalled();
    });

    it("cancels a parked job when the issue closes", async () => {
        const fixture = makeWatch({
            awaiting: [
                job({
                    state: "awaiting-answer",
                    issueNumber: 12,
                    questionCommentId: 77,
                    lastSeenCommentId: 77,
                }),
            ],
            issueState: "closed",
        });

        await tick(fixture);

        expect(fixture.stop).toHaveBeenCalledWith(7, "job-1");
        expect(fixture.resume).not.toHaveBeenCalled();
    });

    it("starts a follow-up for new human review feedback", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                    lastSeenCommentId: 5,
                }),
            ],
            pull: pull([comment(6, "Please cover the empty case.")]),
        });

        await tick(fixture);

        expect(fixture.start).toHaveBeenCalledTimes(1);
        expect(fixture.start).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 7,
                repo: "luke/app",
                pullRequest: 9,
                replyTo: {
                    kind: "review",
                    id: 6,
                    url: "https://github.com/luke/app/pull/9#discussion_r6",
                },
            }),
        );
        expect(fixture.stop).not.toHaveBeenCalled();
        expect(fixture.resume).not.toHaveBeenCalled();
        expect(fixture.github.reactToComment).toHaveBeenCalledWith(
            { owner: "luke", repo: "app", kind: "review", id: 6 },
            "eyes",
        );
    });

    it("follows new feedback on the issue that started the pull request", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                    issueNumber: 12,
                }),
            ],
            issueComments: [
                {
                    id: 90,
                    author: "luke",
                    body: "Wire the new rows into the pages.",
                    createdAt: "2026-10-19T12:05:00.000Z",
                    url: "https://github.com/luke/app/issues/12#issuecomment-90",
                },
            ],
        });

        await tick(fixture);

        expect(fixture.start).toHaveBeenCalledTimes(1);
        expect(fixture.start).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 7,
                repo: "luke/app",
                pullRequest: 9,
                issueForQuestions: 12,
                task: expect.stringContaining(
                    "Wire the new rows into the pages.",
                ),
                replyTo: {
                    kind: "issue",
                    id: 90,
                    url: "https://github.com/luke/app/issues/12#issuecomment-90",
                },
            }),
        );
        expect(fixture.github.reactToComment).toHaveBeenCalledWith(
            { owner: "luke", repo: "app", kind: "issue", id: 90 },
            "eyes",
        );
    });

    it("ignores issue comments posted before the last run started", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                    issueNumber: 12,
                }),
            ],
            issueComments: [
                {
                    id: 90,
                    author: "luke",
                    body: "Old context, not feedback.",
                    createdAt: "2026-10-19T11:00:00.000Z",
                    url: "https://github.com/luke/app/issues/12#issuecomment-90",
                },
            ],
        });

        await tick(fixture);

        expect(fixture.start).not.toHaveBeenCalled();
    });

    it("recovers the originating issue from an earlier row for the same PR", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    id: "job-2",
                    prUrl: "https://github.com/luke/app/pull/9",
                    issueNumber: null,
                    startedAt: "2026-10-19T12:10:00.000Z",
                }),
                job({
                    id: "job-1",
                    prUrl: "https://github.com/luke/app/pull/9",
                    issueNumber: 12,
                }),
            ],
            issueComments: [
                {
                    id: 91,
                    author: "luke",
                    body: "One more thing.",
                    createdAt: "2026-10-19T12:12:00.000Z",
                    url: "https://github.com/luke/app/issues/12#issuecomment-91",
                },
            ],
        });

        await tick(fixture);

        expect(fixture.start).toHaveBeenCalledTimes(1);
        expect(fixture.start).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequest: 9,
                issueForQuestions: 12,
                task: expect.stringContaining("One more thing."),
            }),
        );
    });

    it("ignores the App's replies, resolved threads, and already-seen comments", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                    lastSeenCommentId: 5,
                }),
            ],
            pull: pull([
                comment(5, "Already seen."),
                comment(6, "JARVIS reply.", { author: "jarvis[bot]" }),
                comment(7, "Resolved note.", { resolved: true }),
            ]),
        });

        await tick(fixture);

        expect(fixture.start).not.toHaveBeenCalled();
    });

    it("starts even when the eyes reaction fails", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                    lastSeenCommentId: 5,
                }),
            ],
            pull: pull([comment(6, "Please cover the empty case.")]),
        });
        fixture.github.reactToComment.mockRejectedValueOnce(
            new Error("Resource not accessible by integration"),
        );

        await tick(fixture);

        expect(fixture.start).toHaveBeenCalledTimes(1);
    });

    it("does not follow up on a merged pull request", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                    lastSeenCommentId: 5,
                }),
            ],
            pull: { ...pull([comment(6, "One more thing.")]), state: "merged" },
        });

        await tick(fixture);

        expect(fixture.start).not.toHaveBeenCalled();
        expect(fixture.markPrTerminal).toHaveBeenCalledWith(
            "https://github.com/luke/app/pull/9",
            "merged",
        );
    });

    it("reads a terminal pull request once, then drops it from the feed", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                    lastSeenCommentId: 5,
                }),
            ],
            pull: { ...pull([comment(6, "One more thing.")]), state: "closed" },
        });

        await ticks(fixture, 2);

        expect(fixture.github.readPullRequest).toHaveBeenCalledTimes(1);
        expect(fixture.start).not.toHaveBeenCalled();
    });

    it("stops a pass at the first rate limit instead of failing every PR", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    id: "pr-9",
                    prUrl: "https://github.com/luke/app/pull/9",
                }),
                job({
                    id: "pr-10",
                    prUrl: "https://github.com/luke/app/pull/10",
                }),
            ],
        });
        fixture.github.readPullRequest.mockRejectedValueOnce(
            new Error(
                "GitHub /repos/luke/app/pulls/9 failed: 403 API rate limit exceeded for installation ID 1.",
            ),
        );
        const warn = vi
            .spyOn(logger, "warn")
            .mockImplementation(() => undefined);
        let warnings: string[] = [];

        try {
            await tick(fixture);
            // `mockRestore` clears the call list, so copy it before cleanup.
            warnings = warn.mock.calls.map(([message]) => String(message));
        } finally {
            warn.mockRestore();
        }

        expect(fixture.github.readPullRequest).toHaveBeenCalledTimes(1);
        expect(fixture.start).not.toHaveBeenCalled();
        expect(
            warnings.filter((message) => message.includes("rate limit")),
        ).toHaveLength(1);
    });

    it("tries again on the next pass after a rate limit", async () => {
        const fixture = makeWatch({
            prs: [
                job({
                    prUrl: "https://github.com/luke/app/pull/9",
                }),
            ],
        });
        fixture.github.readPullRequest.mockRejectedValueOnce(
            new Error(
                "GitHub /repos/luke/app/pulls/9 failed: 403 API rate limit exceeded for installation ID 1.",
            ),
        );

        await ticks(fixture, 2);

        expect(fixture.github.readPullRequest).toHaveBeenCalledTimes(2);
        expect(fixture.start).not.toHaveBeenCalled();
    });

    it("survives a failed login lookup without starting anything", async () => {
        const fixture = makeWatch({
            awaiting: [job({ state: "awaiting-answer", issueNumber: 12 })],
        });
        fixture.github.botLogin.mockRejectedValueOnce(new Error("network"));

        await expect(tick(fixture)).resolves.toBeUndefined();
        expect(fixture.resume).not.toHaveBeenCalled();
        expect(fixture.start).not.toHaveBeenCalled();
    });
});
