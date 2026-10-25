/**
 * Supervisor tests (#141).
 *
 * The daemon and git are both faked here, because what is being tested is the
 * *lifecycle*: who claims the row, what the container is handed, what a
 * successful or failed ending records, what a cancel does to a supervisor
 * already watching, and what the boot does with each disagreement between a row
 * and a container. Real Docker and real git are covered by the probe, the
 * runner's smoke test and the workspace suite.
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import type { SandboxConfig } from "../src/config";
import type { NotificationService } from "../src/notify/service";
import { createFakeSandbox } from "../src/sandbox/fake";
import {
    brokerAnswers,
    createCodingJobService,
    followUpPrompt,
    lastAgentMessage,
} from "../src/sandbox/service";
import { deriveJobToken } from "../src/sandbox/proxy";
import type { IssueSnapshot, PullRequestSnapshot } from "../src/github/client";
import type { JobPublisher } from "../src/sandbox/publish";
import type { RepoSpec, WorkspaceManager } from "../src/sandbox/workspace";

/** A config with every knob decided. */
const CONFIG: SandboxConfig = {
    image: "jarvis-job:test",
    socketPath: "/var/run/docker.sock",
    workspaceRoot: "/jobs",
    workspaceHostRoot: "/host/jobs",
    maxJobs: 1,
    cpus: 2,
    memoryMb: 1024,
    pids: 128,
    wallClockMs: 60_000,
    maxWorkspaceMb: 2048,
    repos: ["luke/app"],
    models: [{ id: "lmstudio/qwen3", contextTokens: 200_000 }],
    llmBaseUrl: "http://host.docker.internal:1234/v1",
    apiKey: "",
    extraHosts: [],
    proxyBind: "127.0.0.1",
    proxyPort: 54322,
    proxyUrl: "http://host.docker.internal:54322/v1",
    proxyProbeUrl: "",
    proxySecret: "",
    proxyMaxRequestsPerJob: 500,
    proxyMode: "embedded",
    egressProxyUrl: "",
    network: "",
    logRoot: "/logs/coding",
    logMaxMb: 10,
    workspaceRetentionDays: 14,
    logRetentionDays: 30,
    keepJobRows: 100,
    watchEnabled: true,
    watchIntervalMs: 300_000,
};

/** A minimal open issue. */
function issueSnapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
    return {
        number: 140,
        url: "https://github.com/luke/app/issues/140",
        title: "Work with the tracker",
        body: "Read and comment on issues.",
        state: "open",
        labels: ["enhancement"],
        author: "luke",
        pullRequest: false,
        commentCount: 2,
        createdAt: "2026-10-19T10:00:00.000Z",
        ...overrides,
    };
}

/** A minimal open pull request, for the prompt's own tests. */
function pullRequest(
    overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
    return {
        owner: "luke",
        repo: "app",
        number: 7,
        url: "https://github.com/luke/app/pull/7",
        title: "A change",
        body: "",
        head: "jarvis/a-change-1234",
        base: "main",
        state: "open",
        headRepo: "luke/app",
        comments: [],
        commentsTruncated: false,
        resolvedHidden: 0,
        resolutionUnavailable: false,
        conversationUnavailable: false,
        readAt: "2026-10-21T00:00:00.000Z",
        ...overrides,
    };
}

/** A store with one owner. */
function makeStore(): { store: AppDatabase; userId: number } {
    const store = createInMemoryAppDatabase();
    const user = store.createUser("luke", "hash", "owner");
    return { store, userId: user.id };
}

/** A workspace that records what it was asked to do, without touching disk. */
function fakeWorkspace(
    options: {
        allow?: boolean;
        commit?: boolean;
        collect?: () => { changed: boolean; diffSummary: string };
        /** Where `prepare` says the clone is; defaults to `/jobs`. */
        root?: string;
    } = {},
): WorkspaceManager & {
    prepared: Array<{ jobId: string; branch: string; existing?: boolean }>;
    removed: string[];
    commits: Array<{ workspacePath: string; message: string }>;
    pushes: Array<{
        workspacePath: string;
        branch: string;
        auth?: { username: string; token: string };
    }>;
} {
    const prepared: Array<{
        jobId: string;
        branch: string;
        existing?: boolean;
    }> = [];
    const removed: string[] = [];
    const commits: Array<{ workspacePath: string; message: string }> = [];
    const pushes: Array<{
        workspacePath: string;
        branch: string;
        auth?: { username: string; token: string };
    }> = [];
    return {
        prepared,
        removed,
        commits,
        pushes,
        allows(repo: string): RepoSpec | null {
            if (options.allow === false) {
                return null;
            }
            return {
                entry: repo,
                owner: "luke",
                name: "app",
                url: "https://github.com/luke/app",
            };
        },
        async prepare(input) {
            prepared.push({
                jobId: input.jobId,
                branch: input.branch,
                ...(input.existing === true ? { existing: true } : {}),
            });
            return {
                path: options.root
                    ? path.join(options.root, input.jobId, "repo")
                    : `/jobs/${input.jobId}/repo`,
                hostPath: options.root
                    ? path.join(options.root, "host", input.jobId, "repo")
                    : `/host/jobs/${input.jobId}/repo`,
            };
        },
        async collect() {
            return (
                options.collect?.() ?? {
                    changed: true,
                    diffSummary: "1 file changed",
                }
            );
        },
        async remove(workspacePath: string) {
            removed.push(workspacePath);
        },
        async commit(input: { workspacePath: string; message: string }) {
            commits.push(input);
            return options.commit ?? true;
        },
        async push(input) {
            pushes.push(input);
        },
    };
}

/** A notification service spy; the outcome itself is not under test. */
function notifications(): Pick<
    NotificationService,
    "notify" | "settleCodingQuestion"
> & {
    notify: ReturnType<typeof vi.fn>;
    settleCodingQuestion: ReturnType<typeof vi.fn>;
} {
    return {
        notify: vi.fn(async () => ({
            notification: {},
            delivered: 1,
            suppressed: null,
        })),
        settleCodingQuestion: vi.fn(() => 0),
    } as unknown as Pick<
        NotificationService,
        "notify" | "settleCodingQuestion"
    > & {
        notify: ReturnType<typeof vi.fn>;
        settleCodingQuestion: ReturnType<typeof vi.fn>;
    };
}

/** The fake workspace's surface, including its recording arrays. */
type FakeWorkspace = ReturnType<typeof fakeWorkspace>;

/** Temp directories the suite removes afterwards. */
const tempDirs: string[] = [];

/** A temp directory that outlives the test body. */
function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A service whose ids count up, so assertions can name the rows. */
function makeService(
    overrides: {
        config?: Partial<SandboxConfig>;
        proxy?: { url: string; secret: string };
        publisher?: JobPublisher;
        pullRequests?: (input: {
            owner: string;
            repo: string;
            number: number;
        }) => Promise<PullRequestSnapshot>;
        issues?: (input: {
            owner: string;
            repo: string;
            number: number;
        }) => Promise<IssueSnapshot>;
        workspace?: FakeWorkspace;
        workspaceSize?: (workspacePath: string) => Promise<number>;
        probeBroker?: (url: string) => Promise<boolean>;
        runner?: ReturnType<typeof createFakeSandbox>;
        now?: () => Date;
        commentOnIssue?: (input: {
            owner: string;
            repo: string;
            number: number;
            body: string;
        }) => Promise<{ id: number; url: string }>;
    } = {},
) {
    const { store, userId } = makeStore();
    const workspace = overrides.workspace ?? fakeWorkspace();
    const runner = overrides.runner ?? createFakeSandbox();
    const notify = notifications();
    const logRoot = overrides.config?.logRoot ?? tempDir("jarvis-logs-");
    let sequence = 0;
    const service = createCodingJobService({
        ledger: store,
        runner,
        workspace,
        config: { ...CONFIG, logRoot, ...overrides.config },
        ...(overrides.proxy ? { proxy: overrides.proxy } : {}),
        ...(overrides.publisher ? { publisher: overrides.publisher } : {}),
        ...(overrides.pullRequests
            ? { pullRequests: overrides.pullRequests }
            : {}),
        ...(overrides.issues ? { issues: overrides.issues } : {}),
        ...(overrides.workspaceSize
            ? { workspaceSize: overrides.workspaceSize }
            : {}),
        ...(overrides.probeBroker
            ? { probeBroker: overrides.probeBroker }
            : {}),
        ...(overrides.commentOnIssue
            ? { commentOnIssue: overrides.commentOnIssue }
            : {}),
        notifications: notify,
        now: overrides.now ?? (() => new Date("2026-10-19T12:00:00.000Z")),
        newId: () => `job-${++sequence}`,
    });
    return { store, userId, workspace, runner, notify, service, logRoot };
}

describe("starting a coding job", () => {
    it("clones, starts the container and settles an ok run", async () => {
        const { store, userId, workspace, runner, notify, service } =
            makeService();

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Fix the login bug",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }

        expect(started.job).toMatchObject({
            id: "job-1",
            state: "running",
            repo: "luke/app",
            crashPolicy: "prune",
            model: "lmstudio/qwen3",
            attempts: 1,
            workspacePath: "/jobs/job-1/repo",
        });
        expect(started.job.branch).toMatch(/^jarvis\/fix-the-login-bug-/);
        expect(workspace.prepared).toEqual([
            { jobId: "job-1", branch: started.job.branch },
        ]);
        expect(runner.started).toHaveLength(1);
        expect(runner.started[0]).toMatchObject({
            jobId: "job-1",
            image: "jarvis-job:test",
            // The *host* path, not the server's: the daemon resolves it.
            workspacePath: "/host/jobs/job-1/repo",
            command: [],
        });
        expect(runner.started[0]?.env).toMatchObject({
            JARVIS_JOB_MODELS: "lmstudio/qwen3|200000",
            JARVIS_JOB_LLM_BASE_URL: "http://host.docker.internal:1234/v1",
            JARVIS_JOB_BRANCH: started.job.branch,
        });
        // The task carries the SDLC contract and ends with the user's words.
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            "Never merge a pull request",
        );
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            ".jarvis/questions.json",
        );
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            "npm run check",
        );
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            "Decisions to make",
        );
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            ".jarvis/brief.md",
        );
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            "no GitHub credentials",
        );
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            "Prefer `edit`",
        );
        expect(runner.started[0]?.env.JARVIS_JOB_PROMPT).toContain(
            "Fix the login bug",
        );
        // Embedded mode: the job reaches the broker and nothing else.
        expect(runner.started[0]?.env).not.toHaveProperty("HTTP_PROXY");

        runner.emit(started.job.containerId ?? "", "working…");
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        const settled = store.getCodingJobById("job-1");
        expect(settled?.state).toBe("ok");
        expect(settled?.logTail).toContain("working…");
        expect(settled?.diffSummary).toBe("1 file changed");
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({ kind: "coding.finished" }),
        );
        // The container is gone; the workspace is kept for the PR step.
        expect(runner.removed).toContain(started.job.containerId);
        expect(workspace.removed).toEqual([]);
        // A model that says "committed" without calling git is made true.
        expect(workspace.commits).toEqual([
            {
                workspacePath: "/jobs/job-1/repo",
                message: "JARVIS: Fix the login bug",
            },
        ]);
    });

    it("continues a pull request on its branch, with the review as context", async () => {
        const pull: PullRequestSnapshot = {
            owner: "luke",
            repo: "app",
            number: 165,
            url: "https://github.com/luke/app/pull/165",
            title: "Add a greeting",
            body: "Add a greeting to the app.",
            head: "jarvis/add-a-greeting-1234",
            base: "main",
            state: "open",
            headRepo: "luke/app",
            comments: [
                {
                    id: 101,
                    url: "https://github.com/luke/app/pull/7#discussion_r101",
                    author: "reviewer",
                    body: "Please move this.",
                    path: "src/app.ts",
                    line: 12,
                    createdAt: "2026-10-20T23:50:00Z",
                    updatedAt: "2026-10-20T23:50:00Z",
                    resolved: false,
                },
                {
                    id: 102,
                    url: "https://github.com/luke/app/pull/7#issuecomment-102",
                    author: "luke",
                    body: "Also add a test.",
                    createdAt: "2026-10-20T23:51:00Z",
                    updatedAt: "2026-10-20T23:51:00Z",
                    resolved: false,
                },
            ],
            commentsTruncated: false,
            resolvedHidden: 0,
            resolutionUnavailable: false,
            conversationUnavailable: false,
            readAt: "2026-10-21T00:00:00.000Z",
        };
        const pullRequests = vi.fn(async () => pull);
        const publish = vi.fn(async () => ({ prUrl: pull.url }));
        const { store, userId, workspace, runner, notify, service } =
            makeService({ publisher: { publish }, pullRequests });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Address the review comments",
            pullRequest: 165,
            issueForQuestions: 140,
            replyTo: { kind: "review", id: 433, url: null },
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }

        expect(pullRequests).toHaveBeenCalledWith({
            owner: "luke",
            repo: "app",
            number: 165,
        });
        // The PR's branch, checked out rather than created.
        expect(started.job.branch).toBe("jarvis/add-a-greeting-1234");
        expect(started.job.prUrl).toBe(pull.url);
        expect(workspace.prepared).toEqual([
            {
                jobId: "job-1",
                branch: "jarvis/add-a-greeting-1234",
                existing: true,
            },
        ]);
        // The row keeps what the user asked; the container gets the context.
        expect(started.job.prompt).toBe("Address the review comments");
        // The PR supplies the branch and prompt; the issue is only the thread
        // a parked follow-up would post its questions on.
        expect(started.job.issueNumber).toBe(140);
        const prompt = runner.started[0]?.env.JARVIS_JOB_PROMPT ?? "";
        expect(prompt).toContain("#165");
        expect(prompt).toContain("Add a greeting");
        expect(prompt).toContain("src/app.ts:12");
        expect(prompt).toContain("Please move this.");
        expect(prompt).toContain("Also add a test.");
        expect(prompt).toContain("## What this job should do");
        expect(prompt).toContain("Address the review comments");
        expect(prompt).toContain("posted as a reply");

        runner.emit(
            started.job.containerId ?? "",
            '{"type":"text","part":{"text":"Removed the second comment."}}',
        );
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        // Push only: the PR already exists, and a second one would split it.
        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({
                branch: "jarvis/add-a-greeting-1234",
                existing: { url: pull.url },
                reply: {
                    comment: { kind: "review", id: 433, url: null },
                    body: "Removed the second comment.",
                },
            }),
        );
        const row = store.getCodingJobById(started.job.id);
        expect(row?.state).toBe("ok");
        expect(row?.prUrl).toBe(pull.url);
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({
                body: expect.stringContaining(
                    `Updated pull request: ${pull.url}`,
                ),
            }),
        );
        // Pushed means the remote is the copy.
        expect(workspace.removed).toContain("/jobs/job-1/repo");
    });

    it("implements an issue by reading it and composing the prompt", async () => {
        const issues = vi.fn(async () => issueSnapshot());
        const { store, userId, workspace, runner, service } = makeService({
            issues,
        });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Implement issue #140.",
            issue: 140,
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }

        expect(issues).toHaveBeenCalledWith({
            owner: "luke",
            repo: "app",
            number: 140,
        });
        // A new branch: an issue is not an existing review.
        expect(started.job.branch).toMatch(/^jarvis\/implement-issue-140-/);
        expect(workspace.prepared[0]?.existing).toBeUndefined();
        expect(started.job.prUrl).toBeNull();
        expect(started.job.prompt).toBe("Implement issue #140.");

        const prompt = runner.started[0]?.env.JARVIS_JOB_PROMPT ?? "";
        expect(prompt).toContain("Implement issue #140.");
        expect(prompt).toContain("## GitHub issue #140: Work with the tracker");
        expect(prompt).toContain("labels: enhancement");
        expect(prompt).toContain("Read and comment on issues.");
        expect(prompt).toContain("https://github.com/luke/app/issues/140");

        runner.emit(started.job.containerId ?? "", "done");
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;
        expect(store.getCodingJobById(started.job.id)?.state).toBe("ok");
    });

    it("refuses an issue it cannot read, or one that is a pull request", async () => {
        const request = {
            repo: "luke/app",
            task: "Implement it.",
            issue: 140,
        };

        const noGithub = makeService();
        expect(
            await noGithub.service.start({
                ...request,
                userId: noGithub.userId,
            }),
        ).toMatchObject({ ok: false, code: "issue-unavailable" });
        expect(noGithub.workspace.prepared).toHaveLength(0);

        const failing = makeService({
            issues: async () => {
                throw new Error("404 Not Found");
            },
        });
        expect(
            await failing.service.start({
                ...request,
                userId: failing.userId,
            }),
        ).toMatchObject({ ok: false, code: "issue-unavailable" });
        expect(failing.workspace.prepared).toHaveLength(0);

        const pull = makeService({
            issues: async () => issueSnapshot({ pullRequest: true }),
        });
        expect(
            await pull.service.start({ ...request, userId: pull.userId }),
        ).toMatchObject({ ok: false, code: "issue-is-pull-request" });
        expect(pull.workspace.prepared).toHaveLength(0);

        const both = makeService({ issues: async () => issueSnapshot() });
        expect(
            await both.service.start({
                ...request,
                userId: both.userId,
                pullRequest: 165,
            }),
        ).toMatchObject({ ok: false, code: "issue-and-pull-request" });
        expect(both.workspace.prepared).toHaveLength(0);
    });

    it("refuses a follow-up it cannot honour, without cloning anything", async () => {
        const open: PullRequestSnapshot = {
            owner: "luke",
            repo: "app",
            number: 9,
            url: "https://github.com/luke/app/pull/9",
            title: "A change",
            body: "",
            head: "jarvis/a-change-1234",
            base: "main",
            state: "open",
            headRepo: "luke/app",
            comments: [],
            commentsTruncated: false,
            resolvedHidden: 0,
            resolutionUnavailable: false,
            conversationUnavailable: false,
            readAt: "2026-10-21T00:00:00.000Z",
        };
        const request = {
            userId: 1,
            repo: "luke/app",
            task: "Fix the review",
            pullRequest: 9,
        };

        // No App: the PR cannot be read at all.
        const noGithub = makeService();
        const unavailable = await noGithub.service.start({
            ...request,
            userId: noGithub.userId,
        });
        expect(unavailable).toMatchObject({
            ok: false,
            code: "follow-ups-unavailable",
        });
        expect(noGithub.workspace.prepared).toHaveLength(0);

        // Merged or closed.
        const closed = makeService({
            pullRequests: async () => ({ ...open, state: "merged" }),
        });
        expect(
            await closed.service.start({ ...request, userId: closed.userId }),
        ).toMatchObject({ ok: false, code: "pull-request-closed" });
        expect(closed.workspace.prepared).toHaveLength(0);

        // A fork's branch is not on this repository's origin.
        const fork = makeService({
            pullRequests: async () => ({ ...open, headRepo: "someone/app" }),
        });
        expect(
            await fork.service.start({ ...request, userId: fork.userId }),
        ).toMatchObject({ ok: false, code: "pull-request-fork" });
        expect(fork.workspace.prepared).toHaveLength(0);

        // A reply target without the PR it belongs to is nothing to reply in.
        const replyOnly = makeService({ pullRequests: async () => open });
        expect(
            await replyOnly.service.start({
                ...request,
                userId: replyOnly.userId,
                pullRequest: undefined,
                replyTo: { kind: "review", id: 433, url: null },
            }),
        ).toMatchObject({ ok: false, code: "reply-without-pull-request" });
        expect(replyOnly.workspace.prepared).toHaveLength(0);

        // GitHub could not answer.
        const failing = makeService({
            pullRequests: async () => {
                throw new Error("404 Not Found");
            },
        });
        expect(
            await failing.service.start({ ...request, userId: failing.userId }),
        ).toMatchObject({ ok: false, code: "pull-request-unavailable" });
        expect(failing.workspace.prepared).toHaveLength(0);
    });

    it("gives a sidecar job the egress proxy and keeps the broker direct", async () => {
        const { userId, runner, service } = makeService({
            config: {
                proxyMode: "sidecar",
                proxyUrl: "http://proxy:54322/v1",
                egressProxyUrl: "http://proxy:54323",
                network: "jarvis-sandbox",
            },
            // Production always passes the broker (url + secret) when the
            // sandbox is on: the same wiring derives the token in both modes.
            proxy: { url: "http://proxy:54322/v1", secret: "s".repeat(32) },
            probeBroker: async () => true,
        });
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Install the dependencies and run the tests",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }

        expect(runner.started[0]?.env).toMatchObject({
            JARVIS_JOB_LLM_BASE_URL: "http://proxy:54322/v1",
            HTTP_PROXY: "http://proxy:54323",
            HTTPS_PROXY: "http://proxy:54323",
            // The broker and the agent's own localhost control plane are
            // reached directly, not through the forward proxy.
            NO_PROXY: "proxy,localhost,127.0.0.1,::1",
        });

        runner.emit(started.job.containerId ?? "", "ok");
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;
    });

    it("hands the whole model ladder to the container", async () => {
        const { userId, runner, service } = makeService({
            config: {
                models: [
                    { id: "big-pickle", contextTokens: 200_000 },
                    { id: "deepseek-v4.1-flash", contextTokens: 400_000 },
                ],
            },
        });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Add the settings toggle",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }

        expect(runner.started[0]?.env.JARVIS_JOB_MODELS).toBe(
            "big-pickle|200000\ndeepseek-v4.1-flash|400000",
        );
        // The row records the model the run starts on, not the fallbacks.
        expect(started.job.model).toBe("big-pickle");

        runner.emit(started.job.containerId ?? "", "ok");
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;
    });

    it("refuses a sidecar job when the broker is not running", async () => {
        const probe = vi.fn(async () => false);
        const { userId, workspace, service } = makeService({
            config: {
                proxyMode: "sidecar",
                proxyUrl: "http://jarvis-proxy:54322/v1",
                proxyProbeUrl: "http://127.0.0.1:54322/v1",
                network: "jarvis-sandbox",
            },
            probeBroker: probe,
        });

        const result = await service.start({
            userId,
            repo: "luke/app",
            task: "Install a dependency",
        });

        expect(result).toMatchObject({
            ok: false,
            code: "broker-unreachable",
        });
        // The server probes the host-reachable URL, not the job's name.
        expect(probe).toHaveBeenCalledWith("http://127.0.0.1:54322/v1");
        // Nothing was cloned, claimed or started for a doomed run.
        expect(workspace.prepared).toHaveLength(0);
    });

    it("refuses a sidecar job with no job network", async () => {
        const probe = vi.fn(async () => true);
        const { userId, workspace, service } = makeService({
            config: {
                proxyMode: "sidecar",
                proxyUrl: "http://proxy:54322/v1",
                network: "",
            },
            probeBroker: probe,
        });

        const result = await service.start({
            userId,
            repo: "luke/app",
            task: "Install a dependency",
        });

        expect(result).toMatchObject({ ok: false, code: "egress-unsafe" });
        expect(workspace.prepared).toHaveLength(0);
        // The network is checked before the broker probe: a routed network
        // makes the job unsafe whether or not the sidecar is up.
        expect(probe).not.toHaveBeenCalled();
    });

    it("refuses a sidecar job whose network is not internal", async () => {
        const { userId, workspace, service } = makeService({
            config: {
                proxyMode: "sidecar",
                proxyUrl: "http://proxy:54322/v1",
                network: "bridge",
            },
            runner: createFakeSandbox({ networkIsInternal: false }),
            probeBroker: async () => true,
        });

        const result = await service.start({
            userId,
            repo: "luke/app",
            task: "Install a dependency",
        });

        expect(result).toMatchObject({ ok: false, code: "egress-unsafe" });
        expect(workspace.prepared).toHaveLength(0);
    });

    it("reads one of the caller's jobs and lists their recent ones", async () => {
        const { userId, service } = makeService();
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Fix it",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }

        expect(service.get(userId, started.job.id)?.id).toBe(started.job.id);
        expect(service.get(userId + 1, started.job.id)).toBeNull();
        expect(
            service.list(userId, { includeSettled: true }).map((job) => job.id),
        ).toContain(started.job.id);

        await service.stop(userId, started.job.id);
        await started.done;
    });

    it("reads a running job's live log when the row has no tail", async () => {
        const { userId, service, runner, logRoot } = makeService();
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Fix it",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }
        const containerId = started.job.containerId ?? "";
        runner.emit(containerId, "line one");
        runner.emit(containerId, "line two");
        // The row's `logTail` is written at settle; the file is live.
        const file = path.join(logRoot, `${started.job.id}.log`);
        await vi.waitFor(() => {
            if (!existsSync(file)) {
                throw new Error("log not created yet");
            }
            expect(readFileSync(file, "utf8")).toContain("line two");
        });

        expect(await service.output(userId, started.job.id, 64)).toContain(
            "line two",
        );
        expect(await service.output(userId + 1, started.job.id)).toBeNull();

        await service.stop(userId, started.job.id);
        await started.done;
    });

    it("parks a job on its questions, posts them and keeps the workspace", async () => {
        const root = tempDir("jarvis-await-");
        const workspace = fakeWorkspace({ root });
        const comments: Array<{
            owner: string;
            repo: string;
            number: number;
            body: string;
        }> = [];
        const { userId, runner, service, notify, store } = makeService({
            config: {
                workspaceRoot: root,
                workspaceHostRoot: path.join(root, "host"),
            },
            workspace,
            issues: async () => issueSnapshot({ number: 12 }),
            commentOnIssue: async (input) => {
                comments.push(input);
                return {
                    id: 77,
                    url: "https://github.com/luke/app/issues/12#issuecomment-77",
                };
            },
        });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Build the thing",
            issue: 12,
            sessionId: "ses_chat",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }
        const workspacePath = started.job.workspacePath;
        mkdirSync(path.join(workspacePath, ".jarvis"), { recursive: true });
        writeFileSync(
            path.join(workspacePath, ".jarvis", "plan.md"),
            "Plan: use Postgres.",
        );
        writeFileSync(
            path.join(workspacePath, ".jarvis", "questions.json"),
            JSON.stringify({ questions: ["Which database?", "Which port?"] }),
        );

        runner.emit(started.job.containerId ?? "", "thinking…");
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        const row = store.getCodingJobById(started.job.id);
        expect(row).toMatchObject({
            state: "awaiting-answer",
            issueNumber: 12,
            questionCommentId: 77,
            lastSeenCommentId: 77,
            plan: "Plan: use Postgres.",
            finishedAt: null,
            sessionId: "ses_chat",
            questions: ["Which database?", "Which port?"],
        });
        expect(comments).toHaveLength(1);
        expect(comments[0]?.number).toBe(12);
        expect(comments[0]?.body).toContain("Which database?");
        expect(comments[0]?.body).toContain("Which port?");
        expect(comments[0]?.body).toContain(
            `<!-- jarvis:questions job=${started.job.id} -->`,
        );
        // Nothing was committed or published, and the tree is still there for
        // the answer follow-up; only the artifacts were removed.
        expect(workspace.commits).toHaveLength(0);
        expect(workspace.pushes).toHaveLength(0);
        expect(workspace.removed).toHaveLength(0);
        expect(existsSync(path.join(workspacePath, ".jarvis"))).toBe(false);
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({
                kind: "coding.question",
                // The answer resumes the job, so the record must ask for one
                // and name where it goes (#94).
                requiresAnswer: true,
                codingJobId: started.job.id,
            }),
        );
        expect(store.listAwaitingCodingJobs(10).map((job) => job.id)).toEqual([
            started.job.id,
        ]);
        // The in-session relay's feed: only the conversation that asked sees
        // the questions, and the row carries them without the workspace.
        expect(
            store
                .listAwaitingCodingJobsBySession(userId, "ses_chat", 5)
                .map((job) => ({ id: job.id, questions: job.questions })),
        ).toEqual([
            {
                id: started.job.id,
                questions: ["Which database?", "Which port?"],
            },
        ]);
    });

    it("resumes the same workspace and prompt with the answers", async () => {
        const root = tempDir("jarvis-resume-");
        const workspace = fakeWorkspace({ root });
        const { userId, runner, service, store, notify } = makeService({
            config: {
                workspaceRoot: root,
                workspaceHostRoot: path.join(root, "host"),
            },
            workspace,
            issues: async () => issueSnapshot({ number: 12 }),
        });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Build the thing",
            issue: 12,
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }
        const workspacePath = started.job.workspacePath;
        mkdirSync(path.join(workspacePath, ".jarvis"), { recursive: true });
        writeFileSync(
            path.join(workspacePath, ".jarvis", "plan.md"),
            "Plan: use Postgres.",
        );
        writeFileSync(
            path.join(workspacePath, ".jarvis", "questions.json"),
            JSON.stringify({ questions: ["Which database?"] }),
        );
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        const resumed = await service.resume(
            userId,
            started.job.id,
            "Use Postgres on 5432.",
            { notificationId: "n1" },
        );
        if (!resumed.ok) {
            throw new Error(`refused: ${resumed.reason}`);
        }

        expect(resumed.job).toMatchObject({
            state: "running",
            attempts: 2,
            workspacePath,
        });
        // The same tree, mapped to the daemon's view; no second clone.
        expect(workspace.prepared).toHaveLength(1);
        expect(runner.started[1]?.workspacePath).toBe(
            path.join(root, "host", started.job.id, "repo"),
        );
        const prompt = runner.started[1]?.env.JARVIS_JOB_PROMPT ?? "";
        expect(prompt).toContain("Use Postgres on 5432.");
        expect(prompt).toContain("Your previous plan");
        expect(prompt).toContain("Plan: use Postgres.");
        // The resume retires the question rows it did not come through: the
        // route's own row is excluded so it can carry the answer text (#94).
        expect(notify.settleCodingQuestion).toHaveBeenCalledWith(
            userId,
            started.job.id,
            { exceptId: "n1" },
        );

        runner.exit(resumed.job.containerId ?? "", 0);
        await resumed.done;
        expect(store.getCodingJobById(started.job.id)?.state).toBe("ok");
    });

    it("cancels a parked job and removes its workspace", async () => {
        const root = tempDir("jarvis-cancel-await-");
        const workspace = fakeWorkspace({ root });
        const { userId, runner, service, store } = makeService({
            config: {
                workspaceRoot: root,
                workspaceHostRoot: path.join(root, "host"),
            },
            workspace,
        });
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Build the thing",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }
        mkdirSync(path.join(started.job.workspacePath, ".jarvis"), {
            recursive: true,
        });
        writeFileSync(
            path.join(started.job.workspacePath, ".jarvis", "questions.json"),
            JSON.stringify({ questions: ["Which database?"] }),
        );
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        const stopped = await service.stop(userId, started.job.id);
        expect(stopped?.state).toBe("cancelled");
        expect(store.getCodingJobById(started.job.id)?.state).toBe("cancelled");
        expect(workspace.removed).toContain(started.job.workspacePath);
    });

    it("puts the plan in the publisher's input on a completed run", async () => {
        const root = tempDir("jarvis-plan-");
        const workspace = fakeWorkspace({ root });
        const publish = vi.fn(async () => ({
            prUrl: "https://github.com/luke/app/pull/9",
        }));
        const { userId, runner, service } = makeService({
            config: {
                workspaceRoot: root,
                workspaceHostRoot: path.join(root, "host"),
            },
            workspace,
            publisher: { publish },
        });
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Build the thing",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }
        mkdirSync(path.join(started.job.workspacePath, ".jarvis"), {
            recursive: true,
        });
        writeFileSync(
            path.join(started.job.workspacePath, ".jarvis", "plan.md"),
            "Plan: change one file.",
        );
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({ plan: "Plan: change one file." }),
        );
    });

    it("names a failed repository check instead of a bare exit code", async () => {
        const { store, userId, runner, service } = makeService();
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Fix it",
        });
        if (!started.ok) {
            throw new Error(`refused: ${started.reason}`);
        }
        const containerId = started.job.containerId ?? "";
        runner.emit(containerId, "JARVIS: running npm run check");
        runner.emit(
            containerId,
            "JARVIS_CHECK_FAILED: npm run check failed; the job will not publish",
        );
        runner.exit(containerId, 1);
        await started.done;

        const row = store.getCodingJobById(started.job.id);
        expect(row?.state).toBe("failed");
        expect(row?.lastError).toContain("check failed");
    });

    it("records a failed run, removes its workspace and says why", async () => {
        const { store, userId, workspace, runner, notify, service } =
            makeService();
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Break the build",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }

        runner.emit(started.job.containerId ?? "", "error: tests failed");
        runner.exit(started.job.containerId ?? "", 1);
        await started.done;

        const settled = store.getCodingJobById("job-1");
        expect(settled?.state).toBe("failed");
        expect(settled?.lastError).toContain("exited with code 1");
        expect(settled?.logTail).toContain("error: tests failed");
        expect(workspace.removed).toEqual(["/jobs/job-1/repo"]);
        // A failed tree is discarded, not committed.
        expect(workspace.commits).toEqual([]);
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({ kind: "coding.failed" }),
        );
    });

    it("stops a job that overruns its wall clock", async () => {
        vi.useFakeTimers();
        try {
            const { store, userId, runner, service } = makeService();
            const started = await service.start({
                userId,
                repo: "luke/app",
                task: "Ruminate forever",
            });
            if (!started.ok) {
                throw new Error("fixture refused");
            }

            await vi.advanceTimersByTimeAsync(CONFIG.wallClockMs);
            await started.done;

            const settled = store.getCodingJobById("job-1");
            expect(settled?.state).toBe("failed");
            expect(settled?.lastError).toContain("wall clock");
            // The fake's stop ends the container, which is what unblocks the
            // supervisor's log stream.
            expect(runner.removed).toContain(started.job.containerId);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops a job whose workspace exceeds its disk quota", async () => {
        vi.useFakeTimers();
        try {
            let bytes = 0;
            const { store, userId, runner, service, notify } = makeService({
                config: { maxWorkspaceMb: 1 },
                workspaceSize: async () => bytes,
            });
            const started = await service.start({
                userId,
                repo: "luke/app",
                task: "Generate every asset",
            });
            if (!started.ok) {
                throw new Error("fixture refused");
            }

            // The tree crosses the limit between two samples.
            bytes = 2 * 1024 * 1024;
            await vi.advanceTimersByTimeAsync(10_000);
            await started.done;

            const settled = store.getCodingJobById("job-1");
            expect(settled?.state).toBe("failed");
            expect(settled?.lastError).toContain("disk quota");
            // The fake's stop ends the container, which unblocks the supervisor.
            expect(runner.removed).toContain(started.job.containerId);
            expect(notify.notify).toHaveBeenCalledWith(
                userId,
                expect.objectContaining({ kind: "coding.failed" }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("says a no-change run made no changes, and repeats the agent's words", async () => {
        const workspace = fakeWorkspace({
            collect: () => ({ changed: false, diffSummary: "" }),
        });
        const { store, userId, runner, notify, service } = makeService({
            workspace,
        });
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Change the primary color",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }

        runner.emit(
            started.job.containerId ?? "",
            JSON.stringify({
                type: "text",
                part: { text: "I cannot do that without a file to edit." },
            }),
        );
        runner.exit(started.job.containerId ?? "", 0);
        await started.done;

        // Exit 0 is still `ok` — the run completed — but the announcement must
        // not read as "done": the agent changed nothing and explained why.
        expect(store.getCodingJobById("job-1")?.state).toBe("ok");
        const [, input] = notify.notify.mock.calls[0] as [
            number,
            { title: string; body: string },
        ];
        expect(input.title).toContain("no changes");
        expect(input.body).toContain(
            "I cannot do that without a file to edit.",
        );
    });

    it("never passes the provider key to the job, and never needs one locally", async () => {
        const withKey = makeService({ config: { apiKey: "sk-test" } });
        const started = await withKey.service.start({
            userId: withKey.userId,
            repo: "luke/app",
            task: "do it",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }
        // A configured key is the broker's, not the container's: without a
        // broker the job gets no key at all (#141).
        expect(withKey.runner.started[0]?.env).not.toHaveProperty(
            "JARVIS_JOB_API_KEY",
        );

        // A local endpoint runs without a key (the test config is
        // host.docker.internal, i.e. local).
        const local = makeService();
        const localStarted = await local.service.start({
            userId: local.userId,
            repo: "luke/app",
            task: "do it",
        });
        expect(localStarted.ok).toBe(true);
        expect(local.runner.started[0]?.env).not.toHaveProperty(
            "JARVIS_JOB_API_KEY",
        );
    });

    it("hands a job the broker's token rather than the provider key", async () => {
        const secret = "broker-secret-that-is-long-enough-1234";
        const { userId, runner, service } = makeService({
            config: { apiKey: "sk-real-provider-key" },
            proxy: { url: "http://host.docker.internal:54322/v1", secret },
        });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "do it",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }

        const env = runner.started[0]?.env ?? {};
        expect(env.JARVIS_JOB_LLM_BASE_URL).toBe(
            "http://host.docker.internal:54322/v1",
        );
        expect(env.JARVIS_JOB_API_KEY).toBe(
            deriveJobToken(secret, started.job.id),
        );
        // The whole point: the real key is not in the container at all.
        expect(env.JARVIS_JOB_API_KEY).not.toBe("sk-real-provider-key");
    });

    it("publishes a successful branch and drops the clone after the push", async () => {
        const publish = vi.fn(async () => ({
            prUrl: "https://github.com/luke/app/pull/9",
        }));
        const { service, userId, runner, workspace, store, notify } =
            makeService({ publisher: { publish } });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Fix the login bug",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }
        const container = started.job.containerId ?? "";
        runner.emit(container, '{"type":"text","part":{"text":"done"}}');
        runner.exit(container, 0);
        await started.done;

        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({
                jobId: started.job.id,
                repo: "luke/app",
                branch: started.job.branch,
                task: "Fix the login bug",
            }),
        );
        expect(store.getCodingJobById(started.job.id)?.prUrl).toBe(
            "https://github.com/luke/app/pull/9",
        );
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({
                body: expect.stringContaining(
                    "Pull request: https://github.com/luke/app/pull/9",
                ),
            }),
        );
        // Pushed means disposable: the remote is the copy (#140).
        expect(workspace.removed).toContain("/jobs/job-1/repo");
    });

    it("still settles ok when publishing fails, and keeps the workspace", async () => {
        const publish = vi.fn(async () => {
            throw new Error("no permission");
        });
        const { service, userId, runner, workspace, store, notify } =
            makeService({ publisher: { publish } });

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "Fix the login bug",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }
        const container = started.job.containerId ?? "";
        runner.emit(container, '{"type":"text","part":{"text":"done"}}');
        runner.exit(container, 0);
        await started.done;

        const row = store.getCodingJobById(started.job.id);
        expect(row?.state).toBe("ok");
        expect(row?.prUrl).toBeNull();
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({
                body: expect.stringContaining(
                    "The branch was not pushed: no permission",
                ),
            }),
        );
        expect(workspace.removed).toEqual([]);
    });

    it("writes the full run to a log file beside the workspaces", async () => {
        const { service, userId, runner, logRoot } = makeService();

        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "do it",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }
        const container = started.job.containerId ?? "";
        runner.emit(container, '{"type":"text","part":{"text":"hello"}}');
        runner.exit(container, 0);
        await started.done;

        const log = readFileSync(
            path.join(logRoot, `${started.job.id}.log`),
            "utf8",
        );
        expect(log).toContain('"hello"');
    });

    it("sweeps expired workspaces and logs at boot, keeping live ones", async () => {
        const jobsRoot = tempDir("jarvis-jobs-");
        const logRoot = tempDir("jarvis-logs-");
        const { service, store, userId } = makeService({
            config: {
                workspaceRoot: jobsRoot,
                workspaceHostRoot: jobsRoot,
                logRoot,
            },
        });

        const seed = (id: string, kind: "queued" | "old" | "fresh") => {
            const repo = path.join(jobsRoot, id, "repo");
            mkdirSync(repo, { recursive: true });
            store.createCodingJob(userId, {
                id,
                repo: "luke/app",
                branch: "jarvis/test",
                prompt: "do it",
                workspacePath: repo,
                crashPolicy: "prune",
                model: "lmstudio/qwen3",
                createdAt: "2026-09-01T00:00:00.000Z",
            });
            if (kind === "queued") {
                return;
            }
            store.claimCodingJob(
                id,
                `container-${id}`,
                "2026-09-01T00:00:01.000Z",
            );
            store.settleCodingJob(
                id,
                "ok",
                {},
                kind === "old"
                    ? "2026-09-02T00:00:00.000Z"
                    : "2026-10-18T00:00:00.000Z",
            );
        };
        seed("old-job", "old");
        seed("fresh-job", "fresh");
        seed("live-job", "queued");
        mkdirSync(path.join(jobsRoot, "rowless", "repo"), { recursive: true });

        const oldLog = path.join(logRoot, "old.log");
        const freshLog = path.join(logRoot, "fresh.log");
        writeFileSync(oldLog, "old\n");
        writeFileSync(freshLog, "fresh\n");
        const longAgo = new Date("2026-08-01T00:00:00.000Z");
        utimesSync(oldLog, longAgo, longAgo);

        await service.recover();

        expect(existsSync(path.join(jobsRoot, "old-job"))).toBe(false);
        expect(existsSync(path.join(jobsRoot, "rowless"))).toBe(false);
        expect(existsSync(path.join(jobsRoot, "fresh-job"))).toBe(true);
        expect(existsSync(path.join(jobsRoot, "live-job"))).toBe(true);
        expect(existsSync(oldLog)).toBe(false);
        expect(existsSync(freshLog)).toBe(true);
    });

    it("prunes settled rows past the keep count on every settle", async () => {
        const { service, userId, runner, store } = makeService({
            config: { keepJobRows: 1 },
        });

        for (const task of ["first", "second"]) {
            const started = await service.start({
                userId,
                repo: "luke/app",
                task,
            });
            if (!started.ok) {
                throw new Error("fixture refused");
            }
            runner.exit(started.job.containerId ?? "", 0);
            await started.done;
        }

        const rows = store.listCodingJobs(userId, { includeSettled: true });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.prompt).toBe("second");
    });

    it("refuses a remote endpoint with no key, before any clone", async () => {
        const remote = makeService({
            config: {
                llmBaseUrl: "https://opencode.ai/inference/go/openai/v1",
                models: [{ id: "deepseek-v4.1-flash", contextTokens: 400_000 }],
                apiKey: "",
            },
        });

        const refused = await remote.service.start({
            userId: remote.userId,
            repo: "luke/app",
            task: "do it",
        });

        expect(refused).toMatchObject({ ok: false, code: "key-missing" });
        expect(remote.workspace.prepared).toHaveLength(0);
        expect(remote.runner.started).toHaveLength(0);
    });

    it("refuses a missing task, a missing model, a foreign repo and a full queue", async () => {
        const missingTask = makeService();
        expect(
            await missingTask.service.start({
                userId: missingTask.userId,
                repo: "luke/app",
                task: "   ",
            }),
        ).toMatchObject({ ok: false, code: "task-missing" });

        const noModel = makeService({ config: { models: [] } });
        expect(
            await noModel.service.start({
                userId: noModel.userId,
                repo: "luke/app",
                task: "do it",
            }),
        ).toMatchObject({ ok: false, code: "model-missing" });

        const foreign = makeService({
            workspace: fakeWorkspace({ allow: false }),
        });
        const refused = await foreign.service.start({
            userId: foreign.userId,
            repo: "someone/else",
            task: "do it",
        });
        expect(refused).toMatchObject({ ok: false, code: "repo-not-allowed" });
        expect(foreign.runner.started).toHaveLength(0);

        const busy = makeService();
        const first = await busy.service.start({
            userId: busy.userId,
            repo: "luke/app",
            task: "first",
        });
        expect(first.ok).toBe(true);
        expect(
            await busy.service.start({
                userId: busy.userId,
                repo: "luke/app",
                task: "second",
            }),
        ).toMatchObject({ ok: false, code: "busy" });
        // Only one clone and one container were ever made.
        expect(busy.workspace.prepared).toHaveLength(1);
        expect(busy.runner.started).toHaveLength(1);
    });
});

describe("agent messages", () => {
    it("reads the agent's last text from its JSON stream", () => {
        const tail = [
            JSON.stringify({ type: "step_start" }),
            JSON.stringify({ type: "text", part: { text: "looking…" } }),
            JSON.stringify({ type: "step_finish" }),
            JSON.stringify({
                type: "text",
                part: { text: "I changed the color." },
            }),
            "",
        ].join("\n");

        expect(lastAgentMessage(tail)).toBe("I changed the color.");
    });

    it("skips non-text frames, truncated lines and empty messages", () => {
        const tail = [
            JSON.stringify({ type: "tool", part: { text: "not a message" } }),
            '{"type":"text","part":{"text":"cut off',
            JSON.stringify({ type: "text", part: { text: "   " } }),
        ].join("\n");

        expect(lastAgentMessage(tail)).toBe("");
    });

    it("returns nothing for output that is not JSON at all", () => {
        expect(lastAgentMessage("plain text\nmore text\n")).toBe("");
    });
});

describe("stopping a coding job", () => {
    it("settles cancelled, reaps the container and stays silent", async () => {
        const { store, userId, workspace, runner, notify, service } =
            makeService();
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "long task",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }

        const cancelled = await service.stop(userId, "job-1");
        expect(cancelled?.state).toBe("cancelled");
        expect(runner.removed).toContain(started.job.containerId);
        expect(workspace.removed).toEqual(["/jobs/job-1/repo"]);

        // The supervisor was already watching; the terminal guard keeps it
        // from announcing a failure for the user's own decision.
        await started.done;
        expect(store.getCodingJobById("job-1")?.state).toBe("cancelled");
        expect(notify.notify).not.toHaveBeenCalled();
    });

    it("is a miss for a foreign id and a no-op for a settled job", async () => {
        const { store, userId, service } = makeService();
        expect(await service.stop(userId, "nope")).toBeNull();

        const other = store.createUser("sam", "hash", "user");
        const started = await service.start({
            userId,
            repo: "luke/app",
            task: "do it",
        });
        if (!started.ok) {
            throw new Error("fixture refused");
        }
        expect(await service.stop(other.id, "job-1")).toBeNull();
        expect(store.getCodingJobById("job-1")?.state).toBe("running");
    });
});

describe("recovering coding jobs at boot", () => {
    it("prunes a running container, keeping its tail as evidence", async () => {
        const { store, userId } = makeStore();
        store.createCodingJob(userId, {
            id: "job-1",
            repo: "luke/app",
            branch: "jarvis/one",
            prompt: "do it",
            workspacePath: "/jobs/job-1/repo",
            createdAt: "2026-10-19T11:00:00.000Z",
        });
        store.claimCodingJob("job-1", "c-1", "2026-10-19T11:01:00.000Z");

        const runner = createFakeSandbox({
            containers: [
                {
                    containerId: "c-1",
                    jobId: "job-1",
                    logs: ["was working on it"],
                },
            ],
        });
        const workspace = fakeWorkspace();
        const notify = notifications();
        const service = createCodingJobService({
            ledger: store,
            runner,
            workspace,
            config: CONFIG,
            notifications: notify,
            now: () => new Date("2026-10-19T12:00:00.000Z"),
        });

        const summary = await service.recover();

        expect(summary).toMatchObject({ pruned: 1, adopted: 0, failed: 0 });
        const settled = store.getCodingJobById("job-1");
        expect(settled?.state).toBe("failed");
        expect(settled?.lastError).toContain("server restarted");
        expect(settled?.logTail).toContain("was working on it");
        expect(runner.removed).toContain("c-1");
        expect(workspace.removed).toEqual(["/jobs/job-1/repo"]);
        expect(notify.notify).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({ kind: "coding.failed" }),
        );
    });

    it("adopts a resume job and keeps watching it", async () => {
        const { store, userId } = makeStore();
        store.createCodingJob(userId, {
            id: "job-1",
            repo: "luke/app",
            branch: "jarvis/one",
            prompt: "do it",
            workspacePath: "/jobs/job-1/repo",
            crashPolicy: "resume",
            createdAt: "2026-10-19T11:00:00.000Z",
        });
        store.claimCodingJob("job-1", "c-1", "2026-10-19T11:01:00.000Z");

        const runner = createFakeSandbox({
            containers: [{ containerId: "c-1", jobId: "job-1" }],
        });
        const service = createCodingJobService({
            ledger: store,
            runner,
            workspace: fakeWorkspace(),
            config: CONFIG,
            now: () => new Date("2026-10-19T12:00:00.000Z"),
        });

        const summary = await service.recover();
        expect(summary.adopted).toBe(1);
        expect(runner.removed).toEqual([]);
        // Still running: adoption is a continuation, not a settlement.
        expect(store.getCodingJobById("job-1")?.state).toBe("running");

        runner.exit("c-1", 0);
        await vi.waitFor(() => {
            expect(store.getCodingJobById("job-1")?.state).toBe("ok");
        });
    });

    it("discards a container with no row and its workspace", async () => {
        const { store } = makeStore();
        const runner = createFakeSandbox({
            containers: [{ containerId: "c-ghost", jobId: "deleted-job" }],
        });
        const workspace = fakeWorkspace();
        const service = createCodingJobService({
            ledger: store,
            runner,
            workspace,
            config: CONFIG,
            now: () => new Date("2026-10-19T12:00:00.000Z"),
        });

        const summary = await service.recover();

        expect(summary.removed).toBe(1);
        expect(runner.removed).toEqual(["c-ghost"]);
        // The row is gone, but the workspace's path is derivable from the id
        // the container's label carried.
        expect(workspace.removed).toEqual(["/jobs/deleted-job/repo"]);
    });
});

describe("follow-up prompts", () => {
    it("says when the conversation is missing rather than implying silence", () => {
        const prompt = followUpPrompt(
            pullRequest({ conversationUnavailable: true }),
            "Fix the review",
        );

        expect(prompt).toContain("conversation could not be read");
        expect(prompt).toContain("Fix the review");
    });

    it("bounds a long thread and says what was left out", () => {
        const prompt = followUpPrompt(
            pullRequest({
                comments: [
                    {
                        id: 103,
                        url: "https://github.com/luke/app/pull/7#discussion_r103",
                        author: "reviewer",
                        body: "x".repeat(5_000),
                        createdAt: "2026-10-20T23:50:00Z",
                        updatedAt: "2026-10-20T23:50:00Z",
                        resolved: false,
                    },
                ],
                commentsTruncated: true,
            }),
            "Fix the review",
        );

        expect(prompt).toContain("Only the most recent comments are shown.");
        expect(prompt.length).toBeLessThan(20_000);
    });
});

describe("brokerAnswers", () => {
    it("counts any HTTP answer, including the 401 an unauthenticated call gets", async () => {
        const { createServer } = await import("node:http");
        const server = createServer((_req, res) => {
            res.writeHead(401).end();
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        const port =
            typeof address === "object" && address !== null ? address.port : 0;
        try {
            expect(await brokerAnswers(`http://127.0.0.1:${port}/v1`)).toBe(
                true,
            );
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("is false when nothing is listening", async () => {
        expect(await brokerAnswers("http://127.0.0.1:1/v1")).toBe(false);
    });
});
