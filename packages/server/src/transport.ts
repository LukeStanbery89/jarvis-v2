/**
 * Pure `AgentEvent → ServerFrame` mapping.
 *
 * The single home for turning one agent event into exactly one wire frame, so
 * transports never need to know how the agent reports progress. `ws.ts` (and
 * any future transport) consumes this function and appends the terminal
 * `{ "done": true }` frame itself after the stream ends.
 */
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import type { AgentEvent } from "./llm/event";

/**
 * Maps one {@link AgentEvent} onto its {@link ServerFrame}.
 *
 * Exhaustive over the event union: `token` → `chunk`, `tool` → `tool`, and
 * `toolResult` → `toolResult`. A new event kind forces a compile error here,
 * which is the point — every transport stays in lockstep with the model layer.
 */
export function toServerFrame(event: AgentEvent): ServerFrame {
    switch (event.type) {
        case "token":
            return { chunk: event.text };
        case "tool":
            return { tool: { name: event.name, args: event.args } };
        case "toolResult":
            return { toolResult: { name: event.name, output: event.output } };
    }
}
