/**
 * Registry of tools available to the agent.
 *
 * Bound to the chat model and executed by the LangGraph ToolNode
 * (`src/llm/agentGraph.ts`). Add new tools here to make them callable.
 *
 * The registry is a **factory**, not a static list: the `analyzeImage` tool
 * needs the attachment store, vision model, and VL quota injected, and those
 * are process-level wiring concerns that must never be constructed inside the
 * agent graph module (review finding B4). Production wiring
 * (`index.ts`) passes the full deps; tests that don't exercise image analysis
 * simply omit them and get the two baseline tools.
 */
import { calculate } from "./math";
import { getCurrentTime } from "./time";
import { createAnalyzeImageTool } from "./analyzeImage";
import { createWebSearchTool } from "./webSearch";
import { createGetWeatherTool } from "./getWeather";
import { createHomeAssistantTool } from "./homeAssistant";
import { createWikipediaTool } from "./wikipedia";
import { createNotifyTool } from "./notify";
import { createJobsTools } from "./jobs";
import { createCodingTools } from "./coding";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AnalyzeImageDeps } from "./analyzeImage";
import type { WebSearchDeps } from "./webSearch";
import type { WeatherDeps } from "./getWeather";
import type { HomeAssistantDeps } from "./homeAssistant";
import type { WikipediaDeps } from "./wikipedia";
import type { NotifyToolDeps } from "./notify";
import type { JobsToolDeps } from "./jobs";
import type { CodingToolDeps } from "./coding";
import { createGitHubTools } from "./github";
import type { GitHubToolDeps } from "./github";

/** Everything the optional tools need; absent deps omit their tools. */
export interface ToolDeps extends AnalyzeImageDeps {
    /**
     * Web-search wiring (#9): configured providers (Tavily before Serper)
     * plus the per-user call quota. Present only when at least one provider
     * API key is configured — no keys, no `webSearch` tool.
     */
    search?: WebSearchDeps;
    /**
     * Weather wiring (#31): the configured OpenWeather provider, the per-user
     * call quota, and the unit system. Present only when the OpenWeather API
     * key is configured — no key, no `getWeather` tool.
     */
    weather?: WeatherDeps;
    /**
     * Home Assistant wiring (#15): the configured provider, the per-user call
     * quota, the writable domain list, and the list ceiling. Present only when
     * both the instance URL and the access token are configured — no
     * credentials, no `homeAssistant` tool.
     */
    homeAssistant?: HomeAssistantDeps;
    /**
     * Wikipedia wiring (#8): the configured client plus the per-user budget
     * and the two guest budgets. Unlike the other optional tools there is no
     * credential to gate on, so production always supplies this unless
     * `JARVIS_WIKIPEDIA=off`.
     */
    wikipedia?: WikipediaDeps;
    /**
     * Notification wiring (#139): the notification service, which the
     * `sendNotification` tool asks to reach the user. Present whenever the
     * notification surface is enabled — the tool is the agent's half of it,
     * and with `JARVIS_NOTIFY=off` there is no service to call.
     */
    notifications?: NotifyToolDeps;
    /**
     * Coding-sandbox wiring (#141): the supervisor the `startCodingJob` tool
     * calls. Present only when `JARVIS_SANDBOX=docker` — a tool that promised a
     * job no runtime can run would be the same broken promise `jobs` avoids.
     */
    coding?: CodingToolDeps;
    /**
     * GitHub tracker wiring (#140): the App-backed client and the repository
     * allowlist. Present only when the App is configured and at least one
     * repository is allowed — no App, no tracker tools.
     */
    github?: GitHubToolDeps;
    /**
     * Scheduler wiring (#90 phase 3): the job ledger, the per-user cap, and the
     * scheduling horizon, which the six scheduling tools create within.
     * Present only when the scheduler itself is running — a tool that could
     * store a job nobody will run is a promise the server cannot keep.
     *
     * `tools` is omitted on purpose: {@link createTools} fills it with the
     * instances built before the scheduling tools, so `scheduleTask` can
     * validate a requested tool without ever seeing itself.
     */
    jobs?: Omit<JobsToolDeps, "tools">;
}

/**
 * Builds the tool list for the agent graph.
 *
 * With `deps` the list includes `analyzeImage`; without it (or without a
 * caller-provided store) only the baseline tools are registered, keeping
 * pre-#10 behavior byte-for-byte for tests and embedders.
 */
export function createTools(deps?: ToolDeps): StructuredToolInterface[] {
    if (!deps) {
        return [getCurrentTime, calculate];
    }
    const tools: StructuredToolInterface[] = [
        getCurrentTime,
        calculate,
        createAnalyzeImageTool(deps),
    ];
    if (deps.search) {
        tools.push(createWebSearchTool(deps.search));
    }
    if (deps.weather) {
        tools.push(createGetWeatherTool(deps.weather));
    }
    if (deps.homeAssistant) {
        tools.push(createHomeAssistantTool(deps.homeAssistant));
    }
    if (deps.wikipedia) {
        tools.push(createWikipediaTool(deps.wikipedia));
    }
    if (deps.notifications) {
        // The only tool whose *result* is an interruption (#139), so it is
        // registered last and reads as an exception among lookups.
        tools.push(createNotifyTool(deps.notifications));
    }
    if (deps.github) {
        // Read an issue, list them, file one, comment. Registered before the
        // job tool because a read is the cheap half of "implement issue #N".
        tools.push(...createGitHubTools(deps.github));
    }
    if (deps.coding) {
        // Start, inspect, stop: the only tools that spend minutes of another
        // process's time. Start returns a job id, not work, so the agent is
        // told not to wait; status and stop make the wait interruptible.
        tools.push(...createCodingTools(deps.coding));
    }
    if (deps.jobs) {
        // Last, and given a snapshot of everything above: a scheduling tool
        // validates the tool it is asked to schedule against that list, and the
        // scheduler's allowlist keeps the scheduling tools themselves out of it.
        tools.push(...createJobsTools({ ...deps.jobs, tools: [...tools] }));
    }
    return tools;
}
