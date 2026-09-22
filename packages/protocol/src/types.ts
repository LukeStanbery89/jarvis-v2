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
 * `chunk` / `tool` / `toolResult` / `done` / `error` / `authResult` is present.
 */
export type ServerFrame =
    | { chunk: string }
    | { tool: { name: string; args?: unknown } }
    | { toolResult: { name: string; output?: unknown } }
    | { done: true }
    | { error: string }
    | AuthResultFrame;

/** Payload of an `authResult` frame: the account a socket is now bound to. */
export interface AuthResult {
    /** The authenticated user's username. */
    user: string;
    /** The name of the device the client authenticated with. */
    device: string;
}

/** Server acknowledgment of a successful auth handshake (`{ "authResult": … }`). */
export interface AuthResultFrame {
    authResult: AuthResult;
}

/**
 * A frame a chat client sends to the server over `/ws`.
 *
 * Exactly one of these shapes arrives per message: the first-frame `auth`
 * handshake (to bind the socket to an account), or a chat prompt.
 */
export type ClientFrame = AuthRequest | ChatPrompt;

/**
 * The auth handshake: the client's first frame, presenting a stored device
 * token to bind the socket to a user account.
 */
export interface AuthRequest {
    type: "auth";
    token: string;
}

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

/** Longest device `token` a client may send in an `auth` handshake. */
export const MAX_TOKEN_LENGTH = 128;
