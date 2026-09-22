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
 *
 * Every prompt claims its `sessionId` in the app session ledger
 * (`claimSession`), runs under a **per-thread lock** (a concurrent turn on the
 * same thread is rejected) and a hard **turn timeout** so the lock always
 * drains. Guest sockets' claimed sessions are deleted when the socket closes;
 * owned sessions persist until explicitly deleted.
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
import { DEFAULT_TURN_TIMEOUT_MS } from "./config";
import { runAgent } from "./agent";
import type { AgentEvent } from "./agent";
import { toServerFrame } from "./transport";
import { logger } from "./logger";

/** The identity every socket starts with and failed auth falls back to. */
const GUEST_CONTEXT: AuthContext = Object.freeze({ user: null, device: null });

/** Thread ids with a turn currently in flight, across all sockets. */
const threadLocks = new Set<string>();

/** Per-connection auth + guest-ledger state. */
interface ConnectionState {
    /** Whether the socket's first frame has been consumed by an auth or prompt. */
    authed: boolean;
    /** Resolved identity: the account + presenting device, or guest. */
    ctx: AuthContext;
    /** Guest sessions this socket claimed; deleted when the socket closes. */
    guestThreads: Set<string>;
}

/** Options for {@link attachChatServer}. */
export interface AttachmentOptions {
    /** Hard cap for one agent turn before the server aborts it. */
    turnTimeoutMs: number;
}

/**
 * Attaches the WebSocket chat server to an HTTP server and returns it.
 *
 * `httpServer` should already be listening; the chat server accepts
 * connections on the `"/ws"` path. `store` backs the auth handshake and the
 * session ledger; `options.turnTimeoutMs` bounds every turn.
 */
export function attachChatServer(
    httpServer: Server,
    store: AppStore,
    options: AttachmentOptions = { turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS },
): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (socket) => {
        logger.info("New WebSocket connection");
        let active: Promise<void> | null = null;
        const conn: ConnectionState = {
            authed: false,
            ctx: GUEST_CONTEXT,
            guestThreads: new Set(),
        };

        socket.on("message", (raw) => {
            if (active) {
                logger.warn(
                    "Rejecting prompt: another request is already in progress",
                );
                sendError(socket, "another request is already in progress");
                return;
            }
            active = handleMessage(raw, socket, conn, store, options)
                .catch(() => {
                    // handleMessage sends its own error frames; never reject.
                })
                .finally(() => {
                    active = null;
                });
        });

        socket.on("close", () => {
            for (const threadId of conn.guestThreads) {
                store.deleteSession(threadId);
            }
            logger.info("WebSocket connection closed");
        });
    });

    return wss;
}

/**
 * Handles one incoming frame.
 *
 * An `auth` frame resolves the socket's identity (only valid as the first
 * frame); any other frame is a prompt that claims its session and streams the
 * agent's events over the socket. Invalid messages get an error frame, as do
 * LLM failures on the stream path. Returns a promise that settles when the
 * response is fully streamed (or the frame was rejected).
 */
async function handleMessage(
    raw: RawData,
    socket: WebSocket,
    conn: ConnectionState,
    store: AppStore,
    options: AttachmentOptions,
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
        await handlePrompt(socket, conn, store, frame, options);
        return;
    }
    await handleAuth(socket, conn, store, frame.token);
}

/**
 * Runs one guest/owned prompt turn.
 *
 * The socket degrades to guest on its first prompt if it never authed. The
 * prompt's `sessionId` is claimed in the session ledger, then streamed under a
 * per-thread lock so a second concurrent turn on the same thread is rejected;
 * the turn also runs under {@link AttachmentOptions.turnTimeoutMs}. Guest
 * sockets track the sessions they created so the socket-close handler can
 * remove the ephemeral rows; owned sessions persist.
 */
async function handlePrompt(
    socket: WebSocket,
    conn: ConnectionState,
    store: AppStore,
    prompt: Extract<ClientFrame, { prompt: string }>,
    options: AttachmentOptions,
): Promise<void> {
    if (!conn.authed) {
        conn.authed = true;
        conn.ctx = GUEST_CONTEXT;
    }
    const { sessionId } = prompt;
    if (threadLocks.has(sessionId)) {
        logger.warn(
            `Rejecting prompt: another request is already in progress for ${sessionId}`,
        );
        sendError(socket, "another request is already in progress");
        return;
    }
    threadLocks.add(sessionId);
    try {
        const { created } = store.claimSession(sessionId, {
            userId: conn.ctx.user?.id ?? null,
            deviceId: conn.ctx.device?.id ?? null,
            kind: "text",
        });
        if (created && !conn.ctx.user) {
            conn.guestThreads.add(sessionId);
        }
        await streamEventsToSocket(
            socket,
            prompt.prompt,
            sessionId,
            options.turnTimeoutMs,
        );
    } finally {
        threadLocks.delete(sessionId);
        store.touchSession(sessionId);
    }
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
 * `{"done": true}`, or an error frame followed by `done` if the agent fails,
 * the socket closes mid-stream, or the turn exceeds `turnTimeoutMs`.
 *
 * The timeout error is emitted by the timer itself (the in-flight generator
 * gets `return()`d shortly after, running its finally path and dropping
 * further events) so the per-thread lock drains promptly.
 */
async function streamEventsToSocket(
    socket: WebSocket,
    prompt: string,
    sessionId: string,
    turnTimeoutMs: number,
): Promise<void> {
    let finished = false;
    let generator: AsyncGenerator<AgentEvent> | null = null;
    const finishWithError = (message: string) => {
        if (finished) {
            return;
        }
        finished = true;
        sendError(socket, message);
    };
    const timer = setTimeout(() => {
        logger.warn(`Turn exceeded ${turnTimeoutMs}ms; aborting`);
        finishWithError(`turn timed out after ${turnTimeoutMs}ms`);
        void generator?.return?.(undefined);
    }, turnTimeoutMs);
    try {
        generator = runAgent(prompt, sessionId);
        try {
            for await (const event of generator) {
                if (finished || socket.readyState !== WebSocket.OPEN) {
                    return;
                }
                logAgentEvent(event);
                sendFrame(socket, toServerFrame(event));
            }
        } catch (err) {
            logger.error(
                `LLM stream failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            finishWithError("model request failed");
            return;
        }
        if (finished) {
            return;
        }
        logger.debug("Agent stream complete");
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        finished = true;
        sendFrame(socket, { done: true });
    } finally {
        clearTimeout(timer);
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
