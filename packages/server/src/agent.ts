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
import { createTools } from "./llm/tools";
import type { ToolDeps } from "./llm/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getLlmConfig } from "./config";
import { logger } from "./logger";
import type { ChatMode, ClientCapability } from "@lukestanbery/jarvis-protocol";
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
    /**
     * The prompt's chat mode (#83): under `"voice"` the system prompt gains
     * the spoken-word formatting directive ({@link VOICE_FORMAT_RULE}) so
     * the answer is shaped for text-to-speech — plain flowing prose, no
     * markdown or parentheses, spelled-out units. Scoped to the turn: a
     * text-mode prompt on the same thread keeps the client's declared
     * rendering capabilities and rich formatting.
     */
    mode?: ChatMode;
    /**
     * Ids of uploaded images this prompt references (#10). Deduplicated and
     * appended to the turn's `HumanMessage` as an `[attachments: …]` marker
     * the model reads; the `analyzeImage` tool resolves ids against the
     * attachment store on use.
     */
    attachmentIds?: string[];
    /**
     * The authenticated user's numeric row id (`AppUser.id`), present on
     * every authenticated turn so user-scoped tools can enforce ownership
     * and per-user quotas (the `analyzeImage` tool checks attachment
     * ownership — including follow-up turns asking about an image uploaded
     * in an earlier one; the `webSearch` tool keys its call quota on it).
     * Absent for guests — attachment-carrying prompts never reach the agent
     * for them.
     */
    userId?: number;
    /**
     * The device's reported whereabouts (#31), from the socket's latest
     * `location` frame. Exposed to tool runtime callbacks so location-aware
     * tools (the `getWeather` tool) can answer locationless questions;
     * omitted when the client has not reported a location. Kept in memory
     * per turn only — never persisted.
     */
    location?: DeviceLocation;
    /**
     * The connecting socket's peer address (`ws.ts`): the client half of a
     * guest's metering key (#8). A guest has no account to charge a tool
     * call to, so the `wikipedia` tool budgets them per session *and* per
     * address — the address bucket is what makes the limit survive a guest
     * reconnecting for a fresh session. Absent for non-socket callers.
     */
    clientIp?: string;
    /**
     * Cooperative cancellation (#84 P6): aborting it stops the turn — the
     * model's in-flight calls reject, the stream ends, and the generator
     * finishes early. Threaded into the graph's runnable config so a stalled
     * model read aborts for real instead of waiting for the next token (the
     * caller still drains best-effort via `return()` on top of this).
     */
    signal?: AbortSignal;
}

/**
 * A device's reported whereabouts (#31): decimal degrees with an optional
 * human-readable place label. The server-side counterpart of the protocol's
 * `location` frame payload (minus the wire `type`), carried through
 * `configurable` to tool runtimes the same way `userId` is.
 */
export interface DeviceLocation {
    /** Latitude in decimal degrees. */
    lat: number;
    /** Longitude in decimal degrees. */
    lon: number;
    /** Optional place name the client knew ("Portland, OR"). */
    label?: string;
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
 * Image-analysis hygiene appended to every conditioned system prompt (#10).
 *
 * The chat model cannot see images, so an attachment-carrying question is
 * answerable only through the `analyzeImage` tool. Without explicit
 * instruction, small local models either hallucinate about unseen images or
 * paraphrase the id (breaking the lookup), so this pins the expected behavior:
 * exact id pass-through, answer from the tool's description, and the
 * re-upload path when an image has expired.
 */
const IMAGE_ANALYSIS_RULE =
    "When the user's message includes an [attachments: …] list and their " +
    "question is about what those images show, call analyzeImage with the " +
    "exact attachmentId from that list (never an id you invent or truncate) " +
    "and their question as the query. Base your answer on the tool's " +
    "returned description of the image — never guess about image contents. " +
    "If the tool reports an image unavailable or expired, tell the user and " +
    "ask them to upload it again.";

/**
 * Home-call hygiene appended to every conditioned system prompt (#15).
 *
 * The assistant has no memory of the user's house: nothing about which lights
 * exist, their names, or their states can come from the model. Small local
 * models readily invent a plausible entity and answer from it, which is the
 * worst failure mode here — a confident claim about a real light that was never
 * read, or a write aimed at a guessed target. So this pins the discipline the
 * tool enforces anyway: discover first to learn the real ids, then act on
 * exactly one id, and never claim a change the tool did not confirm. The
 * re-search clause exists because the complementary failure is quiet absence —
 * a model that reads an empty result once, or remembers a list from earlier in
 * the conversation, declares the device missing instead of looking again.
 */
const HOME_CALL_RULE =
    "The homeAssistant tool is your only source of truth about the user's " +
    "house — lights, switches, thermostats, sensors, and their states. Never " +
    "answer from memory or guess an entity_id. Call action 'lights' for lights, " +
    "'switches' for switches, or 'list' first (optionally with query to narrow " +
    "it) to learn the exact entity_ids, then call the action you need with one " +
    "exact entity_id. Before you conclude that a device or a whole category is " +
    "absent, search again in this turn: an empty result proves only that search " +
    "found nothing, and a list from earlier in this conversation may be stale — " +
    "re-read rather than remember. Report only what the tool returned in this " +
    "turn; if it refuses or reports the home unreachable, say so plainly and " +
    "never claim a device changed state. When the user asks for something broad " +
    "or ambiguous ('turn everything off'), confirm what you are about to do " +
    "before acting.";

/**
 * Tools-over-memory hygiene appended to every conditioned system prompt (#8).
 *
 * Small local models answer confidently from their training data, which is
 * stale and, for anything that changed after training, simply wrong. The
 * per-tool paragraphs already say this for their own tool (the weather and
 * home rules especially); this one states the general disposition, so a
 * model that is offered `wikipedia` or `webSearch` reaches for the tool on
 * the class of questions those tools exist for rather than reciting a
 * remembered fact. Deliberately general and tool-agnostic: it names the
 * kinds of tools, not one deployment's registry, and it is appended
 * unconditionally for the same reason the Home rule is — a model that
 * cannot see such a tool is never misled by instruction it cannot follow.
 * The specific tool's own description does the choosing between them.
 */
const RESEARCH_RULE =
    "Prefer your tools over your own memory for facts about the world. When " +
    "a lookup tool (such as Wikipedia search or web search) is available and " +
    "the question turns on a fact — a person, place, thing, event, figure, " +
    "definition, or piece of history — or on anything that is likely to have " +
    "changed since you were trained (news, prices, schedules, releases, " +
    "current officeholders, scores), call the tool and answer from what it " +
    "returns rather than reciting from memory. If no tool can settle the " +
    "question, say what you are unsure of instead of stating a guess as fact.";

/**
 * Notification hygiene appended to every conditioned system prompt (#139).
 *
 * `sendNotification` is the one tool whose *result* is an interruption, so its
 * characteristic failure is not a wrong answer but a nagging assistant: a
 * model that pings the user on every turn teaches them to ignore
 * notifications, and an ignored notification channel is worth nothing — the
 * feature's entire purpose is that a notification means something. So this
 * pins restraint rather than use, and it is the reason the tool's own
 * description spends most of its words on when *not* to call it.
 *
 * The last clause covers the other half: a model told "sent" will say it
 * appeared, and a user who then sees nothing learns to distrust the channel —
 * the "nothing happened" mystery #139 set out to remove. The tool reports what
 * actually happened; the model's job is to relay that, not to round it up.
 */
const NOTIFY_RULE =
    "sendNotification reaches the user outside this conversation, so it is " +
    "an interruption rather than an answer: use it only when the user asked " +
    "you to notify them, or when you are about to work long enough that they " +
    "may walk away before you finish. Never use it to acknowledge a message, " +
    "to restate the reply you are about to give, or more than once for the " +
    "same thing. Its result says whether a connected client actually received " +
    "it — if the result says it was not pushed, tell the user it is waiting " +
    "in their notification list rather than that it appeared.";

/**
 * Scheduling hygiene appended to every conditioned system prompt (#90 phase 3).
 *
 * The scheduling tools are the one place the assistant commits to something it
 * will do *later*, with nobody watching, so the failure mode is not a wrong
 * answer but a promise kept badly: a guessed time ("you said soon, so 6pm"), a
 * second job created to "replace" one the model could not find, or a claim that
 * an interruption will arrive when quiet hours will hold it. The tools refuse
 * what they can (an ambiguous time, a task that cannot run) and report what
 * will happen; this paragraph pins the model's half — ask rather than guess,
 * never compute a timestamp, relay what the result says, and cancel by exact
 * id. The last sentence is the restraint clause, for the same reason
 * {@link NOTIFY_RULE} has one: a job nobody asked for is an interruption the
 * user cannot avoid.
 */
const SCHEDULE_RULE =
    "When the user asks to be reminded of something, to set a timer, or to " +
    "have something done later, use the matching tool rather than promising " +
    "it in words: remindMe for something they want to be told (it waits out " +
    "their quiet hours), setTimer for a countdown they asked for (it " +
    "interrupts), scheduleTask for running one of your tools later (it is " +
    "filed quietly). You cannot choose how loudly a job arrives — the tool " +
    "does. You must be told when: if they gave no time, or said something " +
    "vague like 'later' or 'soon', ask them instead of guessing, and never " +
    "send a timestamp — give the time the way the tool asks (a 24-hour " +
    "clock time, a delay in minutes, and today/tomorrow/a weekday for the " +
    "day). To move or cancel one, call listJobs for the exact id and then " +
    "cancelJob or snoozeReminder; never create a second job to replace one " +
    "you cannot find. The result says when it will run and whether quiet " +
    "hours will hold it — relay that rather than promising an interruption. " +
    "Never schedule anything the user did not ask for; a job is a " +
    "commitment you keep when nobody is watching.";

/**
 * Spoken-word formatting directive appended for voice-mode turns (#83).
 *
 * A voice prompt's effective capabilities are empty, which yields plain
 * text — but "plain" does not stop a small local model from writing
 * markdown emphasis, parenthetical asides, and abbreviated units that a
 * TTS engine then reads literally ("degrees f", "open paren"). The prompt
 * conditions the style instead: prose shaped for the mouth. Deliberately
 * scoped to the current turn — a text-mode prompt on the same thread goes
 * back to the client's declared rendering capabilities (tables, headings,
 * bullets) with nothing remembered.
 */
const VOICE_FORMAT_RULE =
    "The user is speaking with you by voice and your reply will be read " +
    "aloud by a text-to-speech engine, so write exactly as you would " +
    "speak: short, plain conversational sentences. Use no markdown, " +
    "headings, lists, tables, bold or italic emphasis, or code formatting. " +
    "Use no parentheses or brackets — fold any aside into the sentence " +
    "itself. Spell out every abbreviation, unit, and symbol so the voice " +
    "reads it naturally (say 'degrees Fahrenheit', 'miles per hour', " +
    "'percent'), and keep the wording flowing like human speech. Begin " +
    "your response with a short sentence (under 10 words).";

/**
 * Derives a system prompt that admits the formats a capable client renders.
 *
 * Pure (and exported) so the conditioning rules are unit-testable without a
 * model. The fixed hygiene paragraphs — tool-call discipline
 * ({@link TOOL_CALL_RULES}), clock freshness ({@link TIME_CALL_RULE}), image
 * lookups ({@link IMAGE_ANALYSIS_RULE}), Home Assistant calls
 * ({@link HOME_CALL_RULE}), tools-over-memory for research
 * ({@link RESEARCH_RULE}), notification restraint ({@link NOTIFY_RULE}), and
 * scheduling discipline ({@link SCHEDULE_RULE}) — are always appended: all are
 * server concerns, independent of the client's rendering capabilities and of
 * any `LLM_SYSTEM_PROMPT` override. (The Home,
 * research, and notification rules are unconditional even though their tools
 * are optional: a model that cannot see a tool is never misled by instruction
 * it cannot follow.) Capability notes are appended as one paragraph only when
 * the client actually declared the token. Under `mode: "voice"` (#83) the
 * spoken-word directive ({@link VOICE_FORMAT_RULE}) is appended instead: the
 * reply is shaped for text-to-speech rather than for a renderer.
 */
export function systemPromptForCapabilities(
    systemPrompt: string,
    capabilities: ClientCapability[],
    mode?: ChatMode,
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
    const spoken = mode === "voice" ? `\n\n${VOICE_FORMAT_RULE}` : "";
    return `${systemPrompt}\n\n${TOOL_CALL_RULES}\n\n${TIME_CALL_RULE}\n\n${IMAGE_ANALYSIS_RULE}\n\n${HOME_CALL_RULE}\n\n${RESEARCH_RULE}\n\n${NOTIFY_RULE}\n\n${SCHEDULE_RULE}${rendering}${spoken}`;
}

let graph: AgentGraph | null = null;

/**
 * The tool instances the graph was built with.
 *
 * Held alongside the graph so the scheduler can invoke a job's tool directly
 * with the *same* objects a graph turn would use. The per-user quotas,
 * ownership checks and quiet-hours policy live inside those tools; rebuilding
 * them for the scheduler would be a second set of counters that agree by
 * accident.
 */
let agentTools: readonly StructuredToolInterface[] | null = null;

/**
 * Builds the shared agent graph up-front and opens its checkpoint store.
 *
 * Call once at server startup (`index.ts`): creates `~/.jarvis` and the SQLite
 * checkpointer, and compiles the graph. Idempotent — calling it again returns
 * the existing instance. The graph is a singleton: one checkpointer (the
 * SQLite store at `JARVIS_CHECKPOINT_PATH`) backs every session thread, and
 * every turn reuses the same compiled graph instance.
 *
 * `deps` carries the process-level wiring for optional tools — the
 * attachment store, vision model, and VL quota for `analyzeImage`. They are
 * injected here (never constructed inside the graph module, per review
 * finding B4); omitting them registers only the baseline tools.
 */
export function initAgentGraph(deps?: ToolDeps): AgentGraph {
    if (graph) {
        return graph;
    }
    const { checkpointPath, agentMaxTurns } = getLlmConfig();
    ensurePrivateStorage(checkpointPath);
    logger.debug(`Agent recursion limit: ${agentMaxTurns} turns`);
    const saver = new SqliteSaver(new Database(checkpointPath));
    ensurePrivateFile(checkpointPath);
    const tools = createTools(deps);
    graph = createAgentGraph({
        model: createChatModel(),
        tools,
        checkpointer: saver,
    });
    agentTools = tools;
    logger.info(`Agent graph ready; checkpoints in ${checkpointPath}`);
    return graph;
}

/**
 * Returns the tool instances the graph was built with.
 *
 * For the scheduler (#90), which invokes one of them directly for a `tool`
 * job. Throws if `initAgentGraph()` has not run — same contract and reason as
 * {@link getAgentGraph}.
 */
export function getAgentTools(): readonly StructuredToolInterface[] {
    if (agentTools === null) {
        throw new Error(
            "agent graph not initialized; call initAgentGraph() at server startup",
        );
    }
    return agentTools;
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
 * Appends the attachment marker to a prompt (#10).
 *
 * Pure and exported so the dedupe/marker rules are unit-testable without a
 * graph: ids are deduplicated (a repeated id is a client bug, and the model
 * would offer it twice), empty strings are dropped, and a prompt with no
 * surviving ids is returned byte-identical. The marker is the model-facing
 * list the `analyzeImage` tool reads ids from.
 */
export function withAttachmentMarker(
    prompt: string,
    attachmentIds: string[],
): string {
    const ids = [...new Set(attachmentIds)].filter((id) => id.length > 0);
    return ids.length > 0
        ? `${prompt}\n\n[attachments: ${ids.join(", ")}]`
        : prompt;
}

/**
 * Runs one agent turn for `sessionId`, streaming events as they happen.
 *
 * When `options.capabilities` lists render guarantees (from the socket's
 * `hello` frame), the system prompt is conditioned on them via
 * {@link systemPromptForCapabilities}; under `options.mode: "voice"` (#83)
 * the spoken-word directive joins it so the reply is shaped for
 * text-to-speech. When `options.attachmentIds` is
 * present, the ids are deduplicated and appended to the turn's
 * `HumanMessage` as an `[attachments: …]` marker (the model-facing list the
 * `analyzeImage` tool reads ids from), `options.userId` is exposed to
 * tool runtime callbacks so user-scoped tools can enforce ownership and
 * quotas, `options.location` rides along (#31) for location-aware
 * tools, and `sessionId` plus `options.clientIp` are exposed for the tools
 * that meter guests by session and address (#8).
 */
export async function* runAgent(
    prompt: string,
    sessionId: string,
    options: RunAgentOptions = {},
): AsyncGenerator<AgentEvent> {
    const markedPrompt = withAttachmentMarker(
        prompt,
        options.attachmentIds ?? [],
    );
    logger.sensitive(
        "Running agent turn",
        JSON.stringify({ prompt: markedPrompt, sessionId }),
    );
    const { systemPrompt, agentMaxTurns } = getLlmConfig();
    // `sessionId` and `clientIp` are always stamped: they are what a guest
    // turn has instead of a `userId`, and tools that admit guests (#8) key
    // their budgets on them. Neither is new information — `sessionId` is
    // already the graph's `thread_id`, and `clientIp` is the socket's own
    // peer address. `userId` and `location` stay conditional so an
    // authenticated, location-less turn keeps the pre-#31 shape.
    const configurable = {
        sessionId,
        ...(options.userId !== undefined ? { userId: options.userId } : {}),
        ...(options.location !== undefined
            ? { location: options.location }
            : {}),
        ...(options.clientIp !== undefined
            ? { clientIp: options.clientIp }
            : {}),
    };
    yield* streamAgentTurn(getAgentGraph(), markedPrompt, sessionId, {
        systemPrompt: systemPromptForCapabilities(
            systemPrompt,
            options.capabilities ?? [],
            options.mode,
        ),
        recursionLimit: agentMaxTurns,
        configurable,
        signal: options.signal,
    });
}
