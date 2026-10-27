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
import { BaseMessage, RemoveMessage } from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import type { SerializerProtocol } from "@langchain/langgraph-checkpoint";
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
import { issueRefFromPrompt, type IssueRef } from "./github/issue";
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
     * The authenticated device's numeric row id (#194), present on a socket
     * turn and on a scheduled job's own runs. Tools that create a local
     * resource — today `setTimer` — read it to address the result to the
     * device that asked. Absent for a guest or a legacy job.
     */
    deviceId?: number;
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
    "filed quietly), schedulePrompt for something you should do later — " +
    "thinking or writing rather than one tool call (it is filed quietly " +
    "too, with what you produce as the notification). You cannot choose how " +
    "loudly a job arrives — the tool does. You must be told when: if they " +
    "gave no time, or said something vague like 'later' or 'soon', ask them " +
    "instead of guessing, and never send a timestamp — give the time the way " +
    "the tool asks (a 24-hour clock time, a delay in minutes, and " +
    "today/tomorrow/a weekday for the day). The one exception is a repeat: a " +
    "cadence is its own when, so pass it with no time at all rather than " +
    "asking — 'every 30 minutes' starts half an hour from now and 'every " +
    "day' starts tomorrow at this time. Do not do that for a one-shot. A " +
    "job's `label` is the one line the user reads when it fires, and " +
    "`message` is only for detail that line cannot carry: never write the " +
    "same instruction twice. To move or cancel one, call listJobs for the " +
    "exact id and then " +
    "cancelJob or snoozeReminder; never create a second job to replace one " +
    "you cannot find. When they want something to happen *again* — 'every " +
    "morning', 'on Mondays and Saturdays', 'the first of the month', 'the " +
    "second Tuesday' — pass the cadence (remindMe, scheduleTask and " +
    "schedulePrompt all take it, at the top level or nested under `repeat`; " +
    "a timer is a countdown and never repeats, so say so and use remindMe). " +
    "Put " +
    "the days exactly as they were said: days of the week in `weekdays` as " +
    "two-letter codes, a day of the month in `monthDays` (1-31, or -1 for the " +
    "last day), and 'the second Tuesday' or 'the last Friday' in " +
    "`weekOrdinals` as '2tu' or '-1fr'. Do not guess when a phrase could mean " +
    "two things — 'every Monday and the 1st' is either every Monday plus the " +
    "1st or a Monday that is also the 1st — ask which they mean. The result " +
    "states the schedule back to you along with when it will next run: say " +
    "both, so they can correct you now rather than later. If they want it to " +
    "run often but only *when something changed* — 'only if the door opened', " +
    "'check every five minutes and tell me if it changed' — pass `gate` " +
    "(remindMe, scheduleTask and schedulePrompt all take it): one read-only " +
    "tool call whose " +
    "answer is compared with the previous firing's, so a firing that finds " +
    "nothing changed does not run and does not announce. Never add a gate " +
    "they did not ask for, and never use one to act — a gate only reads, and " +
    "a tool that acts is refused. The result says " +
    "when it will run and whether quiet " +
    "hours will hold it — relay that rather than promising an interruption. " +
    "Never schedule anything the user did not ask for; a job is a " +
    "commitment you keep when nobody is watching.";

/**
 * Coding-job rule (#141), appended only when the tool is registered.
 *
 * The rule exists because the tool's absence was read as incapacity: asked to
 * change code, a small model answered "I cannot edit the repository" without
 * ever calling `startCodingJob`. The schema alone is not a strong enough cue —
 * the same lesson the scheduling and notification rules encode for their
 * tools. Kept behind a flag rather than made unconditional: the Home,
 * research, and notification rules can be always-on because a model that
 * cannot see a tool is merely over-cautious, but a rule that names a tool the
 * process did not register would make the model promise a job that cannot
 * start.
 */
const GITHUB_RULE =
    "You can read and update the project's GitHub tracker. Use " +
    "getGitHubIssue for an issue and getGitHubPullRequest for a pull request " +
    "(it shows the review comments); read a GitHub link with the matching " +
    "tool, never webSearch. Use " +
    "listGitHubIssues when they ask what is open or what to work on; " +
    "createGitHubIssue only when they ask you to file or report an issue; " +
    "and commentOnGitHub only when they ask you to post a comment there. To " +
    "implement an issue, pass its number or URL as `issue` to startCodingJob " +
    "rather than pasting its description; when the user shares an issue link, " +
    "pass that link itself and never summarize the issue into `task`. To act " +
    "on a pull request's review, pass `pullRequest` — the job is given the " +
    "comment thread. Never invent an issue number or a repository, and never " +
    "comment on your own initiative.";

const CODING_RULE =
    "You can start a coding job. When the user asks for any change to a " +
    "repository's files — code, documentation, comments, configuration, or " +
    "assets — call startCodingJob with their task. A one-line comment is " +
    "still a change, and if they explicitly ask to start a coding job, call " +
    "it even when the change looks small. Do not claim you cannot edit code " +
    "or reach a repository: the job runs an agent in its own sandbox with " +
    "its own clone, and you are notified when it ends. You do not wait for " +
    "it, and nothing is done until the tool returns a job id — report that " +
    "id and say you will tell them when it finishes. If they named a " +
    "repository, pass its exact owner/name; if you do not know that form — " +
    "a nickname like 'the JARVIS repo' is not one — omit `repo` rather than " +
    "guessing. Never pass an invented or shortened slug. To continue an open " +
    "pull request — address its review comments or revise it — pass " +
    "`pullRequest` with its number or URL; that job works on the PR's branch " +
    "and updates the same review. When the tool " +
    "refuses a repository and exactly one is allowed, call it again with " +
    "`repo` omitted instead of asking the user to repeat themselves; when " +
    "several are allowed, ask which. Never start a job for something that " +
    "is not a change to the repository — a question, a lookup, or a chat " +
    "answer is not one.";

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
 * The per-turn rule for a message that shares a GitHub issue (#140).
 *
 * The standing `GITHUB_RULE` says to pass an issue's number; a shared link is
 * still routinely paraphrased into `task` by a small relay model, which leaves
 * the coding agent without the issue body and the pull request without a
 * closing link. This rule is concrete — it names the issue and the exact
 * argument — because the failure is a choice at the tool call, not a missing
 * capability. `startCodingJob` also carries the same reference in
 * `configurable.sharedIssue` as a deterministic fallback; the rule makes the
 * explicit path the model's first choice.
 *
 * @param ref - The issue the user's message shares.
 * @returns The paragraph appended to this turn's system prompt.
 */
export function sharedIssueRule(ref: IssueRef): string {
    const where = ref.repo === undefined ? "" : ` in ${ref.repo}`;
    const reference =
        ref.repo === undefined
            ? String(ref.number)
            : `https://github.com/${ref.repo}/issues/${ref.number}`;
    return (
        `The user's message shares GitHub issue #${ref.number}${where}. ` +
        `To implement it, call startCodingJob with \`issue: ${reference}\` ` +
        "and omit `task`; the job reads the issue itself. Do not summarize " +
        "the issue into `task`."
    );
}

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
    return `${systemPrompt}\n\n${TOOL_CALL_RULES}\n\n${TIME_CALL_RULE}\n\n${IMAGE_ANALYSIS_RULE}\n\n${HOME_CALL_RULE}\n\n${RESEARCH_RULE}\n\n${NOTIFY_RULE}\n\n${SCHEDULE_RULE}${githubEnabled ? `\n\n${GITHUB_RULE}` : ""}${codingEnabled ? `\n\n${CODING_RULE}` : ""}${rendering}${spoken}`;
}

let graph: AgentGraph | null = null;

/**
 * The checkpoint saver behind {@link graph}.
 *
 * Kept so the server can delete a thread's model memory with the transcript's
 * ledger row, and prune old checkpoint versions after a turn. Retaining the
 * saver is what keeps those two stores from drifting into orphan data.
 */
let checkpointSaver: SqliteSaver | null = null;

/** Options for {@link initAgentGraph} that are not tool wiring. */
export interface AgentGraphInitOptions {
    /**
     * Serializer used by the checkpointer. Production passes the encrypting
     * serde; omitting it would write plaintext, which is why the server entry
     * point always supplies one.
     */
    checkpointSerde: SerializerProtocol;
}

/**
 * Whether this process registered `startCodingJob` (#141).
 *
 * The coding rule is the one hygiene paragraph that must not be unconditional:
 * it names a tool, and describing a tool the process did not register would
 * make the model promise a job that cannot start. Set once, when the graph is
 * built — the same deps object that builds the tool list.
 */
let codingEnabled = false;
let githubEnabled = false;

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
 *
 * `options.checkpointSerde` is the encrypting serializer (#122); production
 * must supply it. The saver is retained so session deletion, context trimming,
 * and version pruning can reach the same checkpoint store the graph writes.
 */
export function initAgentGraph(
    deps: ToolDeps | undefined,
    options: AgentGraphInitOptions,
): AgentGraph {
    if (graph) {
        return graph;
    }
    const { checkpointPath, agentMaxTurns } = getLlmConfig();
    ensurePrivateStorage(checkpointPath);
    logger.debug(`Agent recursion limit: ${agentMaxTurns} turns`);
    const saver = new SqliteSaver(
        new Database(checkpointPath),
        options.checkpointSerde,
    );
    checkpointSaver = saver;
    ensurePrivateFile(checkpointPath);
    const tools = createTools(deps);
    codingEnabled = deps?.coding !== undefined;
    githubEnabled = deps?.github !== undefined;
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

/** The initialized checkpoint saver, or a clear startup error. */
function getCheckpointSaver(): SqliteSaver {
    if (checkpointSaver === null) {
        throw new Error(
            "agent graph not initialized; call initAgentGraph() at server startup",
        );
    }
    return checkpointSaver;
}

/**
 * Deletes every checkpoint and pending write for `threadId`.
 *
 * Used by the REST session delete and guest-socket cleanup, so a conversation
 * row and its model memory disappear together. `SqliteSaver.deleteThread`
 * removes both tables in one transaction.
 *
 * @param threadId - The wire `sessionId`.
 */
export async function deleteAgentThread(threadId: string): Promise<void> {
    await getCheckpointSaver().deleteThread(threadId);
}

/**
 * Drops all but the newest `keep` checkpoint versions for one thread.
 *
 * LangGraph writes a checkpoint at every step. The app never uses time travel,
 * so keeping the newest two versions is enough for a settled turn while
 * stopping the checkpoint file from growing superlinearly with conversation
 * length. Only the default (empty) checkpoint namespace is pruned.
 *
 * @param threadId - The wire `sessionId`.
 * @param keep - Newest versions to retain (at least one).
 * @returns The number of checkpoint rows removed.
 */
export function pruneAgentThreadVersions(threadId: string, keep = 2): number {
    return pruneThreadVersions(getCheckpointSaver(), threadId, keep);
}

/**
 * {@link pruneAgentThreadVersions} over an explicit saver (tests and any
 * future multi-saver path).
 */
export function pruneThreadVersions(
    saver: SqliteSaver,
    threadId: string,
    keep = 2,
): number {
    const safeKeep = Math.max(1, Math.floor(keep));
    const db = saver.db;
    const rows = db
        .prepare(
            "SELECT checkpoint_id AS id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC",
        )
        .all(threadId) as { id: string }[];
    if (rows.length <= safeKeep) {
        return 0;
    }
    const keepIds = rows.slice(0, safeKeep).map((row) => row.id);
    const placeholders = keepIds.map(() => "?").join(", ");
    const remove = db.transaction(() => {
        db.prepare(
            `DELETE FROM writes WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id NOT IN (${placeholders})`,
        ).run(threadId, ...keepIds);
        const removed = db
            .prepare(
                `DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id NOT IN (${placeholders})`,
            )
            .run(threadId, ...keepIds);
        return removed.changes;
    });
    return remove();
}

/**
 * Trims the checkpoint's persisted messages to the newest `maxMessages`.
 *
 * The transcript table is the durable history; this is the model's working
 * context. We cut at a human turn boundary and keep the leading system
 * message(s), so the next model call never starts on a dangling tool result.
 * `RemoveMessage(REMOVE_ALL_MESSAGES)` is the LangGraph reducer's replace
 * primitive; a plain `messages` update would append.
 *
 * @param threadId - The wire `sessionId`.
 * @param maxMessages - Newest messages to keep (including system messages).
 * @returns Whether the state was rewritten.
 */
export async function trimAgentContext(
    threadId: string,
    maxMessages: number,
): Promise<boolean> {
    return trimGraphContext(getAgentGraph(), threadId, maxMessages);
}

/**
 * {@link trimAgentContext} over an explicit graph (tests and future
 * multi-graph paths).
 */
export async function trimGraphContext(
    graph: AgentGraph,
    threadId: string,
    maxMessages: number,
): Promise<boolean> {
    const state = await graph.getState({
        configurable: { thread_id: threadId },
    });
    const messages = state.values.messages as BaseMessage[] | undefined;
    if (!messages || messages.length <= maxMessages) {
        return false;
    }
    const kept = trimMessagesForContext(messages, maxMessages);
    if (kept.length === messages.length) {
        return false;
    }
    await graph.updateState(
        { configurable: { thread_id: threadId } },
        {
            messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...kept],
        },
    );
    return true;
}

/**
 * Pure context-window trim used by {@link trimAgentContext}.
 *
 * Keeps every leading system message and the newest complete turns. A turn
 * begins at a human message; the slice is moved back to the nearest human so
 * a tool result can never be orphaned from its call.
 *
 * @param messages - Persisted LangGraph messages.
 * @param maxMessages - Target size after trimming.
 * @returns The messages to persist.
 */
export function trimMessagesForContext(
    messages: BaseMessage[],
    maxMessages: number,
): BaseMessage[] {
    if (messages.length <= maxMessages) {
        return messages;
    }
    let systemCount = 0;
    while (
        systemCount < messages.length &&
        messages[systemCount]._getType() === "system"
    ) {
        systemCount += 1;
    }
    let start = Math.max(systemCount, messages.length - maxMessages);
    while (start > systemCount && messages[start]._getType() !== "human") {
        start -= 1;
    }
    if (messages[start]?._getType() !== "human") {
        return messages;
    }
    return [...messages.slice(0, systemCount), ...messages.slice(start)];
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
    // A message that shares exactly one issue URL is a task to implement. The
    // reference rides into `configurable` so `startCodingJob` can attach the
    // issue even when a small relay model paraphrases it into `task`.
    const sharedIssue = issueRefFromPrompt(prompt);
    const baseSystemPrompt = systemPromptForCapabilities(
        systemPrompt,
        options.capabilities ?? [],
        options.mode,
    );
    const systemPromptForTurn =
        sharedIssue === null
            ? baseSystemPrompt
            : `${baseSystemPrompt}\n\n${sharedIssueRule(sharedIssue)}`;
    // `sessionId` and `clientIp` are always stamped: they are what a guest
    // turn has instead of a `userId`, and tools that admit guests (#8) key
    // their budgets on them. Neither is new information — `sessionId` is
    // already the graph's `thread_id`, and `clientIp` is the socket's own
    // peer address. `userId` and `location` stay conditional so an
    // authenticated, location-less turn keeps the pre-#31 shape.
    const configurable = {
        sessionId,
        ...(options.userId !== undefined ? { userId: options.userId } : {}),
        ...(options.deviceId !== undefined
            ? { deviceId: options.deviceId }
            : {}),
        ...(options.location !== undefined
            ? { location: options.location }
            : {}),
        ...(options.clientIp !== undefined
            ? { clientIp: options.clientIp }
            : {}),
        ...(sharedIssue !== null ? { sharedIssue } : {}),
    };
    yield* streamAgentTurn(getAgentGraph(), markedPrompt, sessionId, {
        systemPrompt: systemPromptForTurn,
        recursionLimit: agentMaxTurns,
        configurable,
        signal: options.signal,
    });
}
