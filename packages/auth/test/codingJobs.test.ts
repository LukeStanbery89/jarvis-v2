/**
 * Coding-job ledger tests (#141).
 *
 * Three properties carry more weight than the row round-trip, and each is
 * tested directly rather than inferred:
 *
 * - **The claim is the transition**, exactly as for a scheduled job: `queued`
 *   in the WHERE clause means a second claimant touches no row. The container id
 *   is written at claim time — it is what `resume` needs after a crash, so a row
 *   that only learned its container on success would be unrecoverable exactly
 *   when recovery matters.
 * - **The terminal guard.** A late settle cannot rewrite a finished job's
 *   state or its recorded artifacts, and a settle of a row that was never
 *   claimed reports an attempt that never happened if it were allowed to land.
 * - **Two surfaces, deliberately.** `getCodingJob`/`listCodingJobs` are the
 *   caller's own rows; `getCodingJobById`/`listRunningCodingJobs` are the
 *   process's, because the boot reaper finds a container by label and has no
 *   owner to scope by.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createInMemoryAppDatabase } from "../src/testing";
import { openAppDatabase } from "../src/store";
import type { AppDatabase, CodingQuestion } from "../src";

/** A store with one owner and one plain user, plus their ids. */
function makeStore(): {
    store: AppDatabase;
    ownerId: number;
    userId: number;
} {
    const store = createInMemoryAppDatabase();
    const owner = store.createUser("luke", "hash", "owner");
    const user = store.createUser("sam", "hash", "user");
    return { store, ownerId: owner.id, userId: user.id };
}

/** A minimal coding job; every field the caller must decide is overridable. */
function codingJob(
    overrides: Partial<{
        id: string;
        repo: string;
        branch: string;
        prompt: string;
        workspacePath: string;
        crashPolicy: "prune" | "resume";
        createdAt: string;
    }> = {},
) {
    return {
        id: overrides.id ?? "c1",
        repo: overrides.repo ?? "luke/app",
        branch: overrides.branch ?? "jarvis/fix-the-thing",
        prompt: overrides.prompt ?? "Fix the failing login test.",
        workspacePath:
            overrides.workspacePath ?? "/home/jarvis/.jarvis/jobs/c1/repo",
        ...(overrides.crashPolicy
            ? { crashPolicy: overrides.crashPolicy }
            : {}),
        createdAt: overrides.createdAt ?? "2026-10-19T12:00:00.000Z",
    };
}

describe("coding-job ledger", () => {
    it("stores a job as queued with the documented defaults", () => {
        const { store, ownerId } = makeStore();
        const created = store.createCodingJob(ownerId, codingJob());

        expect(created).toEqual({
            id: "c1",
            userId: ownerId,
            repo: "luke/app",
            branch: "jarvis/fix-the-thing",
            prompt: "Fix the failing login test.",
            state: "queued",
            crashPolicy: "prune",
            model: null,
            containerId: null,
            workspacePath: "/home/jarvis/.jarvis/jobs/c1/repo",
            logTail: "",
            diffSummary: null,
            prUrl: null,
            issueNumber: null,
            questionCommentId: null,
            plan: null,
            lastSeenCommentId: null,
            attempts: 0,
            lastError: null,
            createdAt: "2026-10-19T12:00:00.000Z",
            startedAt: null,
            finishedAt: null,
            sessionId: null,
            questions: null,
        });
    });

    it("stores the crash policy the user chose", () => {
        const { store, ownerId } = makeStore();
        const created = store.createCodingJob(
            ownerId,
            codingJob({ crashPolicy: "resume" }),
        );
        expect(created.crashPolicy).toBe("resume");
    });

    it("records the model the run will use", () => {
        const { store, ownerId } = makeStore();
        const created = store.createCodingJob(ownerId, {
            ...codingJob(),
            model: "deepseek-v4.1-flash",
        });
        expect(created.model).toBe("deepseek-v4.1-flash");
        // Older rows have no answer; `null` says so rather than pretending.
        expect(store.getCodingJobById("c1")?.model).toBe("deepseek-v4.1-flash");
    });

    it("carries a follow-up's pull request from creation", () => {
        const { store, ownerId } = makeStore();
        const created = store.createCodingJob(ownerId, {
            ...codingJob(),
            prUrl: "https://github.com/luke/app/pull/165",
        });
        expect(created.prUrl).toBe("https://github.com/luke/app/pull/165");

        // Settling without a URL keeps the one the job started with: a
        // follow-up pushes to that PR and never opens a second.
        store.claimCodingJob("c1", "container-1", "2026-10-19T12:00:01.000Z");
        const settled = store.settleCodingJob(
            "c1",
            "ok",
            { diffSummary: "1 file changed" },
            "2026-10-19T12:01:00.000Z",
        );
        expect(settled?.prUrl).toBe("https://github.com/luke/app/pull/165");
    });

    it("scopes the user read to its owner", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(ownerId, codingJob());

        expect(store.getCodingJob(ownerId, "c1")?.id).toBe("c1");
        // A foreign id is indistinguishable from a missing one.
        expect(store.getCodingJob(userId, "c1")).toBeNull();
        expect(store.getCodingJob(ownerId, "nope")).toBeNull();
        // The process-scoped read has no owner to ask.
        expect(store.getCodingJobById("c1")?.id).toBe("c1");
    });

    it("claims a queued job once, recording the container and the attempt", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());

        const claimed = store.claimCodingJob(
            "c1",
            "abc123",
            "2026-10-19T12:01:00.000Z",
        );
        expect(claimed?.state).toBe("running");
        expect(claimed?.containerId).toBe("abc123");
        expect(claimed?.attempts).toBe(1);
        expect(claimed?.startedAt).toBe("2026-10-19T12:01:00.000Z");

        // The claim lives in the WHERE clause: a second claimant wins nothing.
        expect(
            store.claimCodingJob("c1", "second", "2026-10-19T12:02:00.000Z"),
        ).toBeNull();
        expect(store.getCodingJobById("c1")?.containerId).toBe("abc123");
        expect(store.getCodingJobById("c1")?.attempts).toBe(1);
    });

    it("keeps the container id after a settle, so the record still names it", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob("c1", "abc123", "2026-10-19T12:01:00.000Z");

        const settled = store.settleCodingJob(
            "c1",
            "ok",
            {},
            "2026-10-19T12:30:00.000Z",
        );
        expect(settled?.state).toBe("ok");
        expect(settled?.containerId).toBe("abc123");
        expect(settled?.finishedAt).toBe("2026-10-19T12:30:00.000Z");
    });

    it("records a failed run's reason and its output tail", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob("c1", "abc123", "2026-10-19T12:01:00.000Z");

        const settled = store.settleCodingJob(
            "c1",
            "failed",
            {
                logTail: "error: tests failed\n",
                error: "the agent exited 1",
            },
            "2026-10-19T12:30:00.000Z",
        );
        expect(settled?.state).toBe("failed");
        expect(settled?.lastError).toBe("the agent exited 1");
        expect(settled?.logTail).toBe("error: tests failed\n");
    });

    it("lets a late duplicate settle change nothing", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob("c1", "abc123", "2026-10-19T12:01:00.000Z");
        store.settleCodingJob(
            "c1",
            "ok",
            { diffSummary: "1 file changed" },
            "2026-10-19T12:30:00.000Z",
        );

        const again = store.settleCodingJob(
            "c1",
            "failed",
            { diffSummary: "rewritten", error: "late" },
            "2026-10-19T12:40:00.000Z",
        );
        expect(again?.state).toBe("ok");
        expect(again?.diffSummary).toBe("1 file changed");
        expect(again?.lastError).toBeNull();
        expect(again?.finishedAt).toBe("2026-10-19T12:30:00.000Z");
    });

    it("does not settle a job that was never claimed, except as failed", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob({ id: "never" }));
        store.createCodingJob(ownerId, codingJob({ id: "broken" }));

        // Nothing ran, so nothing can have succeeded.
        expect(
            store.settleCodingJob("never", "ok", {}, "2026-10-19T12:30:00.000Z")
                ?.state,
        ).toBe("queued");

        // A start that threw is the one ending a queued row can reach, and it
        // must be recordable — otherwise the row would claim to be waiting
        // forever.
        const failed = store.settleCodingJob(
            "broken",
            "failed",
            { error: "the container image is missing" },
            "2026-10-19T12:31:00.000Z",
        );
        expect(failed?.state).toBe("failed");
        expect(failed?.lastError).toBe("the container image is missing");
        expect(failed?.attempts).toBe(0);
    });

    it("cancels a queued job but not a running or settled one", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(ownerId, codingJob({ id: "queued" }));
        store.createCodingJob(ownerId, codingJob({ id: "running" }));
        store.claimCodingJob("running", "abc123", "2026-10-19T12:01:00.000Z");

        const cancelled = store.cancelCodingJob(
            ownerId,
            "queued",
            "2026-10-19T12:02:00.000Z",
        );
        expect(cancelled?.state).toBe("cancelled");
        expect(cancelled?.finishedAt).toBe("2026-10-19T12:02:00.000Z");

        // A running job is stopped through its container, not by editing a row
        // out from under the process watching it; a foreign cancel is a miss.
        expect(
            store.cancelCodingJob(
                ownerId,
                "running",
                "2026-10-19T12:03:00.000Z",
            )?.state,
        ).toBe("running");
        expect(
            store.cancelCodingJob(userId, "queued", "2026-10-19T12:04:00.000Z"),
        ).toBeNull();
    });

    it("lists a user's jobs, hiding settled ones unless asked", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(
            ownerId,
            codingJob({ id: "old", createdAt: "2026-10-19T09:00:00.000Z" }),
        );
        store.createCodingJob(
            ownerId,
            codingJob({ id: "new", createdAt: "2026-10-19T10:00:00.000Z" }),
        );
        store.createCodingJob(
            userId,
            codingJob({ id: "theirs", createdAt: "2026-10-19T11:00:00.000Z" }),
        );
        store.claimCodingJob("old", "c-1", "2026-10-19T09:01:00.000Z");
        store.settleCodingJob("old", "ok", {}, "2026-10-19T09:30:00.000Z");

        expect(store.listCodingJobs(ownerId).map((j) => j.id)).toEqual(["new"]);
        expect(
            store
                .listCodingJobs(ownerId, { includeSettled: true })
                .map((j) => j.id),
        ).toEqual(["new", "old"]);
        expect(store.listCodingJobs(ownerId, { limit: 1 })).toHaveLength(1);
    });

    it("reports every user's running jobs to the process", () => {
        const { store, ownerId, userId } = makeStore();
        store.createCodingJob(ownerId, codingJob({ id: "mine" }));
        store.createCodingJob(userId, codingJob({ id: "theirs" }));
        store.createCodingJob(userId, codingJob({ id: "queued" }));
        store.claimCodingJob("mine", "c-1", "2026-10-19T12:01:00.000Z");
        store.claimCodingJob("theirs", "c-2", "2026-10-19T12:02:00.000Z");

        expect(store.listRunningCodingJobs(10).map((j) => j.id)).toEqual([
            "mine",
            "theirs",
        ]);
        expect(store.listRunningCodingJobs(1).map((j) => j.id)).toEqual([
            "mine",
        ]);
    });

    it("replaces the stored output tail", () => {
        const { store, ownerId } = makeStore();
        store.createCodingJob(ownerId, codingJob());
        store.setCodingJobLogTail("c1", "line one\nline two\n");
        expect(store.getCodingJobById("c1")?.logTail).toBe(
            "line one\nline two\n",
        );
    });

    it("prunes settled history but never queued or running work", () => {
        const { store, ownerId } = makeStore();
        for (const id of ["a", "b", "c", "d"]) {
            store.createCodingJob(
                ownerId,
                codingJob({
                    id,
                    createdAt: `2026-10-19T0${id.charCodeAt(0) - 96}:00:00.000Z`,
                }),
            );
            store.claimCodingJob(id, `c-${id}`, "2026-10-19T12:01:00.000Z");
            store.settleCodingJob(id, "ok", {}, "2026-10-19T12:30:00.000Z");
        }
        store.createCodingJob(
            ownerId,
            codingJob({ id: "live", createdAt: "2026-10-19T05:00:00.000Z" }),
        );
        store.claimCodingJob("live", "c-live", "2026-10-19T12:01:00.000Z");

        // Keep the two newest settled rows; `live` survives despite being the
        // oldest row overall, because a run in flight is not history.
        expect(store.pruneCodingJobs(ownerId, 2)).toBe(2);
        expect(
            store
                .listCodingJobs(ownerId, { includeSettled: true })
                .map((j) => j.id),
        ).toEqual(["live", "d", "c"]);
    });
});

describe("waiting for answers (#94)", () => {
    it("parks a running job, refuses a terminal settle, and reopens it", () => {
        const { store, ownerId } = makeStore();
        const job = store.createCodingJob(ownerId, codingJob());
        expect(
            store.claimCodingJob(job.id, "c1", "2026-10-19T12:01:00.000Z")
                ?.state,
        ).toBe("running");

        const awaited = store.awaitCodingJob(job.id, {
            plan: "Use Postgres.",
            questionCommentId: 42,
            lastSeenCommentId: 42,
        });
        expect(awaited).toMatchObject({
            state: "awaiting-answer",
            plan: "Use Postgres.",
            questionCommentId: 42,
            lastSeenCommentId: 42,
            finishedAt: null,
        });
        expect(store.listAwaitingCodingJobs(10).map((j) => j.id)).toEqual([
            job.id,
        ]);

        // The parked state is not terminal: a settle cannot end it, and a
        // second await is a no-op rather than an overwrite.
        expect(
            store.settleCodingJob(job.id, "ok", {}, "2026-10-19T12:30:00.000Z")
                ?.state,
        ).toBe("awaiting-answer");
        expect(store.awaitCodingJob(job.id, { plan: "Other" })?.plan).toBe(
            "Use Postgres.",
        );

        const reopened = store.reopenCodingJob(job.id, 43);
        expect(reopened).toMatchObject({
            state: "queued",
            containerId: null,
            startedAt: null,
            lastSeenCommentId: 43,
        });
        expect(
            store.claimCodingJob(job.id, "c2", "2026-10-19T12:31:00.000Z")
                ?.attempts,
        ).toBe(2);
    });

    it("keeps the questions and their session until the job resumes (#94)", () => {
        const { store, ownerId } = makeStore();
        const job = store.createCodingJob(ownerId, {
            ...codingJob(),
            sessionId: "ses_chat_1",
        });
        expect(job.sessionId).toBe("ses_chat_1");
        expect(job.questions).toBeNull();
        store.claimCodingJob(job.id, "c1", "2026-10-19T12:01:00.000Z");
        store.awaitCodingJob(job.id, { plan: "Plan." });
        store.setCodingJobQuestions(job.id, [
            "Postgres or SQLite?",
            "Which branch?",
        ]);

        expect(
            store
                .listAwaitingCodingJobsBySession(ownerId, "ses_chat_1", 5)
                .map((row) => ({ id: row.id, questions: row.questions })),
        ).toEqual([
            {
                id: job.id,
                questions: ["Postgres or SQLite?", "Which branch?"],
            },
        ]);
        // Another conversation is not told about this one's work.
        expect(
            store.listAwaitingCodingJobsBySession(ownerId, "ses_other", 5),
        ).toEqual([]);

        // Reopening is the answer: the relay only reads `awaiting-answer`
        // rows, so the text cache may stay for the app without being relayed
        // again once the job is running (#180).
        expect(store.reopenCodingJob(job.id)?.questions).toEqual([
            "Postgres or SQLite?",
            "Which branch?",
        ]);
    });

    it("cancels a parked job only for its owner", () => {
        const { store, ownerId, userId } = makeStore();
        const job = store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob(job.id, "c1", "2026-10-19T12:01:00.000Z");
        store.awaitCodingJob(job.id, { plan: "Plan." });

        expect(
            store.cancelCodingJob(userId, job.id, "2026-10-19T12:02:00.000Z"),
        ).toBeNull();
        expect(
            store.cancelCodingJob(ownerId, job.id, "2026-10-19T12:02:00.000Z")
                ?.state,
        ).toBe("cancelled");
        expect(store.listAwaitingCodingJobs(10)).toHaveLength(0);
    });

    it("lists jobs with a pull request, newest first, for the watcher", () => {
        const { store, ownerId } = makeStore();
        const first = store.createCodingJob(ownerId, {
            ...codingJob({
                id: "first",
                createdAt: "2026-10-19T10:00:00.000Z",
            }),
            prUrl: "https://github.com/luke/app/pull/9",
        });
        const second = store.createCodingJob(ownerId, {
            ...codingJob({
                id: "second",
                createdAt: "2026-10-19T11:00:00.000Z",
            }),
            prUrl: "https://github.com/luke/app/pull/9",
        });
        store.createCodingJob(ownerId, {
            ...codingJob({
                id: "plain",
                createdAt: "2026-10-19T12:00:00.000Z",
            }),
        });

        expect(store.listCodingJobsWithPr(10).map((job) => job.id)).toEqual([
            second.id,
            first.id,
        ]);
    });

    it("drops every row for a terminal pull request from the watcher feed", () => {
        const { store, ownerId } = makeStore();
        const prUrl = "https://github.com/luke/app/pull/9";
        store.createCodingJob(ownerId, {
            ...codingJob({ id: "first" }),
            prUrl,
        });
        store.createCodingJob(ownerId, {
            ...codingJob({ id: "second" }),
            prUrl,
        });
        store.createCodingJob(ownerId, {
            ...codingJob({ id: "other" }),
            prUrl: "https://github.com/luke/app/pull/10",
        });

        expect(store.markCodingJobsWithPrTerminal(prUrl, "merged")).toBe(2);
        expect(store.listCodingJobsWithPr(10).map((job) => job.id)).toEqual([
            "other",
        ]);

        // The observation is idempotent: a duplicate tick does not rewrite it.
        expect(store.markCodingJobsWithPrTerminal(prUrl, "closed")).toBe(0);
        expect(store.listCodingJobsWithPr(10).map((job) => job.id)).toEqual([
            "other",
        ]);
    });

    it("records the issue and the watermark at creation", () => {
        const { store, ownerId } = makeStore();
        const created = store.createCodingJob(ownerId, {
            ...codingJob(),
            issueNumber: 12,
            lastSeenCommentId: 7,
        });

        expect(created).toMatchObject({
            issueNumber: 12,
            lastSeenCommentId: 7,
        });
    });
});

describe("v19 migration", () => {
    it("widens the state CHECK and adds the SDLC columns without losing rows", () => {
        const dir = mkdtempSync(join(tmpdir(), "jarvis-v19-"));
        const file = join(dir, "db.sqlite");
        try {
            const store = openAppDatabase(file);
            const owner = store.createUser("luke", "hash", "owner");
            store.close();

            // Recreate the v18 shape: no `awaiting-answer`, no SDLC columns.
            const raw = new Database(file);
            raw.exec(`
                DROP TABLE coding_jobs;
                CREATE TABLE coding_jobs (
                    id             TEXT PRIMARY KEY,
                    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    repo           TEXT NOT NULL,
                    branch         TEXT NOT NULL,
                    prompt         TEXT NOT NULL,
                    state          TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ok', 'failed', 'cancelled')),
                    crash_policy   TEXT NOT NULL DEFAULT 'prune' CHECK (crash_policy IN ('prune', 'resume')),
                    container_id   TEXT,
                    workspace_path TEXT NOT NULL,
                    model          TEXT,
                    log_tail       TEXT NOT NULL DEFAULT '',
                    diff_summary   TEXT,
                    pr_url         TEXT,
                    attempts       INTEGER NOT NULL DEFAULT 0,
                    last_error     TEXT,
                    created_at     TEXT NOT NULL,
                    started_at     TEXT,
                    finished_at    TEXT
                );
                INSERT INTO coding_jobs (
                    id, user_id, repo, branch, prompt, state, workspace_path,
                    created_at, finished_at
                ) VALUES (
                    'c1', ${owner.id}, 'luke/app', 'jarvis/old', 'Old work.',
                    'ok', '/jobs/c1/repo', '2026-10-19T12:00:00.000Z',
                    '2026-10-19T12:30:00.000Z'
                );
                PRAGMA user_version = 18;
            `);
            raw.close();

            const migrated = openAppDatabase(file);
            expect(migrated.getCodingJobById("c1")).toMatchObject({
                state: "ok",
                issueNumber: null,
                questionCommentId: null,
                plan: null,
                lastSeenCommentId: null,
            });
            // v23's terminal-PR memory exists on the migrated table too.
            expect(
                migrated.markCodingJobsWithPrTerminal(
                    "https://github.com/luke/app/pull/9",
                    "closed",
                ),
            ).toBe(0);

            // The new state is accepted on the rebuilt table.
            const job = migrated.createCodingJob(owner.id, {
                ...codingJob({ id: "c2" }),
            });
            migrated.claimCodingJob(job.id, "c2", "2026-10-19T12:01:00.000Z");
            expect(
                migrated.awaitCodingJob(job.id, { plan: "New plan." })?.state,
            ).toBe("awaiting-answer");
            migrated.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("structured questions (#180)", () => {
    const dbQuestion: CodingQuestion = {
        id: "db",
        text: "Which database?",
        kind: "single",
        options: [
            { id: "postgres", label: "Postgres" },
            { id: "sqlite", label: "SQLite" },
        ],
        required: true,
        allowOther: false,
    };
    const notesQuestion: CodingQuestion = {
        id: "notes",
        text: "Anything else?",
        kind: "text",
        options: [],
        required: false,
        allowOther: false,
    };

    it("stores, reads, and answers a question set", () => {
        const { store, ownerId } = makeStore();
        const job = store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob(job.id, "c1", "2026-10-19T12:01:00.000Z");
        store.awaitCodingJob(job.id, { plan: "Plan." });

        store.setCodingJobQuestionSet(job.id, [dbQuestion, notesQuestion]);
        expect(store.getCodingJobQuestions(job.id)).toEqual([
            {
                ...dbQuestion,
                position: 0,
                answer: null,
                answeredAt: null,
                answerSource: null,
            },
            {
                ...notesQuestion,
                position: 1,
                answer: null,
                answeredAt: null,
                answerSource: null,
            },
        ]);

        store.answerCodingJobQuestions(
            job.id,
            [
                { questionId: "db", value: "postgres" },
                { questionId: "notes", value: "No." },
            ],
            "app",
            "2026-10-19T12:02:00.000Z",
        );
        const answered = store.getCodingJobQuestions(job.id);
        expect(answered[0]).toMatchObject({
            answer: { questionId: "db", value: "postgres" },
            answeredAt: "2026-10-19T12:02:00.000Z",
            answerSource: "app",
        });
        expect(answered[1]).toMatchObject({
            answer: { questionId: "notes", value: "No." },
        });
    });

    it("replaces the set instead of appending to it", () => {
        const { store, ownerId } = makeStore();
        const job = store.createCodingJob(ownerId, codingJob());
        store.claimCodingJob(job.id, "c1", "2026-10-19T12:01:00.000Z");
        store.awaitCodingJob(job.id, { plan: "Plan." });

        store.setCodingJobQuestionSet(job.id, [dbQuestion, notesQuestion]);
        store.setCodingJobQuestionSet(job.id, [dbQuestion]);

        expect(store.getCodingJobQuestions(job.id)).toHaveLength(1);
        expect(store.getCodingJobQuestions(job.id)[0]?.id).toBe("db");
    });
});
