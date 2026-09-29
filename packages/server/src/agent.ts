/**
 * Runs an agent turn and streams its events.
 *
 * The transport seam between `ws.ts` and the LangGraph agent: this module
 * owns the compiled graph and exposes the same async-generator contract the
 * WebSocket layer has always consumed. Today the generator yields
 * `AgentEvent`s (text tokens plus tool activity) for a thread identified by
 * `sessionId`; transports map those onto their own wire frames. A turn may
 * carry the client's declared render capabilities (from a `hello` frame), and
 * the system prompt is conditioned on them so output lands in a format the
 * client can actually render.
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
import type { ClientCapability } from "@lukestanbery/jarvis-protocol";
import {
    ensurePrivateFile,
    ensurePrivateStorage,
} from "@lukestanbery/jarvis-auth";

export type { AgentEvent, AgentGraph } from "./llm/agentGraph";

/** Optional inputs for one {@link runAgent} turn. */
export interface RunAgentOptions {
    /**
     * Render capabilities the announcing client declared. Conditions the
     * system prompt so the agent uses formats this client can render; omit
     * (or pass `[]`) for a plain-text client.
     */
    capabilities?: ClientCapability[];
}

/**
 * Tool-call hygiene instruction appended to every conditioned system prompt.
 *
 * Local models served over OpenAI-compatible emulation (LM Studio) frequently
 * fragment tool calls: empty argument objects, invented tool names, or calls
 * fired before the previous result was seen. Pinning the expected behavior in
 * the prompt reduces the malformed-call noise the agent loop would otherwise
 * faithfully execute and stream to clients.
 */
const TOOL_CALL_RULES =
    "When you use a tool, make exactly one tool call at a time and supply " +
    "every required argument as well-formed JSON matching the tool's " +
    "schema. Never call a tool without its required arguments, never " +
    "invent tool names, and wait for each tool's result before deciding " +
    "what to do next.";

/**
 * Time-query hygiene appended to every conditioned system prompt.
 *
 * Small local models reuse earlier answers from the conversation when asked
 * for the time again, reporting a stale value without ever re-calling the
 * clock, and over-report facets that weren't asked for. Because
 * `getCurrentTime` is the assistant's only source of "now", the prompt pins
 * that the tool must be invoked exactly once per ask with the verbatim
 * question, its stale result never reused.
 */
const TIME_CALL_RULE =
    "When asked for the current time, date, or day of the week, make exactly " +
    "one getCurrentTime call and pass the user's actual question verbatim as " +
    "the `question` argument; the tool returns only the facet they asked for, " +
    "so report that and nothing else. Do not call getCurrentTime again within " +
    "the same reply, and never reuse or repeat a value you already gave " +
    "earlier in this conversation — the clock only moves forward, so an " +
    "earlier answer is stale.";

/**
 * Derives a system prompt that admits the formats a capable client renders.
 *
 * Pure (and exported) so the conditioning rules are unit-testable without a
 * model. The fixed hygiene paragraphs — tool-call discipline
 * ({@link TOOL_CALL_RULES}) and clock freshness ({@link TIME_CALL_RULE}) — are
 * always appended: both are server concerns, independent of the client's
 * rendering capabilities and of any `LLM_SYSTEM_PROMPT` override. Capability
 * notes are appended as one paragraph only when the client actually declared
 * the token.
 */
export function systemPromptForCapabilities(
    systemPrompt: string,
    capabilities: ClientCapability[],
): string {
    const notes: string[] = [];
    if (capabilities.includes("markdown")) {
        notes.push(
            "Markdown is rendered: you may use headings, lists, bold/italic text, inline and fenced code, and tables.",
        );
    }
    if (capabilities.includes("image")) {
        notes.push(
            "Images render: you may include Markdown image links when a picture or diagram is genuinely clearer than words.",
        );
    }
    if (capabilities.includes("link")) {
        notes.push(
            "Hyperlinks render: include relevant URLs as inline Markdown links when they add value.",
        );
    }
    if (capabilities.includes("html")) {
        notes.push(
            "HTML is rendered: you may emit small, presentation-only HTML snippets.",
        );
    }
    const rendering =
        notes.length === 0
            ? ""
            : `\n\nThe conversation client renders the following in your replies: ${notes.join(" ")}`;
    return `${systemPrompt}\n\n${TOOL_CALL_RULES}\n\n${TIME_CALL_RULE}${rendering}`;
}

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
    ensurePrivateStorage(checkpointPath);
    logger.debug(`Agent recursion limit: ${agentMaxTurns} turns`);
    const saver = new SqliteSaver(new Database(checkpointPath));
    ensurePrivateFile(checkpointPath);
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

/**
 * Runs one agent turn for `sessionId`, streaming events as they happen.
 *
 * When `options.capabilities` lists render guarantees (from the socket's
 * `hello` frame), the system prompt is conditioned on them via
 * {@link systemPromptForCapabilities}.
 */
export async function* runAgent(
    prompt: string,
    sessionId: string,
    options: RunAgentOptions = {},
): AsyncGenerator<AgentEvent> {
    logger.sensitive(
        "Running agent turn",
        JSON.stringify({ prompt, sessionId }),
    );
    const { systemPrompt, agentMaxTurns } = getLlmConfig();
    yield* streamAgentTurn(getAgentGraph(), prompt, sessionId, {
        systemPrompt: systemPromptForCapabilities(
            systemPrompt,
            options.capabilities ?? [],
        ),
        recursionLimit: agentMaxTurns,
    });
}
