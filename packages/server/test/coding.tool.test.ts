/**
 * `startCodingJob` tool tests (#141).
 *
 * The tool is deliberately thin: it gates identity, renders refusals in the
 * model's voice, and hands everything else to the service. So this suite tests
 * exactly that — a guest is refused, a non-owner is refused, every refusal code
 * becomes a sentence instead of a stack, and a start hands the service what the
 * user asked for. The sandbox itself is covered by its own suites and the
 * real-container probe.
 */
import { describe, expect, it } from "vitest";
import type { AppCodingJob } from "@lukestanbery/jarvis-auth";
import { createCodingTool, type CodingToolDeps } from "../src/llm/tools/coding";
import type {
    CodingJobService,
    StartCodingJobResult,
} from "../src/sandbox/service";

/** A claimed row, as the service would return it. */
const JOB: AppCodingJob = {
    id: "job-1",
    userId: 7,
    repo: "luke/app",
    branch: "jarvis/fix-it-12345678",
    prompt: "fix it",
    state: "running",
    crashPolicy: "prune",
    containerId: "c-1",
    workspacePath: "/jobs/job-1/repo",
    logTail: "",
    diffSummary: null,
    prUrl: null,
    attempts: 1,
    lastError: null,
    createdAt: "2026-10-19T12:00:00.000Z",
    startedAt: "2026-10-19T12:00:01.000Z",
    finishedAt: null,
};

const OWNER_RUNTIME = {
    configurable: { sessionId: "s1", clientIp: "10.0.0.1", userId: 7 },
};
const GUEST_RUNTIME = {
    configurable: { sessionId: "s1", clientIp: "10.0.0.1" },
};

/** One tool invocation's result: what the model sees and what the service got. */
interface Invocation {
    text: string;
    calls: Parameters<CodingJobService["start"]>[0][];
}

/** Builds the tool and invokes it, recording the service call. */
async function invoke(
    script: StartCodingJobResult | Error,
    options: {
        runtime?: unknown;
        owner?: boolean;
        repos?: string[];
        input?: {
            repo?: string;
            task?: string;
            crashPolicy?: "prune" | "resume";
        };
        /** Leave `repo` out of the call entirely, as a small model may. */
        omitRepo?: boolean;
    } = {},
): Promise<Invocation> {
    const calls: Parameters<CodingJobService["start"]>[0][] = [];
    const service: CodingJobService = {
        async start(input) {
            calls.push(input);
            if (script instanceof Error) {
                throw script;
            }
            // Echo the policy the caller asked for, as the real service would
            // store it, so the tool's sentence can be asserted.
            return script.ok && input.crashPolicy !== undefined
                ? {
                      ...script,
                      job: { ...script.job, crashPolicy: input.crashPolicy },
                  }
                : script;
        },
        async recover() {
            return {
                adopted: 0,
                pruned: 0,
                failed: 0,
                removed: 0,
                errors: 0,
            };
        },
        async stop() {
            return null;
        },
    };
    const deps: CodingToolDeps = {
        service,
        isOwner: (userId) => (options.owner ?? true) && userId === 7,
        repos: options.repos ?? ["luke/app"],
    };
    const tool = createCodingTool(deps);
    const input = options.input ?? {};
    const text = (await tool.invoke(
        {
            ...(options.omitRepo ? {} : { repo: input.repo ?? "luke/app" }),
            task: input.task ?? "Fix the login bug",
            ...(input.crashPolicy ? { crashPolicy: input.crashPolicy } : {}),
        },
        (options.runtime ?? OWNER_RUNTIME) as never,
    )) as string;
    return { text, calls };
}

describe("startCodingJob", () => {
    it("refuses a guest before the service is reached", async () => {
        const { text, calls } = await invoke(
            { ok: true, job: JOB, done: Promise.resolve() },
            { runtime: GUEST_RUNTIME },
        );

        expect(text.toLowerCase()).toContain("sign");
        expect(calls).toHaveLength(0);
    });

    it("refuses a signed-in non-owner", async () => {
        const { text, calls } = await invoke(
            { ok: true, job: JOB, done: Promise.resolve() },
            { owner: false },
        );

        expect(text).toContain("owner account");
        expect(calls).toHaveLength(0);
    });

    it("turns refusals into sentences, naming the allowlist when it matters", async () => {
        const repo = await invoke(
            { ok: false, code: "repo-not-allowed", reason: "not allowed" },
            { repos: ["luke/app", "luke/other"] },
        );
        expect(repo.text).toContain("allowlist");
        expect(repo.text).toContain("luke/app, luke/other");
        // The refusal is a next step, not a question for the user: a small
        // model reads it as an instruction and retries.
        expect(repo.text).toContain("Call again with one of those");

        const busy = await invoke({
            ok: false,
            code: "busy",
            reason: "one is running",
        });
        expect(busy.text).toContain("already running");

        const model = await invoke({
            ok: false,
            code: "model-missing",
            reason: "no model",
        });
        expect(model.text).toContain("without a model");

        const key = await invoke({
            ok: false,
            code: "key-missing",
            reason: "no key",
        });
        expect(key.text).toContain("no model API key");

        const task = await invoke({
            ok: false,
            code: "task-missing",
            reason: "no task",
        });
        expect(task.text).toContain("needs a task");
    });

    it("starts a job and reports its id and branch without claiming the work", async () => {
        const { text, calls } = await invoke(
            { ok: true, job: JOB, done: Promise.resolve() },
            { input: { crashPolicy: "resume" } },
        );

        expect(text).toContain("job-1");
        expect(text).toContain(JOB.branch);
        expect(text).toContain("resumed");
        expect(text).toContain("notify you");
        expect(calls).toEqual([
            {
                userId: 7,
                repo: "luke/app",
                task: "Fix the login bug",
                crashPolicy: "resume",
            },
        ]);
    });

    it("uses the only allowed repository when the user names none", async () => {
        const { text, calls } = await invoke(
            { ok: true, job: JOB, done: Promise.resolve() },
            { omitRepo: true, repos: ["luke/app"] },
        );

        expect(text).toContain("job-1");
        expect(calls[0]?.repo).toBe("luke/app");
    });

    it("asks which repository when none was named and several are allowed", async () => {
        const { text, calls } = await invoke(
            { ok: true, job: JOB, done: Promise.resolve() },
            { omitRepo: true, repos: ["luke/app", "luke/other"] },
        );

        expect(text).toContain("Which repository?");
        expect(text).toContain("luke/app, luke/other");
        expect(calls).toHaveLength(0);
    });

    it("says there is nowhere to work when the allowlist is empty", async () => {
        const { text, calls } = await invoke(
            { ok: true, job: JOB, done: Promise.resolve() },
            { omitRepo: true, repos: [] },
        );

        expect(text).toContain("No repository is allowed");
        expect(calls).toHaveLength(0);
    });

    it("says so when the service throws, without leaking its message", async () => {
        const { text } = await invoke(new Error("docker is down"));

        expect(text).toContain("could not start");
        expect(text).not.toContain("docker is down");
    });
});
