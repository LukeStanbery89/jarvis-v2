/**
 * Runs an agent turn and streams its events.
 *
 * The transport seam between `ws.ts` and the LangGraph agent: this module
 * owns the compiled graph and exposes the same async-generator contract the
 * WebSocket layer has always consumed. Today the generator yields
 * `AgentEvent`s (text tokens plus tool activity) for a thread identified by
 * `sessionId`; transports map those onto their own wire frames.
 */
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createChatModel } from "./llm/chatModel";
import {
    createAgentGraph,
    streamAgentTurn,
    type AgentEvent,
    type AgentGraph,
} from "./llm/agentGraph";
import { tools } from "./llm/tools";
import { getLlmConfig } from "./config";
import { logger } from "./logger";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type { AgentEvent, AgentGraph } from "./llm/agentGraph";

let graph: AgentGraph | null = null;

/**
 * Builds the shared agent graph up-front and opens its checkpoint store.
 *
 * Call once at server startup (`index.ts`): creates `~/.jarvis` and the SQLite
 * checkpointer, and compiles the graph. Idempotent — calling it again returns
 * the existing instance. The graph is a singleton: one checkpointer (the
 * SQLite store at `JARVIS_CHECKPOINT_PATH`) backs every session thread, and
 * every turn reuses the same compiled graph instance.
 */
export function initAgentGraph(): AgentGraph {
    if (graph) {
        return graph;
    }
    const { checkpointPath, agentMaxTurns } = getLlmConfig();
    mkdirSync(dirname(checkpointPath), { recursive: true });
    logger.debug(`Agent recursion limit: ${agentMaxTurns} turns`);
    const saver = new SqliteSaver(new Database(checkpointPath));
    graph = createAgentGraph({
        model: createChatModel(),
        tools,
        checkpointer: saver,
    });
    logger.info(`Agent graph ready; checkpoints in ${checkpointPath}`);
    return graph;
}

/**
 * Returns the shared, compiled agent graph.
 *
 * Throws if `initAgentGraph()` was not called at startup — the graph is no
 * longer built on first use, so a missing call is a programmer error (usually
 * a test whose module under test reaches `runAgent` without bootstrapping).
 */
function getAgentGraph(): AgentGraph {
    if (!graph) {
        throw new Error(
            "agent graph not initialized; call initAgentGraph() at server startup",
        );
    }
    return graph;
}

/** Runs one agent turn for `sessionId`, streaming events as they happen. */
export async function* runAgent(
    prompt: string,
    sessionId: string,
): AsyncGenerator<AgentEvent> {
    logger.sensitive(
        "Running agent turn",
        JSON.stringify({ prompt, sessionId }),
    );
    const { systemPrompt, agentMaxTurns } = getLlmConfig();
    yield* streamAgentTurn(getAgentGraph(), prompt, sessionId, {
        systemPrompt,
        recursionLimit: agentMaxTurns,
    });
}
