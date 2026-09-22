/**
 * WebSocket chat endpoint.
 *
 * Mounted on the `"/ws"` path of the HTTP server. Clients may authenticate on
 * their **first frame** by presenting a device token (`{ type: "auth", token }`);
 * the server replies with one `authResult` frame. Any other first frame — or
 * no auth at all — runs the socket as a **guest** (ephemeral,
 * identity-independent chats). Afterwards clients send JSON prompt frames and
 * receive chunk/done frames back. The frame shapes and parse/serialize logic
 * live in `@lukestanbery/jarvis-protocol` — the single source of truth for
 * the wire protocol — so the server never re-declares them.
 */
import type { Server } from "http";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import {
    parseClientMessage,
    serializeFrame,
    type ClientFrame,
} from "@lukestanbery/jarvis-protocol";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { hashDeviceToken } from "./auth";
import type { AppStore, AuthContext } from "./auth";
import { runAgent } from "./agent";
import type { AgentEvent } from "./agent";
import { toServerFrame } from "./transport";
import { logger } from "./logger";

/** The identity every socket starts with and failed auth falls back to. */
const GUEST_CONTEXT: AuthContext = Object.freeze({ user: null, device: null });

/** Per-connection auth state. */
interface ConnectionState {
    /** Whether the socket's first frame has been consumed by an auth or prompt. */
    authed: boolean;
    /** Resolved identity: the account + presenting device, or guest. */
    ctx: AuthContext;
}

/**
 * Attaches the WebSocket chat server to an HTTP server and returns it.
 *
 * `httpServer` should already be listening; the chat server accepts
 * connections on the `"/ws"` path. `store` backs the auth handshake.
 */
export function attachChatServer(
    httpServer: Server,
    store: AppStore,
): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (socket) => {
        logger.info("New WebSocket connection");
        let active: Promise<void> | null = null;
        const conn: ConnectionState = { authed: false, ctx: GUEST_CONTEXT };

        socket.on("message", (raw) => {
            if (active) {
                logger.warn(
                    "Rejecting prompt: another request is already in progress",
                );
                sendError(socket, "another request is already in progress");
                return;
            }
            active = handleMessage(raw, socket, conn, store)
                .catch(() => {
                    // handleMessage sends its own error frames; never reject.
                })
                .finally(() => {
                    active = null;
                });
        });
    });

    return wss;
}

/**
 * Handles one incoming frame.
 *
 * An `auth` frame resolves the socket's identity (only valid as the first
 * frame); any other frame is a prompt that streams the agent's events over
 * the socket. Invalid messages get an error frame, as do LLM failures the
 * stream path. Returns a promise that settles when the response is fully
 * streamed (or the frame was rejected).
 */
async function handleMessage(
    raw: RawData,
    socket: WebSocket,
    conn: ConnectionState,
    store: AppStore,
): Promise<void> {
    const frameText = raw.toString();
    logger.sensitive("Received message from WebSocket", frameText);
    let frame: ClientFrame;
    try {
        frame = parseClientMessage(frameText);
    } catch (err) {
        const detail = err instanceof Error ? err.message : "unknown error";
        logger.error(`Failed to parse WebSocket message: ${detail}`);
        sendError(
            socket,
            "invalid message format; expected 'prompt' and 'sessionId' " +
                "non-empty string fields",
        );
        return;
    }

    if (!("type" in frame)) {
        if (!conn.authed) {
            conn.authed = true;
            conn.ctx = GUEST_CONTEXT;
        }
        await streamEventsToSocket(socket, frame.prompt, frame.sessionId);
        return;
    }
    await handleAuth(socket, conn, store, frame.token);
}

/**
 * Resolves an `auth` handshake frame.
 *
 * Only valid as the socket's first frame; a valid token binds the socket to
 * its account (one `authResult` frame), an unknown token gets an error frame
 * and the socket continues as a guest. Either way the slot is consumed — a
 * client only gets one chance to authenticate.
 */
async function handleAuth(
    socket: WebSocket,
    conn: ConnectionState,
    store: AppStore,
    token: string,
): Promise<void> {
    if (conn.authed) {
        logger.warn("Rejecting auth: handshake must be the first frame");
        sendError(socket, "auth handshake must be the first frame");
        return;
    }
    conn.authed = true;
    const identity = store.resolveToken(hashDeviceToken(token));
    if (!identity) {
        logger.warn("Rejecting auth: unknown device token");
        sendError(socket, "invalid device token");
        return;
    }
    conn.ctx = { user: identity.user, device: identity.device };
    logger.info(
        `Socket authenticated as ${identity.user.username} (device: ${identity.device.name})`,
    );
    sendFrame(socket, {
        authResult: {
            user: identity.user.username,
            device: identity.device.name,
        },
    });
}

/**
 * Streams the agent's events to the socket as frames, finishing with
 * `{"done": true}`, or an error frame followed by `done` if the agent fails or
 * the socket closes mid-stream.
 */
async function streamEventsToSocket(
    socket: WebSocket,
    prompt: string,
    sessionId: string,
): Promise<void> {
    try {
        for await (const event of runAgent(prompt, sessionId)) {
            if (socket.readyState !== WebSocket.OPEN) {
                return;
            }
            logAgentEvent(event);
            sendFrame(socket, toServerFrame(event));
        }
        logger.debug("Agent stream complete");
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        sendFrame(socket, { done: true });
    } catch (err) {
        logger.error(
            `LLM stream failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        sendError(socket, "model request failed");
    }
}

/**
 * Emits the per-event stream diagnostics while a turn is forwarded.
 *
 * Kept separate from `toServerFrame` (which is a pure mapping) so the
 * transport's logging side effects stay visible in one small helper.
 */
function logAgentEvent(event: AgentEvent): void {
    switch (event.type) {
        case "token":
            logger.sensitiveDebug("LLM token", event.text);
            break;
        case "tool":
            logger.info(`Agent calling tool ${event.name}`);
            break;
        case "toolResult":
            logger.debug(`Tool ${event.name} returned`);
            break;
    }
}

/** Sends an error frame followed by a `done` frame. */
function sendError(socket: WebSocket, message: string): void {
    logger.info(`Sending error frame to WebSocket: ${message}`);
    sendFrame(socket, { error: message });
    sendFrame(socket, { done: true });
}

/** Serializes and sends one server frame. */
function sendFrame(socket: WebSocket, frame: ServerFrame): void {
    socket.send(serializeFrame(frame));
}
