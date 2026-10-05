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
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AnalyzeImageDeps } from "./analyzeImage";

/** Everything the optional tools need; absent deps omit their tools. */
export type ToolDeps = AnalyzeImageDeps;

/**
 * Builds the tool list for the agent graph.
 *
 * With `deps` the list includes `analyzeImage`; without it (or without a
 * caller-provided store) only the baseline tools are registered, keeping
 * pre-#10 behavior byte-for-byte for tests and embedders.
 */
export function createTools(deps?: ToolDeps): StructuredToolInterface[] {
    return deps
        ? [getCurrentTime, calculate, createAnalyzeImageTool(deps)]
        : [getCurrentTime, calculate];
}
