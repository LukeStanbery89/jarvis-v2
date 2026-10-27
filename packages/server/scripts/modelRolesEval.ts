/**
 * Warm latency and routing-correctness harness for the two-role agent (#214).
 *
 * This is deliberately a script, not a CI test: it needs a live
 * OpenAI-compatible endpoint with both `LLM_MODEL` (writer) and
 * `LLM_ROUTER_MODEL` (router) resident. It uses side-effect-free stub tools so
 * a benchmark cannot create a timer, send a notification, file an issue, or
 * start a coding job.
 *
 * Run from `packages/server`:
 *
 *     LLM_ROUTER_MODEL=qwen/qwen3-4b-2507 npm run eval:model-roles
 *
 * Optional flags: `--samples=N` (default 3), `--limit=N` (first N prompts).
 *
 * The harness preloads and warms both models, discards those calls, runs each
 * prompt through the legacy single-model graph and the split graph, and prints
 * p50/p95 total latency, TTFT, and tool-selection accuracy. A run whose TTFT
 * is a cold-load outlier is excluded from latency and counted; the report
 * states how many were discarded. The script does not enforce the issue's
 * gates by exiting non-zero — the implementation PR records the result.
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { HumanMessage } from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import {
    baseSystemPrompt,
    routerSystemPrompt,
    systemPromptForCapabilities,
    writerSystemPrompt,
} from "../src/agent";
import { createChatModel } from "../src/llm/chatModel";
import { createAgentGraph, streamAgentTurn } from "../src/llm/agentGraph";
import {
    DEFAULT_LLM_BASE_URL,
    DEFAULT_LLM_MODEL,
    DEFAULT_SYSTEM_PROMPT,
} from "../src/config";

/** The split is only meaningful when a distinct router model is configured. */
const routerModel = process.env.LLM_ROUTER_MODEL?.trim();
if (!routerModel) {
    console.error(
        "LLM_ROUTER_MODEL is unset. Set it to the small routing model (the writer comes from LLM_MODEL).",
    );
    process.exit(1);
}

/** Appended to both modes so output length does not decide the latency gate. */
const BENCH_RULE =
    "Keep the final answer to at most two short sentences. Do not explain the tools you used.";

/** A harmless, fixed-latency tool result. */
async function stubResult(text: string): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return text;
}

/**
 * A representative tool surface. Names and descriptions mirror the real
 * registry closely enough for routing; handlers only return fixed text.
 */
const tools: StructuredToolInterface[] = [
    tool(
        async ({ question }: { question: string }) =>
            stubResult(`The current time is 12:00 PM (question: ${question}).`),
        {
            name: "getCurrentTime",
            description:
                "Returns the current time, date, or weekday. Pass the user's question verbatim as `question`.",
            schema: z.object({ question: z.string() }),
        },
    ),
    tool(
        async ({ expression }: { expression: string }) =>
            stubResult(`Result: 42 (for ${expression}).`),
        {
            name: "calculate",
            description:
                "Evaluates an arithmetic expression. Use it for math the user asks you to compute.",
            schema: z.object({ expression: z.string() }),
        },
    ),
    tool(
        async ({ query }: { query: string; kind?: string }) =>
            stubResult(
                `1. Example result for ${query} — https://example.com/result\n   A short snippet.`,
            ),
        {
            name: "webSearch",
            description:
                "Searches the live web for current facts, news, prices, releases, or anything outside your memory. Returns titles, URLs, and snippets.",
            schema: z.object({
                query: z.string(),
                kind: z.string().optional(),
            }),
        },
    ),
    tool(
        async ({ location }: { location?: string; scope?: string }) =>
            stubResult(
                `Sunny and 72°F in ${location ?? "the user's location"}.`,
            ),
        {
            name: "getWeather",
            description:
                "Reports current conditions or a forecast for a location, using the device location when none is named.",
            schema: z.object({
                location: z.string().optional(),
                scope: z.string().optional(),
            }),
        },
    ),
    tool(
        async ({ query }: { query: string }) =>
            stubResult(`${query}: a concise encyclopedia summary.`),
        {
            name: "wikipedia",
            description:
                "Looks up a person, place, thing, event, or concept in Wikipedia. Use it for stable factual background.",
            schema: z.object({ query: z.string() }),
        },
    ),
    tool(
        async ({
            action,
            entity_id,
        }: {
            action: string;
            entity_id?: string;
            query?: string;
        }) =>
            stubResult(
                `Home Assistant ${action}${entity_id ? ` on ${entity_id}` : ""} completed.`,
            ),
        {
            name: "homeAssistant",
            description:
                "Reads or controls the user's Home Assistant devices. Discover ids with list/lights/switches, then act on one exact entity_id.",
            schema: z.object({
                action: z.string(),
                entity_id: z.string().optional(),
                query: z.string().optional(),
            }),
        },
    ),
    tool(
        async ({ title }: { title: string; body: string }) =>
            stubResult(`Notification "${title}" delivered.`),
        {
            name: "sendNotification",
            description:
                "Sends one notification to the user's devices. Use only when the user asked, or before a long task.",
            schema: z.object({ title: z.string(), body: z.string() }),
        },
    ),
    tool(
        async ({ minutes }: { minutes: number; label?: string }) =>
            stubResult(`Timer set for ${minutes} minutes.`),
        {
            name: "setTimer",
            description: "Sets a countdown timer for a number of minutes.",
            schema: z.object({
                minutes: z.number(),
                label: z.string().optional(),
            }),
        },
    ),
    tool(
        async ({ when }: { when: string; message: string }) =>
            stubResult(`Reminder set for ${when}.`),
        {
            name: "remindMe",
            description:
                "Sets a reminder at an absolute or relative time and announces it then.",
            schema: z.object({ when: z.string(), message: z.string() }),
        },
    ),
    tool(
        async ({ when, tool: name }: { when: string; tool: string }) =>
            stubResult(`Task scheduled for ${when} using ${name}.`),
        {
            name: "scheduleTask",
            description:
                "Runs a tool later at a specified time. Use it when the user wants a tool call scheduled.",
            schema: z.object({ when: z.string(), tool: z.string() }),
        },
    ),
    tool(
        async ({ when }: { when: string; prompt: string }) =>
            stubResult(`Prompt scheduled for ${when}.`),
        {
            name: "schedulePrompt",
            description:
                "Runs a prompt later at a specified time and announces the answer.",
            schema: z.object({ when: z.string(), prompt: z.string() }),
        },
    ),
    tool(async () => stubResult("No pending jobs."), {
        name: "listJobs",
        description: "Lists the user's pending scheduled jobs.",
        schema: z.object({}),
    }),
    tool(async ({ id }: { id: number }) => stubResult(`Job ${id} cancelled.`), {
        name: "cancelJob",
        description: "Cancels a scheduled job by id.",
        schema: z.object({ id: z.number() }),
    }),
    tool(
        async ({ id, minutes }: { id: number; minutes: number }) =>
            stubResult(`Reminder ${id} snoozed ${minutes} minutes.`),
        {
            name: "snoozeReminder",
            description: "Moves a reminder later by a number of minutes.",
            schema: z.object({ id: z.number(), minutes: z.number() }),
        },
    ),
    tool(
        async ({ attachmentId }: { attachmentId: string; query: string }) =>
            stubResult(`Image ${attachmentId}: a red bicycle.`),
        {
            name: "analyzeImage",
            description:
                "Analyzes an uploaded image. Pass the exact attachment id from the conversation marker.",
            schema: z.object({
                attachmentId: z.string(),
                query: z.string(),
            }),
        },
    ),
    tool(
        async ({ number }: { number: number }) =>
            stubResult(`Issue ${number}: a sample issue body.`),
        {
            name: "getGitHubIssue",
            description: "Reads one GitHub issue by number.",
            schema: z.object({ number: z.number() }),
        },
    ),
    tool(async () => stubResult("No open issues."), {
        name: "listGitHubIssues",
        description: "Lists GitHub issues in an allowed repository.",
        schema: z.object({ state: z.string().optional() }),
    }),
    tool(
        async ({ title }: { title: string }) =>
            stubResult(`Issue "${title}" created.`),
        {
            name: "createGitHubIssue",
            description: "Creates a GitHub issue in an allowed repository.",
            schema: z.object({
                title: z.string(),
                body: z.string().optional(),
            }),
        },
    ),
    tool(
        async ({ number }: { number: number }) =>
            stubResult(`Comment added to #${number}.`),
        {
            name: "commentOnGitHub",
            description:
                "Comments on a GitHub issue or pull request in an allowed repository.",
            schema: z.object({ number: z.number(), body: z.string() }),
        },
    ),
    tool(
        async ({ task }: { task: string }) =>
            stubResult(`Coding job j1 started for: ${task}`),
        {
            name: "startCodingJob",
            description:
                "Starts a sandboxed coding job to implement a task or GitHub issue.",
            schema: z.object({
                task: z.string().optional(),
                issue: z.string().optional(),
            }),
        },
    ),
    tool(
        async ({ id }: { id: string }) => stubResult(`Job ${id} is running.`),
        {
            name: "getCodingJob",
            description: "Reads a coding job's status, diff, and PR.",
            schema: z.object({ id: z.string() }),
        },
    ),
    tool(async ({ id }: { id: string }) => stubResult(`Job ${id} cancelled.`), {
        name: "cancelCodingJob",
        description: "Stops a running coding job.",
        schema: z.object({ id: z.string() }),
    }),
    tool(async ({ id }: { id: string }) => stubResult(`Job ${id} resumed.`), {
        name: "resumeCodingJob",
        description: "Sends a follow-up or answer to a coding job.",
        schema: z.object({ id: z.string(), message: z.string() }),
    }),
];

interface PromptCase {
    readonly prompt: string;
    readonly expected: readonly string[];
}

/** 20 single-tool, 10 no-tool, and 5 multi-tool prompts. */
const corpus: readonly PromptCase[] = [
    { prompt: "What time is it right now?", expected: ["getCurrentTime"] },
    { prompt: "What is 17 percent of 482?", expected: ["calculate"] },
    {
        prompt: "Search the web for the latest Taylor Swift album.",
        expected: ["webSearch"],
    },
    {
        prompt: "What's the weather in Portland, Oregon?",
        expected: ["getWeather"],
    },
    {
        prompt: "Who was Ada Lovelace? Use Wikipedia.",
        expected: ["wikipedia"],
    },
    {
        prompt: "Turn on the living room lamp.",
        expected: ["homeAssistant"],
    },
    {
        prompt: "Send me a notification that the build is done.",
        expected: ["sendNotification"],
    },
    {
        prompt: "Set a timer for 10 minutes.",
        expected: ["setTimer"],
    },
    {
        prompt: "Remind me to call Mom at 6pm.",
        expected: ["remindMe"],
    },
    {
        prompt: "Schedule a task to check the weather tomorrow at 8am.",
        expected: ["scheduleTask"],
    },
    {
        prompt: "Schedule a prompt to say good morning tomorrow at 7am.",
        expected: ["schedulePrompt"],
    },
    { prompt: "List my scheduled jobs.", expected: ["listJobs"] },
    { prompt: "Cancel job 42.", expected: ["cancelJob"] },
    {
        prompt: "Snooze my reminder for 10 minutes.",
        expected: ["snoozeReminder"],
    },
    {
        prompt: "Look at the image I uploaded [attachments: img-1] and tell me what it shows.",
        expected: ["analyzeImage"],
    },
    {
        prompt: "Read GitHub issue 214.",
        expected: ["getGitHubIssue"],
    },
    {
        prompt: "List the open GitHub issues.",
        expected: ["listGitHubIssues"],
    },
    {
        prompt: "Create a GitHub issue titled 'Test'.",
        expected: ["createGitHubIssue"],
    },
    {
        prompt: "Comment on GitHub issue 214 saying I'm looking.",
        expected: ["commentOnGitHub"],
    },
    {
        prompt: "Start a coding job to fix the failing tests.",
        expected: ["startCodingJob"],
    },
    {
        prompt: "What's the weather in Portland and set a timer for 20 minutes.",
        expected: ["getWeather", "setTimer"],
    },
    {
        prompt: "Search the web for the latest album and remind me tomorrow at 9am.",
        expected: ["webSearch", "remindMe"],
    },
    {
        prompt: "Check the current time and calculate 12 times 9.",
        expected: ["getCurrentTime", "calculate"],
    },
    {
        prompt: "Read issue 214 and start a coding job to implement it.",
        expected: ["getGitHubIssue", "startCodingJob"],
    },
    {
        prompt: "List my jobs and cancel job 42.",
        expected: ["listJobs", "cancelJob"],
    },
    { prompt: "Hello! How are you today?", expected: [] },
    { prompt: "Tell me a short joke.", expected: [] },
    { prompt: "Explain recursion in simple terms.", expected: [] },
    { prompt: "Write a two-line poem about the ocean.", expected: [] },
    { prompt: "Give me one productivity tip.", expected: [] },
    {
        prompt: "Draft a polite email asking for a meeting.",
        expected: [],
    },
    { prompt: "What does HTTP stand for?", expected: [] },
    { prompt: "How do I stay focused while working?", expected: [] },
    {
        prompt: "Summarize the plot of Romeo and Juliet in one sentence.",
        expected: [],
    },
    { prompt: "Say hello in Spanish.", expected: [] },
];

interface RunResult {
    readonly mode: "legacy" | "split";
    readonly case: PromptCase;
    readonly totalMs: number;
    readonly ttftMs: number;
    readonly tools: readonly string[];
    readonly text: string;
    readonly cold?: boolean;
}

/**
 * Reads LM Studio's loaded-model set, when the endpoint exposes it.
 *
 * The OpenAI-compatible `/v1/models` list does not say whether a model is
 * resident. LM Studio's own `/api/v0/models` does. Returning `null` for any
 * other endpoint keeps this harness usable with a generic provider; there the
 * warm-up and cold-sample filter remain the only guards.
 */
async function loadedModelIds(baseUrl: string): Promise<Set<string> | null> {
    const root = baseUrl.replace(/\/v1\/?$/, "");
    try {
        const response = await fetch(`${root}/api/v0/models`, {
            signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) {
            return null;
        }
        const payload = (await response.json()) as {
            data?: Array<{ id?: unknown; state?: unknown }>;
        };
        if (!Array.isArray(payload.data)) {
            return null;
        }
        return new Set(
            payload.data
                .filter(
                    (entry) =>
                        entry.state === "loaded" &&
                        typeof entry.id === "string",
                )
                .map((entry) => entry.id as string),
        );
    } catch {
        return null;
    }
}

/** Creates the graph and both role models. */
function createHarness() {
    const writer = createChatModel();
    const router = createChatModel({ role: "router" });
    const graph = createAgentGraph({
        model: writer,
        router,
        tools,
        checkpointer: new MemorySaver(),
        routerMaxRounds: 4,
    });
    const base = `${baseSystemPrompt(DEFAULT_SYSTEM_PROMPT, [])}\n\n${BENCH_RULE}`;
    const legacy = `${systemPromptForCapabilities(DEFAULT_SYSTEM_PROMPT, [])}\n\n${BENCH_RULE}`;
    const legacyOptions = {
        systemPrompt: legacy,
        recursionLimit: 10,
        roleSplit: false,
    } as const;
    const splitOptions = {
        systemPrompt: base,
        recursionLimit: 10,
        roleSplit: true,
        routerSystemPrompt: routerSystemPrompt(base),
        writerSystemPrompt: writerSystemPrompt(base),
        fallbackSystemPrompt: legacy,
    } as const;
    return { writer, router, graph, legacyOptions, splitOptions };
}

/** Runs one prompt through one mode and records its observable timings. */
async function runOne(
    harness: ReturnType<typeof createHarness>,
    mode: "legacy" | "split",
    item: PromptCase,
    sample: number,
): Promise<RunResult> {
    const started = performance.now();
    let firstToken: number | null = null;
    const selected: string[] = [];
    let text = "";
    const thread = `bench-${mode}-${sample}-${Math.random().toString(36).slice(2)}`;
    const options =
        mode === "legacy" ? harness.legacyOptions : harness.splitOptions;
    try {
        for await (const event of streamAgentTurn(
            harness.graph,
            item.prompt,
            thread,
            options,
        )) {
            if (event.type === "token") {
                firstToken ??= performance.now() - started;
                text += event.text;
            } else if (event.type === "tool") {
                selected.push(event.name);
            }
        }
    } catch (err) {
        const totalMs = performance.now() - started;
        return {
            mode,
            case: item,
            totalMs,
            ttftMs: firstToken ?? totalMs,
            tools: selected,
            text: `${text}\n[error: ${err instanceof Error ? err.message : String(err)}]`,
        };
    }
    const totalMs = performance.now() - started;
    return {
        mode,
        case: item,
        totalMs,
        ttftMs: firstToken ?? totalMs,
        tools: selected,
        text,
    };
}

/** Warm both models and both graph modes; discard every warm-up result. */
async function warm(harness: ReturnType<typeof createHarness>) {
    const warmWriter = createChatModel({ maxTokens: 8 });
    const warmRouter = createChatModel({ role: "router", maxTokens: 8 });
    await warmWriter.invoke([new HumanMessage("Reply with the word ready.")]);
    await warmRouter.invoke([new HumanMessage("Reply with the word ready.")]);
    const warmCase: PromptCase = { prompt: "Say ready.", expected: [] };
    await runOne(harness, "legacy", warmCase, -1);
    await runOne(harness, "split", warmCase, -1);
}

/** Linear-interpolated percentile over sorted numbers. */
function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower]!;
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

/** Exact expected-tool-set match. */
function routedCorrectly(result: RunResult): boolean {
    const actual = [...new Set(result.tools)].sort();
    const expected = [...new Set(result.case.expected)].sort();
    return (
        actual.length === expected.length &&
        actual.every((name, index) => name === expected[index])
    );
}

/** Prints one mode's aggregate report. */
function report(
    label: string,
    results: RunResult[],
    discarded: number,
): { p50: number; p95: number; accuracy: number } {
    const successful = results.filter(
        (result) => !result.text.includes("[error:"),
    );
    const p50 = percentile(
        successful.map((result) => result.totalMs),
        0.5,
    );
    const p95 = percentile(
        successful.map((result) => result.totalMs),
        0.95,
    );
    const accuracy =
        successful.length === 0
            ? 0
            : successful.filter(routedCorrectly).length / successful.length;
    console.log(
        `${label}: n=${successful.length} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms routing=${(accuracy * 100).toFixed(1)}% discarded=${discarded}`,
    );
    return { p50, p95, accuracy };
}

async function main(): Promise<void> {
    const samplesArg = process.argv
        .find((arg) => arg.startsWith("--samples="))
        ?.slice("--samples=".length);
    const samples = Math.max(1, Number(samplesArg ?? "3") || 3);
    const limitArg = process.argv
        .find((arg) => arg.startsWith("--limit="))
        ?.slice("--limit=".length);
    const limit = limitArg === undefined ? corpus.length : Number(limitArg);
    const cases = corpus.slice(0, Math.max(1, limit));

    const harness = createHarness();
    console.log(
        `Model roles: writer=${process.env.LLM_MODEL ?? "(default)"} router=${routerModel}; cases=${cases.length}, samples=${samples}`,
    );
    await warm(harness);
    const writerModel = process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
    const loaded = await loadedModelIds(
        process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    );
    if (loaded === null) {
        console.log(
            "Warm-up complete; the endpoint does not expose loaded-model state, so cold samples will be discarded instead of aborting.",
        );
    } else {
        const missing = [writerModel, routerModel].filter(
            (model) => !loaded.has(model),
        );
        if (missing.length > 0) {
            console.error(
                `Warm-up left these models unloaded: ${missing.join(", ")}. Both LLM_MODEL and LLM_ROUTER_MODEL must be resident before measuring; this endpoint would swap them on every turn, so the latency result would be meaningless. Load both (more memory or a smaller context) and rerun.`,
            );
            process.exit(2);
        }
        console.log(
            `Warm-up complete; both models resident (${writerModel}, ${routerModel}); measuring...`,
        );
    }

    const results: RunResult[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        for (const [index, item] of cases.entries()) {
            // Alternate the order each sample so a thermal or load trend does not
            // consistently favor one mode.
            const order: Array<"legacy" | "split"> =
                (sample + index) % 2 === 0
                    ? ["legacy", "split"]
                    : ["split", "legacy"];
            for (const mode of order) {
                const result = await runOne(harness, mode, item, sample);
                results.push(result);
                console.log(
                    `  ${mode} ${index + 1}/${cases.length} sample ${sample + 1}: ${result.totalMs.toFixed(0)}ms ${result.tools.join(",") || "no tools"}`,
                );
            }
        }
    }

    // A cold model load is a TTFT spike, not a slow generation. Exclude those
    // samples from both modes' timing comparison, and say how many were dropped.
    const coldThresholds = new Map<"legacy" | "split", number>();
    for (const mode of ["legacy", "split"] as const) {
        const warmRuns = results.filter(
            (result) =>
                result.mode === mode && !result.text.includes("[error:"),
        );
        const median = percentile(
            warmRuns.map((result) => result.ttftMs),
            0.5,
        );
        coldThresholds.set(mode, Math.max(5_000, median * 5));
    }
    const kept = results.filter(
        (result) =>
            !result.cold && result.ttftMs <= coldThresholds.get(result.mode)!,
    );
    for (const result of results) {
        if (!kept.includes(result)) result.cold = true;
    }

    const legacy = kept.filter((result) => result.mode === "legacy");
    const split = kept.filter((result) => result.mode === "split");
    const legacyReport = report(
        "legacy",
        legacy,
        results.filter((r) => r.mode === "legacy" && r.cold).length,
    );
    const splitReport = report(
        "split ",
        split,
        results.filter((r) => r.mode === "split" && r.cold).length,
    );
    console.log(
        `latency change: p50 ${((100 * (splitReport.p50 - legacyReport.p50)) / Math.max(legacyReport.p50, 1)).toFixed(1)}%, p95 ${((100 * (splitReport.p95 - legacyReport.p95)) / Math.max(legacyReport.p95, 1)).toFixed(1)}% (negative is faster)`,
    );
    console.log(
        `routing correctness: legacy ${(legacyReport.accuracy * 100).toFixed(1)}%, split ${(splitReport.accuracy * 100).toFixed(1)}%`,
    );
    for (const category of ["tool", "no-tool"] as const) {
        const subset = (results: RunResult[]) =>
            results.filter((result) =>
                category === "tool"
                    ? result.case.expected.length > 0
                    : result.case.expected.length === 0,
            );
        const l = report(
            `legacy/${category}`,
            subset(legacy),
            subset(results.filter((r) => r.mode === "legacy" && r.cold)).length,
        );
        const s = report(
            `split /${category}`,
            subset(split),
            subset(results.filter((r) => r.mode === "split" && r.cold)).length,
        );
        console.log(
            `subset ${category}: p50 ${((100 * (s.p50 - l.p50)) / Math.max(l.p50, 1)).toFixed(1)}%, p95 ${((100 * (s.p95 - l.p95)) / Math.max(l.p95, 1)).toFixed(1)}%`,
        );
    }
}

void main().catch((err: unknown) => {
    console.error(
        err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exit(1);
});
