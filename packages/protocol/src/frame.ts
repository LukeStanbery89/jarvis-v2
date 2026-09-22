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
import { MAX_SESSION_ID_LENGTH } from "./types";
import type { ChatPrompt, ServerFrame } from "./types";

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
    throw new Error("received an unrecognized message from the server");
}

/**
 * Parses one raw client request into a validated {@link ChatPrompt}.
 *
 * Throws if the payload is not valid JSON, if `prompt` or `sessionId` are not
 * non-empty trimmed strings, or if `sessionId` exceeds
 * {@link MAX_SESSION_ID_LENGTH} characters.
 */
export function parseRequest(raw: string): ChatPrompt {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("malformed request; expected a JSON object");
    }

    const request = parsed as { prompt?: unknown; sessionId?: unknown };
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

/** Serializes a server frame to its wire JSON text. */
export function serializeFrame(frame: ServerFrame): string {
    return JSON.stringify(frame);
}

/** Serializes a client chat request to its wire JSON text. */
export function serializeRequest(prompt: string, sessionId: string): string {
    return JSON.stringify({ prompt, sessionId });
}
