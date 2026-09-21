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
} from "./llm/agentGraph";
import { tools } from "./llm/tools";
import { getLlmConfig } from "./config";
import { logger } from "./logger";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let graph: ReturnType<typeof createAgentGraph> | null = null;

/**
 * Returns the shared, compiled agent graph, building it on first use.
 *
 * The graph is a singleton: one checkpointer (the SQLite store at
 * `JARVIS_CHECKPOINT_PATH`) backs every session thread, and every turn reuses
 * the same compiled graph instance.
 */
function getAgentGraph(): ReturnType<typeof createAgentGraph> {
    if (!graph) {
        const { checkpointPath, agentMaxTurns } = getLlmConfig();
        mkdirSync(dirname(checkpointPath), { recursive: true });
        logger.debug(`Agent recursion limit: ${agentMaxTurns} turns`);
        const saver = new SqliteSaver(new Database(checkpointPath));
        graph = createAgentGraph({
            model: createChatModel(),
            tools,
            checkpointer: saver,
        });
        void graph.getState({ configurable: { thread_id: "__init__" } }).then(
            () =>
                logger.info(
                    `Agent graph ready; checkpoints in ${checkpointPath}`,
                ),
            (err) =>
                logger.error(
                    `Checkpointer init failed: ${err instanceof Error ? err.message : String(err)}`,
                ),
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
    yield* streamAgentTurn(
        getAgentGraph(),
        prompt,
        sessionId,
        systemPrompt,
        agentMaxTurns,
    );
}
