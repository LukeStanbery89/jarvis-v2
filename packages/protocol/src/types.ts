/**
 * Shared chat wire-protocol types for J.A.R.V.I.S. packages.
 *
 * This is the **single source of truth** for the frames exchanged over the
 * `/ws` WebSocket between `@lukestanbery/jarvis-cli` and `@lukestanbery/jarvis-server`. Keeping the
 * shapes here (rather than duplicated in each package) guarantees a frame
 * rename or shape change surfaces as a compile error everywhere a frame is
 * handled, instead of a silent runtime mismatch.
 */

/**
 * A frame the server sends to chat clients over `/ws`.
 *
 * Frames are JSON object frames, key-discriminated: exactly one of
 * `chunk` / `tool` / `toolResult` / `done` / `error` is present.
 */
export type ServerFrame =
    | { chunk: string }
    | { tool: { name: string; args?: unknown } }
    | { toolResult: { name: string; output?: unknown } }
    | { done: true }
    | { error: string };

/**
 * A chat request from a client: the free-text `prompt` and the `sessionId`
 * naming the LangGraph conversation thread it continues.
 */
export interface ChatPrompt {
    prompt: string;
    sessionId: string;
}

/** Longest `sessionId` a client may send in a chat request. */
export const MAX_SESSION_ID_LENGTH = 128;
