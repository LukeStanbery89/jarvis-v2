/**
 * Folds streamed LangGraph messages into `AgentEvent`s.
 *
 * `streamAgentTurn` emits the graph in `"messages"` mode, so each observed
 * message is either a text/tool-chunk `AIMessage` (possibly split across many
 * `tool_call_chunks`) or a `ToolMessage` carrying a tool's output. This
 * tracker maps that noisy stream onto the stable public shape:
 *
 * - Text content becomes `token` events (suppressed while a tool call streams,
 *   so the client never sees interleaved reasoning mid-call).
 * - Tool calls become `tool` events, announced exactly once per call id.
 * - Executed tools become `toolResult` events, keyed to the call that made
 *   them; a call that was never announced (e.g. args never parsed during
 *   streaming) is announced at result time.
 * - Whitespace-only text that opens a segment is dropped: a local model
 *   emits `\n\n` around its tool calls, and on a client the first chunk after
 *   a tool opens a *new* assistant bubble, so forwarding it drew an empty chat
 *   bubble before the call had even run.
 *
 * It owns both the lookup map of pending calls and the dedupe set, which is
 * what makes the announced-exactly-once guarantee possible.
 */
import type { BaseMessage } from "@langchain/core/messages";
import {
    AIMessage,
    AIMessageChunk,
    ToolMessage,
} from "@langchain/core/messages";
import type { AgentEvent } from "./event";

export type { AgentEvent } from "./event";

/** Tracks a tool call seen in the stream until its result arrives. */
interface PendingToolCall {
    name: string;
    args: Record<string, unknown> | string;
    /**
     * The call's real id, learned from whichever chunk carried one (usually
     * only the first delta). Announcements and dedupe key off this id so the
     * final aggregated `tool_calls` message never re-announces the call.
     */
    callId?: string;
}

/**
 * Translates streamed messages into agent events.
 *
 * Created per agent turn; feed it every message from the stream in order and
 * forward whatever it returns to the client.
 */
export class ToolCallTracker {
    private readonly tracked = new Map<string, PendingToolCall>();
    /** Maps a real call id onto the tracked entry key that accumulates it. */
    private readonly keyByCallId = new Map<string, string>();
    private readonly announced = new Set<string>();
    /**
     * Whether the current text segment has produced visible content yet.
     *
     * A segment opens with the turn and re-opens at every tool boundary,
     * because a `tool` frame is a message boundary on the client: the next
     * chunk it receives starts a fresh assistant bubble rather than continuing
     * the old one. Until a segment shows real text, whitespace-only content is
     * filler nobody can see — dropping it is what keeps an empty bubble from
     * appearing ahead of a tool call. Once text has arrived, whitespace is
     * ordinary formatting and streams through untouched.
     */
    private textStarted = false;

    /** Converts one streamed message into the events it implies. */
    onMessage(message: BaseMessage): AgentEvent[] {
        if (message._getType?.() === "tool") {
            return this.onToolResult(message as ToolMessage);
        }
        if (message._getType?.() === "ai") {
            return this.onModelMessage(message as AIMessage);
        }
        return [];
    }

    /**
     * Extracts events from a model-produced message.
     *
     * Text content becomes `token` events. Tool calls are announced as `tool`
     * events as soon as their name and args are known — either from a complete
     * `tool_calls` payload or from accumulated streaming `tool_call_chunks`
     * whose args successfully JSON-parse.
     *
     * Two hazards shaped this code:
     *
     * - Chunk accumulation keys off `index` because OpenAI-compatible
     *   providers (LM Studio included) put the call `id` only on the first
     *   delta while argument deltas carry just the index; keying by
     *   `id ?? index` split one call into a name-only entry and an args-only
     *   entry, announcing a phantom call under the fallback name "tool". The
     *   real id — remembered from whichever chunk carried it — is what
     *   announcements and dedupe key on.
     * - On a streamed chunk the `tool_calls` getter eagerly parses whatever
     *   args have arrived so far (an empty `{}` until the JSON completes), so
     *   the complete-payload loop must only run for genuine (non-chunk)
     *   `AIMessage`s — otherwise every named chunk announces a premature
     *   empty-args call.
     */
    private onModelMessage(message: AIMessage): AgentEvent[] {
        const events: AgentEvent[] = [];

        if (!(message instanceof AIMessageChunk)) {
            for (const call of message.tool_calls ?? []) {
                if (!call.id || !call.name) {
                    continue;
                }
                const key = this.keyByCallId.get(call.id) ?? call.id;
                this.keyByCallId.set(call.id, key);
                if (!this.announced.has(call.id)) {
                    this.announced.add(call.id);
                    this.tracked.set(key, {
                        name: call.name,
                        args: (call.args ?? {}) as Record<string, unknown>,
                        callId: call.id,
                    });
                    this.pushToolCall(events, {
                        type: "tool",
                        name: call.name,
                        args: call.args ?? {},
                    });
                }
            }
        }

        const chunks = (message as AIMessageChunk).tool_call_chunks;
        for (const call of chunks ?? []) {
            const aliased = call.id ? this.keyByCallId.get(call.id) : undefined;
            const key =
                aliased ??
                (typeof call.index === "number" ? `#${call.index}` : call.id);
            if (!key) {
                continue;
            }
            if (call.id) {
                this.keyByCallId.set(call.id, key);
            }
            const pending = this.tracked.get(key);
            const callId = call.id ?? pending?.callId;
            const name = call.name || pending?.name;
            if (call.name) {
                this.tracked.set(key, {
                    name: call.name,
                    args: pending?.args ?? {},
                    callId,
                });
            }
            if (typeof call.args === "string") {
                const base =
                    typeof pending?.args === "string" ? pending.args : "";
                const merged = `${base}${call.args}`;
                let parsed: Record<string, unknown> | undefined;
                try {
                    parsed = JSON.parse(merged);
                } catch {
                    parsed = undefined;
                }
                if (parsed !== undefined) {
                    this.tracked.set(key, {
                        name: name ?? "tool",
                        args: parsed,
                        callId,
                    });
                    // Announce only once the call's name is known, and key the
                    // dedupe on the real call id — the final aggregated
                    // `tool_calls` message carries that same id and must not
                    // announce the call a second time.
                    if (name && callId && !this.announced.has(callId)) {
                        this.announced.add(callId);
                        this.pushToolCall(events, {
                            type: "tool",
                            name,
                            args: parsed,
                        });
                    }
                } else {
                    this.tracked.set(key, {
                        name: name ?? "tool",
                        args: merged,
                        callId,
                    });
                }
            }
        }

        if (
            typeof message.content === "string" &&
            message.content.length > 0 &&
            !(chunks && chunks.length > 0)
        ) {
            const text = message.content;
            const visible = text.trim() !== "";
            if (visible || this.textStarted) {
                // Inside this branch the text either shows something (opening
                // the segment) or follows text that already did — so the
                // segment has started either way.
                this.textStarted = true;
                events.push({ type: "token", text });
            }
        }
        return events;
    }

    /**
     * Pushes a `tool` announcement and re-opens the text segment.
     *
     * The announcement is a message boundary on the client: the chunk that
     * follows it opens a new assistant bubble, so the filler a model emits
     * around a call must be judged against that fresh segment rather than
     * against the prose that preceded the call.
     */
    private pushToolCall(events: AgentEvent[], event: AgentEvent): void {
        events.push(event);
        this.textStarted = false;
    }

    /**
     * Extracts a `toolResult` event from a ToolMessage, announcing the matching
     * `tool` event first if it was never announced (e.g. args never parsed
     * during streaming).
     */
    private onToolResult(message: ToolMessage): AgentEvent[] {
        // The result is the other half of the boundary: text that streamed
        // between the announcement and this result opened its own bubble, and
        // anything arriving now opens another one.
        this.textStarted = false;
        const id = message.tool_call_id;
        const key = id ? this.keyByCallId.get(id) : undefined;
        const pending =
            (key ? this.tracked.get(key) : undefined) ??
            (id ? this.tracked.get(id) : undefined);
        const name = pending?.name ?? message.name ?? "tool";
        const args = typeof pending?.args === "object" ? pending.args : {};
        const output =
            typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content);

        const events: AgentEvent[] = [];
        if (id && !this.announced.has(id)) {
            this.announced.add(id);
            events.push({ type: "tool", name, args });
        }
        events.push({ type: "toolResult", name, output });
        return events;
    }
}
