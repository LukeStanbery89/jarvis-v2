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

/** One event produced while running an agent turn. */
export type AgentEvent =
    | { type: "token"; text: string }
    | { type: "tool"; name: string; args: unknown }
    | { type: "toolResult"; name: string; output: unknown };

/** Tracks a tool call seen in the stream until its result arrives. */
interface PendingToolCall {
    name: string;
    args: Record<string, unknown> | string;
}

/**
 * Translates streamed messages into agent events.
 *
 * Created per agent turn; feed it every message from the stream in order and
 * forward whatever it returns to the client.
 */
export class ToolCallTracker {
    private readonly tracked = new Map<string, PendingToolCall>();
    private readonly announced = new Set<string>();

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
     */
    private onModelMessage(message: AIMessage): AgentEvent[] {
        const events: AgentEvent[] = [];

        for (const call of message.tool_calls ?? []) {
            if (!call.id || !call.name) {
                continue;
            }
            if (!this.announced.has(call.id)) {
                this.announced.add(call.id);
                this.tracked.set(call.id, {
                    name: call.name,
                    args: (call.args ?? {}) as Record<string, unknown>,
                });
                events.push({
                    type: "tool",
                    name: call.name,
                    args: call.args ?? {},
                });
            }
        }

        const chunks = (message as AIMessageChunk).tool_call_chunks;
        for (const call of chunks ?? []) {
            const id = call.id ?? call.index?.toString();
            if (!id) {
                continue;
            }
            const pending = this.tracked.get(id);
            const name = call.name || pending?.name;
            if (call.name) {
                this.tracked.set(id, {
                    name: call.name,
                    args: pending?.args ?? {},
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
                    this.tracked.set(id, {
                        name: name ?? "tool",
                        args: parsed,
                    });
                    // Announce only once the call's name is known. Streaming
                    // chunks may key the same call by id and index at different
                    // times (the name often arrives under one key and complete
                    // args under the other), so a chunk with unknown name is
                    // left for the final tool_calls message to announce —
                    // otherwise a fallback "tool" name would leak into the
                    // event stream.
                    if (name && !this.announced.has(id)) {
                        this.announced.add(id);
                        events.push({ type: "tool", name, args: parsed });
                    }
                } else {
                    this.tracked.set(id, {
                        name: name ?? "tool",
                        args: merged,
                    });
                }
            }
        }

        if (
            typeof message.content === "string" &&
            message.content.length > 0 &&
            !(chunks && chunks.length > 0)
        ) {
            events.push({ type: "token", text: message.content });
        }
        return events;
    }

    /**
     * Extracts a `toolResult` event from a ToolMessage, announcing the matching
     * `tool` event first if it was never announced (e.g. args never parsed
     * during streaming).
     */
    private onToolResult(message: ToolMessage): AgentEvent[] {
        const id = message.tool_call_id;
        const pending = id ? this.tracked.get(id) : undefined;
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
