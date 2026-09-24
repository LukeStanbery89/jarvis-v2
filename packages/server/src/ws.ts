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
 * same thread is rejected) and a hard **turn timeout**. Guest sockets' claimed
 * sessions are deleted when the socket closes; owned sessions persist until
 * explicitly deleted. A session is only ever touchable by the principal that
 * owns it — a compromise of a `sessionId` alone is not enough to read another
 * account's (or another guest's) conversation history. Authenticated sockets
 * are re-checked against the store on every prompt, so a revoked device is
 * cut off as soon as it speaks.
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
import { hashDeviceToken } from "@lukestanbery/jarvis-auth";
import type { AppDatabase, AuthContext } from "@lukestanbery/jarvis-auth";
import { DEFAULT_TURN_TIMEOUT_MS } from "./config";
import { createSessionManager } from "./sessionManager";
import type { SessionManager, TurnOutcome } from "./sessionManager";
import { runAgent } from "./agent";
import type { AgentEvent } from "./agent";
import { toServerFrame } from "./transport";
import { logger } from "./logger";

/** The identity every socket starts with and failed auth falls back to. */
const GUEST_CONTEXT: AuthContext = Object.freeze({ kind: "guest" });

/** Per-connection auth + guest-ledger state. */
interface ConnectionState {
    /** Whether the socket's first frame has been consumed by an auth or prompt. */
    authed: boolean;
    /** Resolved identity: the account + presenting device, or guest. */
    ctx: AuthContext;
    /** Token hash of the authenticating device (for per-prompt revocation checks). */
    tokenHash?: string;
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
 * session ledger; `options.turnTimeoutMs` bounds every turn. The per-prompt
 * session pipeline (lock → claim → ownership guard → stream → touch →
 * release) runs inside a {@link SessionManager}, keeping this module to
 * protocol + socket concerns.
 */
export function attachChatServer(
    httpServer: Server,
    store: AppDatabase,
    options: AttachmentOptions = { turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS },
): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const sessions = createSessionManager(store);

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
            active = handleMessage(raw, socket, conn, store, sessions, options)
                .catch((err) => {
                    // handleMessage answers expected failures with error frames;
                    // anything escaping it (a store error, an unexpected throw)
                    // must still surface to the client rather than hang it.
                    logger.error(
                        `Unhandled error handling message: ${err instanceof Error ? err.message : String(err)}`,
                    );
                    sendError(socket, "internal server error");
                })
                .finally(() => {
                    active = null;
                });
        });

        socket.on("close", () => {
            sessions.cleanupGuests(conn.guestThreads);
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
    store: AppDatabase,
    sessions: SessionManager,
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
        sendError(socket, detail);
        return;
    }

    if (!("type" in frame)) {
        await handlePrompt(socket, conn, store, sessions, frame, options);
        return;
    }
    await handleAuth(socket, conn, store, frame.token);
}

/**
 * Runs one guest/owned prompt turn.
 *
 * The socket degrades to guest on its first prompt if it never authed. The
 * prompt's `sessionId` goes through the {@link SessionManager} pipeline —
 * lock, claim in the ledger, ownership guard, stream under `turnTimeoutMs`,
 * touch, release — which answers `busy`/`not-owned` where ws.ts only needs to
 * pick the error frame. Guest sockets track the sessions they created so the
 * socket-close handler can remove the ephemeral rows; owned sessions persist.
 */
async function handlePrompt(
    socket: WebSocket,
    conn: ConnectionState,
    store: AppDatabase,
    sessions: SessionManager,
    prompt: Extract<ClientFrame, { prompt: string }>,
    options: AttachmentOptions,
): Promise<void> {
    if (!conn.authed) {
        conn.authed = true;
        conn.ctx = GUEST_CONTEXT;
    }
    // DHCP-style revocation check: a device token may have been revoked since
    // the handshake. Re-resolve on every prompt so a revoked credential is
    // cut off immediately instead of living on in `conn.ctx`.
    if (conn.ctx.kind === "authed") {
        const identity = store.resolveTokenHash(conn.tokenHash!);
        if (!identity) {
            logger.warn(
                `Dropping socket: device token for ${conn.ctx.user.username} was revoked`,
            );
            sendError(
                socket,
                "device token revoked; reconnect to re-authenticate",
            );
            socket.close();
            return;
        }
    }
    const turn = await sessions.runTurn({
        sessionId: prompt.sessionId,
        actor: conn.ctx,
        guestThreads: conn.guestThreads,
        stream: async (sessionId) =>
            streamEventsToSocket(
                socket,
                prompt.prompt,
                sessionId,
                options.turnTimeoutMs,
            ),
    });
    respondToTurn(socket, turn, prompt.sessionId);
}

/** Picks the user-facing error frame for a rejected turn outcome. */
function respondToTurn(
    socket: WebSocket,
    turn: TurnOutcome,
    sessionId: string,
): void {
    switch (turn) {
        case "busy":
            logger.warn(
                `Rejecting prompt: another request is already in progress for ${sessionId}`,
            );
            sendError(socket, "another request is already in progress");
            break;
        case "not-owned":
            logger.warn(
                `Rejecting prompt: session ${sessionId} belongs to another user`,
            );
            sendError(socket, "session belongs to another user");
            break;
        case "completed":
            break;
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
    store: AppDatabase,
    token: string,
): Promise<void> {
    if (conn.authed) {
        logger.warn("Rejecting auth: handshake must be the first frame");
        sendError(socket, "auth handshake must be the first frame");
        return;
    }
    conn.authed = true;
    const identity = store.resolveTokenHash(hashDeviceToken(token));
    if (!identity) {
        logger.warn("Rejecting auth: unknown device token");
        sendError(socket, "invalid device token");
        return;
    }
    conn.ctx = {
        kind: "authed",
        user: identity.user,
        device: identity.device,
    };
    conn.tokenHash = hashDeviceToken(token);
    store.touchDevice(identity.device.id);
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
 * The timeout error is emitted by the timer itself; the in-flight generator is
 * `return()`d shortly after, which drains when its current await settles.
 * Draining is **best-effort on a hung model**: `return()` cannot interrupt a
 * TCP-stalled model read, so while that read is stuck the generator never
 * settles, `runAgent` never returns, and the per-thread lock stays held. Real
 * cancellation (an AbortController threaded down to the model call) is a
 * follow-up; for every settling model the lock drains as soon as the read
 * resolves.
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

/**
 * Serializes and sends one server frame.
 *
 * Sending is silently skipped on a socket that is no longer open — the ws
 * library throws `WebSocket is not open` otherwise, which (from inside the
 * turn-timeout timer, for example) would become an uncaught exception and
 * crash the whole server. Frame delivery is best-effort by nature here.
 */
function sendFrame(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }
    socket.send(serializeFrame(frame));
}
