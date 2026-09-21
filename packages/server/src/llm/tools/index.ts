/**
 * Registry of tools available to agents.
 *
 * Defined but not yet bound: the chat endpoint currently streams a plain
 * model response. LangGraph will consume this array directly when tool
 * execution lands.
 */
import { calculate } from "./math";
import { getCurrentTime } from "./time";

export const tools = [getCurrentTime, calculate];
