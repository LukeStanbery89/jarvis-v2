/**
 * Registry of tools available to the agent.
 *
 * Bound to the chat model and executed by the LangGraph ToolNode
 * (`src/llm/agentGraph.ts`). Add new tools here to make them callable.
 */
import { calculate } from "./math";
import { getCurrentTime } from "./time";

export const tools = [getCurrentTime, calculate];
