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
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AnalyzeImageDeps } from "./analyzeImage";
import type { WebSearchDeps } from "./webSearch";
import type { WeatherDeps } from "./getWeather";
import type { HomeAssistantDeps } from "./homeAssistant";
import type { WikipediaDeps } from "./wikipedia";
import type { NotifyToolDeps } from "./notify";

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
    return tools;
}
