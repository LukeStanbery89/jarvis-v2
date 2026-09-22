/**
 * Parsing and serialization for the J.A.R.V.I.S. chat wire protocol.
 *
 * These are the only functions allowed to turn raw WebSocket payloads into
 * typed frames (and back), so the server (`@lukestanbery/jarvis-server`'s `ws.ts`) and the
 * CLI (`@lukestanbery/jarvis-cli`'s `client.ts`) share one implementation of the framing
 * rules. Everything here is a pure data transformation with no I/O.
 *
 * Behavior is deliberately conservative and unchanged from the historical
 * hand-written copies: unknown JSON shapes are rejected as unrecognized, and
 * the error message wording is user-facing (the CLI surfaces it verbatim) so
 * it must not drift.
 */
import { MAX_SESSION_ID_LENGTH, MAX_TOKEN_LENGTH } from "./types";
import type {
    AuthRequest,
    ChatPrompt,
    ClientFrame,
    ServerFrame,
} from "./types";

/** User-facing wording for a malformed JSON payload; must not drift. */
const MALFORMED_JSON = "malformed request; expected a JSON object";

/**
 * Parses one raw server frame into a typed {@link ServerFrame}.
 *
 * Throws if the payload is not valid JSON or matches no known frame shape;
 * the thrown message is surfaced to users by `@lukestanbery/jarvis-cli`.
 */
export function parseFrame(raw: string): ServerFrame {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("received a malformed message from the server");
    }
    const frame = parsed as {
        chunk?: unknown;
        done?: unknown;
        error?: unknown;
        tool?: { name?: unknown; args?: unknown };
        toolResult?: { name?: unknown; output?: unknown };
        authResult?: { user?: unknown; device?: unknown };
    };
    if (typeof frame.chunk === "string") {
        return { chunk: frame.chunk };
    }
    if (frame.tool && typeof frame.tool.name === "string") {
        return { tool: { name: frame.tool.name, args: frame.tool.args } };
    }
    if (frame.toolResult && typeof frame.toolResult.name === "string") {
        return {
            toolResult: {
                name: frame.toolResult.name,
                output: frame.toolResult.output,
            },
        };
    }
    if (frame.done === true) {
        return { done: true };
    }
    if (typeof frame.error === "string") {
        return { error: frame.error };
    }
    if (
        frame.authResult &&
        typeof frame.authResult.user === "string" &&
        typeof frame.authResult.device === "string"
    ) {
        return {
            authResult: {
                user: frame.authResult.user,
                device: frame.authResult.device,
            },
        };
    }
    throw new Error("received an unrecognized message from the server");
}

/** Parses raw wire text into a plain object, or throws the shared wording. */
function parseJson(raw: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(MALFORMED_JSON);
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(MALFORMED_JSON);
    }
    return parsed as Record<string, unknown>;
}

/**
 * Parses + validates a ChatPrompt-shaped object.
 *
 * Throws if `prompt` or `sessionId` are not non-empty trimmed strings, or if
 * `sessionId` exceeds {@link MAX_SESSION_ID_LENGTH} characters.
 */
function validateChatPrompt(request: {
    prompt?: unknown;
    sessionId?: unknown;
}): ChatPrompt {
    if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
        throw new Error("expected a non-empty string field 'prompt'");
    }
    if (
        typeof request.sessionId !== "string" ||
        request.sessionId.trim() === ""
    ) {
        throw new Error("expected a non-empty string field 'sessionId'");
    }
    if (request.sessionId.length > MAX_SESSION_ID_LENGTH) {
        throw new Error(
            `sessionId must be at most ${MAX_SESSION_ID_LENGTH} characters`,
        );
    }
    return { prompt: request.prompt, sessionId: request.sessionId };
}

/**
 * Validates an `auth` handshake object.
 *
 * Throws if `token` is not a non-empty trimmed string or exceeds
 * {@link MAX_TOKEN_LENGTH} characters.
 */
function validateAuthRequest(request: { token?: unknown }): AuthRequest {
    if (typeof request.token !== "string" || request.token.trim() === "") {
        throw new Error("expected a non-empty string field 'token'");
    }
    if (request.token.length > MAX_TOKEN_LENGTH) {
        throw new Error(`token must be at most ${MAX_TOKEN_LENGTH} characters`);
    }
    return { type: "auth", token: request.token };
}

/**
 * Parses one raw client message into a typed {@link ClientFrame}.
 *
 * A `type: "auth"` message is validated as the first-frame handshake; anything
 * else is validated as a legacy {@link ChatPrompt}. Throws on malformed JSON
 * (or a non-object) or shape violations; the thrown message is surfaced to
 * users by the server's error frames and must not drift.
 */
export function parseClientMessage(raw: string): ClientFrame {
    const msg = parseJson(raw) as {
        type?: unknown;
        token?: unknown;
        prompt?: unknown;
        sessionId?: unknown;
    };
    if (msg.type === "auth") {
        return validateAuthRequest({ token: msg.token });
    }
    return validateChatPrompt(msg);
}

/**
 * Parses one raw client request into a validated {@link ChatPrompt}.
 *
 * Kept for callers that chat (and maybe authenticate): identical to the
 * prompt branch of {@link parseClientMessage}. Throws if the payload is not
 * valid JSON, if `prompt` or `sessionId` are not non-empty trimmed strings, or
 * if `sessionId` exceeds {@link MAX_SESSION_ID_LENGTH} characters.
 */
export function parseRequest(raw: string): ChatPrompt {
    return validateChatPrompt(parseJson(raw));
}

/** Serializes a server frame to its wire JSON text. */
export function serializeFrame(frame: ServerFrame): string {
    return JSON.stringify(frame);
}

/** Serializes a client chat request to its wire JSON text. */
export function serializeRequest(prompt: string, sessionId: string): string {
    return JSON.stringify({ prompt, sessionId });
}

/** Serializes the `auth` handshake frame to its wire JSON text. */
export function serializeAuth(token: string): string {
    return JSON.stringify({ type: "auth", token } satisfies AuthRequest);
}
