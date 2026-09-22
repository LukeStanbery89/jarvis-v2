/**
 * Domain events produced while running one agent turn.
 *
 * The turn function `streamAgentTurn` (and its transport seam `runAgent`)
 * stream these events outward; each concrete transport maps them onto its own
 * representation (the WebSocket endpoint maps them onto `@lukestanbery/jarvis-protocol`
 * frames). `token` events carry the streamed answer text, `tool` announces a
 * model tool call, and `toolResult` carries an executed tool's output.
 */
export type AgentEvent =
    | { type: "token"; text: string }
    | { type: "tool"; name: string; args: unknown }
    | { type: "toolResult"; name: string; output: unknown };
