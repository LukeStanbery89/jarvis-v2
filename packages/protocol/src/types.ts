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
 * handshake (to bind the socket to an account), the first-frame `hello`
 * announcement (to declare what the client can render), or a chat prompt.
 */
export type ClientFrame = AuthRequest | ClientHello | ChatPrompt;

/**
 * The auth handshake: the client's first frame, presenting a stored device
 * token to bind the socket to a user account.
 */
export interface AuthRequest {
    type: "auth";
    token: string;
}

/**
 * What one chat client is capable of rendering in the server's response.
 *
 * Tokens are coarse render guarantees the client absorbs as plain text; the
 * server conditions its output (and eventually its content frames) on the
 * capabilities an announcing client declared. Unknown tokens are rejected at
 * parse time so the shared contract stays tight.
 */
export type ClientCapability = "markdown" | "html" | "image" | "link";

/**
 * The capability announcement: a client's optional first frame declaring, in
 * `capabilities`, which of the {@link ClientCapability} tokens it can render.
 * The server logs and stores the declaration for the socket's lifetime and
 * conditions the agent's system prompt on it. An empty array ("renders plain
 * text only") is valid; a second `hello` on the same socket is rejected.
 */
export interface ClientHello {
    type: "hello";
    capabilities: ClientCapability[];
}

/**
 * The chat mode a prompt runs under.
 *
 * Structurally mirrors the session ledger's `SessionKind` ("text" | "voice")
 * in `@lukestanbery/jarvis-auth` — the server passes the wire value straight
 * through as the ledger kind without importing this package. `"text"` chats
 * are answered using the client's declared render capabilities; `"voice"`
 * chats always yield plain conversational text.
 */
export type ChatMode = "text" | "voice";

/**
 * A chat request from a client: the free-text `prompt` and the `sessionId`
 * naming the LangGraph conversation thread it continues, plus the optional
 * `mode` the chat runs under (absent means `"text"`).
 */
export interface ChatPrompt {
    prompt: string;
    sessionId: string;
    /**
     * The chat mode for this prompt; `"text"` when omitted. `"voice"` prompts
     * are answered with plain conversational text regardless of the client's
     * declared render capabilities. The server records the mode as the
     * session's `kind` when it first claims the thread.
     */
    mode?: ChatMode;
    /**
     * Ids of previously uploaded attachments this prompt references
     * (`POST /api/attachments` returns them), when the prompt is about
     * images. Absent (or empty) for plain text prompts. Ids are opaque to the
     * protocol — the server resolves them against its attachment store and
     * rejects ids that do not exist or belong to another user.
     */
    attachments?: string[];
}

/** Longest `sessionId` a client may send in a chat request. */
export const MAX_SESSION_ID_LENGTH = 128;

/** Longest device `token` a client may send in an `auth` handshake. */
export const MAX_TOKEN_LENGTH = 128;

/**
 * Longest `capabilities` list a client may send in a `hello` frame.
 *
 * A 16-token cap bounds the frame without sacrificing the known token set,
 * which is itself bounded by the `"markdown" | "html" | "image" | "link"`
 * union.
 */
export const MAX_CAPABILITIES = 16;

/** Longest single capability token a client may send in a `hello` frame. */
export const MAX_CAPABILITY_LENGTH = 16;

/**
 * Longest `attachments` list a prompt may reference.
 *
 * A vision-language tool call analyzes one image per id; four bounds the
 * per-prompt analysis cost without harming any plausible use (screenshots plus
 * a photo, say).
 */
export const MAX_ATTACHMENTS = 4;

/**
 * Longest single attachment id a prompt may reference.
 *
 * Server-generated ids are 18 random bytes — 24 characters of base64url — so
 * the bound has slack for a future id scheme without re-opening the protocol.
 */
export const MAX_ATTACHMENT_ID_LENGTH = 32;
