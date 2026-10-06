/**
 * WebSocket chat endpoint.
 *
 * Mounted on the `"/ws"` path of the HTTP server. The client's **first frame**
 * may authenticate with a device token (`{ type: "auth", token }`), announce
 * what it can render (`{ type: "hello", capabilities }`), or prompt. Auth
 * binds the socket to an account and the server replies with one `authResult`
 * frame; `hello` declares render capabilities for the socket's lifetime and
 * conditions the agent's system prompt. Prompts may declare a chat `mode`
 * ("text" | "voice", defaulting to "text"): the mode is recorded as the
 * session's `kind` at first claim, and voice prompts are answered in plain
 * conversational text regardless of the declared capabilities. Either
 * handshake comes first (both,
 * at most once each, before any prompt) or not at all — any other opening,
 * or no auth, runs the socket as a **guest** (ephemeral,
 * identity-independent chats). At any point in the socket's lifetime a client
 * may send a `location` device report (#31) — kept in memory, refreshable,
 * and forwarded to location-aware tools on subsequent turns. Afterwards
 * clients send JSON prompt frames and
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
import { WebSocket, WebSocketServer } from "ws";
import {
    parseClientMessage,
    serializeFrame,
    type ChatMode,
    type ClientCapability,
    type ClientFrame,
} from "@lukestanbery/jarvis-protocol";
import type {
    ClientHello,
    ClientLocationFrame,
    ServerFrame,
} from "@lukestanbery/jarvis-protocol";
import { hashDeviceToken } from "@lukestanbery/jarvis-auth";
import type { AppDatabase, AuthContext } from "@lukestanbery/jarvis-auth";
import { DEFAULT_TURN_TIMEOUT_MS } from "./config";
import { createSessionManager } from "./sessionManager";
import type { SessionManager, TurnOutcome } from "./sessionManager";
import { runAgent } from "./agent";
import type { AgentEvent, DeviceLocation } from "./agent";
import { toServerFrame } from "./transport";
import type { AttachmentStore } from "./attachments/store";
import { logger } from "./logger";

/** The identity every socket starts with and failed auth falls back to. */
const GUEST_CONTEXT: AuthContext = Object.freeze({ kind: "guest" });

/** Per-connection auth + guest-ledger state. */
interface ConnectionState {
    /** Whether the socket's opening slot has been consumed (hello/auth/prompt). */
    firstSeen: boolean;
    /** Whether an `auth` handshake was attempted (successful or not). */
    authed: boolean;
    /** Whether any prompt was handled (locks the socket as a guest). */
    promptSeen: boolean;
    /** Render capabilities declared by a `hello` frame (empty for plain text). */
    capabilities: ClientCapability[];
    /**
     * The device's latest reported location (#31), from `location` frames.
     * Memory-only for the socket's lifetime — never persisted; refreshable
     * (the latest frame wins for subsequent turns).
     */
    location?: DeviceLocation;
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
    /**
     * The process-wide attachment store (#10), present when the attachment
     * surface is wired. Prompts referencing attachments are rejected when it
     * is absent — a server without the surface has no ids to resolve.
     */
    attachments?: AttachmentStore;
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
        // A promise chain serializing every frame, so a pipelined `hello` →
        // `auth` (or `auth` → prompt before `authResult` is read) still lands in
        // order. `activePrompt` is the streaming-guard half: one prompt streams
        // at a time per socket, and a second arriving prompt is rejected.
        let tail: Promise<void> = Promise.resolve();
        let activePrompt: Promise<void> | null = null;
        const conn: ConnectionState = {
            firstSeen: false,
            authed: false,
            promptSeen: false,
            capabilities: [],
            ctx: GUEST_CONTEXT,
            guestThreads: new Set(),
        };

        socket.on("message", (raw) => {
            const frameText = raw.toString();
            logger.sensitive("Received message from WebSocket", frameText);
            let frame: ClientFrame;
            try {
                frame = parseClientMessage(frameText);
            } catch (err) {
                const detail =
                    err instanceof Error ? err.message : "unknown error";
                logger.error(`Failed to parse WebSocket message: ${detail}`);
                sendError(socket, detail);
                return;
            }
            const isHandshake = "type" in frame;
            // Only prompts contend for the stream: a second prompt while one is
            // streaming is rejected. Handshake frames are never denied here —
            // the opening-slot rules in handleHello/handleAuth own their
            // ordering — and just join the tail so a prompt can never race an
            // auth resolution.
            if (!isHandshake && activePrompt) {
                logger.warn(
                    "Rejecting prompt: another request is already in progress",
                );
                sendError(socket, "another request is already in progress");
                return;
            }
            const step = handleFrame(
                socket,
                conn,
                store,
                sessions,
                frame,
                options,
            ).catch((err) => {
                // handleFrame answers expected failures with error frames;
                // anything escaping it (a store error, an unexpected throw)
                // must still surface to the client rather than hang it.
                logger.error(
                    `Unhandled error handling message: ${err instanceof Error ? err.message : String(err)}`,
                );
                sendError(socket, "internal server error");
            });
            tail = tail.then(() => step);
            if (!isHandshake) {
                activePrompt = step;
                void step.finally(() => {
                    if (activePrompt === step) {
                        activePrompt = null;
                    }
                });
            }
        });

        socket.on("close", () => {
            sessions.cleanupGuests(conn.guestThreads);
            logger.info("WebSocket connection closed");
        });
    });

    return wss;
}

/**
 * Handles one already-parsed frame.
 *
 * An `auth` frame resolves the socket's identity, a `hello` frame records the
 * socket's render capabilities (both only valid in the opening slot), a
 * `location` frame updates the device's whereabouts (any time, refreshable),
 * and a prompt claims its session and streams the agent's events over the
 * socket. Returns a promise that settles when the response is fully streamed
 * (or the frame was rejected).
 */
async function handleFrame(
    socket: WebSocket,
    conn: ConnectionState,
    store: AppDatabase,
    sessions: SessionManager,
    frame: ClientFrame,
    options: AttachmentOptions,
): Promise<void> {
    if ("type" in frame) {
        if (frame.type === "hello") {
            await handleHello(socket, conn, frame);
        } else if (frame.type === "location") {
            handleLocation(conn, frame);
        } else {
            await handleAuth(socket, conn, store, frame.token);
        }
        return;
    }
    await handlePrompt(socket, conn, store, sessions, frame, options);
}

/**
 * Records a `location` device report (#31).
 *
 * Updates the socket's memory-only location for subsequent turns; the latest
 * report wins, so a client may refresh mid-conversation (it traveled, or
 * granted permission late). No reply frame — the update is silent by design.
 * Logged at INFO (a significant consent event the operator needs to see
 * during setup) but WITHOUT coordinates: the optional label name only,
 * because a location is sensitive user data.
 */
function handleLocation(
    conn: ConnectionState,
    frame: ClientLocationFrame,
): void {
    conn.location = {
        lat: frame.lat,
        lon: frame.lon,
        ...(frame.label !== undefined ? { label: frame.label } : {}),
    };
    logger.info(
        `Socket reported device location${frame.label ? ` (${frame.label})` : ""}`,
    );
}

/**
 * Runs one guest/owned prompt turn.
 *
 * The socket degrades to guest on its first prompt if it never authed. The
 * prompt's `sessionId` goes through the {@link SessionManager} pipeline —
 * lock, claim in the ledger (with the prompt's chat `mode` recorded as the
 * session's write-once `kind`), ownership guard, stream under `turnTimeoutMs`,
 * touch, release — which answers `busy`/`not-owned` where ws.ts only needs to
 * pick the error frame. Voice-mode prompts stream with empty effective
 * capabilities so the model answers in plain conversational text regardless
 * of the socket's `hello` declaration. Guest sockets track the sessions they
 * created so the socket-close handler can remove the ephemeral rows; owned
 * sessions persist.
 */
async function handlePrompt(
    socket: WebSocket,
    conn: ConnectionState,
    store: AppDatabase,
    sessions: SessionManager,
    prompt: Extract<ClientFrame, { prompt: string }>,
    options: AttachmentOptions,
): Promise<void> {
    if (!conn.firstSeen) {
        conn.firstSeen = true;
        conn.ctx = GUEST_CONTEXT;
    }
    // A signal of the socket's first prompt. Set unconditionally — a socket
    // that opened with `hello` is still locked to guest if it never authed,
    // so a late `auth` can never re-parent it mid-life.
    conn.promptSeen = true;
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
    const mode: ChatMode = prompt.mode ?? "text";
    const attachmentIds = prompt.attachments ?? [];
    if (attachmentIds.length > 0) {
        // Image analysis requires authentication: a guest would otherwise get
        // an unbounded meter on the vision model (the decisions table pins
        // this). Answered BEFORE the session claim so a guest's failed
        // attachment prompt never creates a ledger row (R9).
        if (!options.attachments) {
            sendError(socket, "image analysis is not available on this server");
            return;
        }
        if (conn.ctx.kind !== "authed") {
            sendError(socket, "image analysis requires signing in");
            return;
        }
        // Fail fast on unknown/expired/foreign ids — before the turn claims
        // the thread, so the client sees the error immediately instead of as
        // a tool result mid-stream (R9).
        for (const id of new Set(attachmentIds)) {
            try {
                options.attachments.assertAccessible(conn.ctx.user.id, id);
            } catch (err) {
                sendError(
                    socket,
                    err instanceof Error
                        ? err.message
                        : "attachment unavailable",
                );
                return;
            }
        }
    }
    const turn = await sessions.runTurn({
        sessionId: prompt.sessionId,
        actor: conn.ctx,
        guestThreads: conn.guestThreads,
        mode,
        stream: async (sessionId) =>
            streamEventsToSocket(
                socket,
                prompt.prompt,
                sessionId,
                options.turnTimeoutMs,
                conn.capabilities,
                mode,
                attachmentIds,
                conn.ctx.kind === "authed" ? conn.ctx.user.id : undefined,
                conn.location,
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
 * Records a `hello` capability-announcement frame.
 *
 * Only valid as the socket's opening frame (the `auth` handshake may open the
 * socket *or* immediately follow it — never the other way around), and exactly
 * once. Stores the declared capabilities for the socket's lifetime; each
 * subsequent prompt runs the agent with them so the output can be shaped for
 * what this client can render. A late `hello` is answered with an error frame.
 */
async function handleHello(
    socket: WebSocket,
    conn: ConnectionState,
    hello: ClientHello,
): Promise<void> {
    if (conn.firstSeen) {
        logger.warn("Rejecting hello: handshake must be the first frame");
        sendError(socket, "hello frame must be the first frame");
        return;
    }
    conn.firstSeen = true;
    conn.capabilities = hello.capabilities;
    logger.info(
        `Socket announced capabilities: ${
            hello.capabilities.length > 0
                ? hello.capabilities.join(", ")
                : "plain text only"
        }`,
    );
}

/**
 * Resolves an `auth` handshake frame.
 *
 * Only valid before any prompt and at most once (whether it opened the socket
 * or followed a `hello`); a valid token binds the socket to its account (one
 * `authResult` frame), an unknown token gets an error frame and the socket
 * continues as a guest. Either way the slot is consumed — a client only gets
 * one chance to authenticate.
 */
async function handleAuth(
    socket: WebSocket,
    conn: ConnectionState,
    store: AppDatabase,
    token: string,
): Promise<void> {
    if (conn.authed || conn.promptSeen) {
        logger.warn("Rejecting auth: handshake must be the first frame");
        sendError(socket, "auth handshake must be the first frame");
        return;
    }
    conn.authed = true;
    conn.firstSeen = true;
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
 * the socket closes mid-stream, or the turn exceeds `turnTimeoutMs`. The
 * socket's declared render capabilities (from a `hello` frame) are forwarded
 * to the agent so it can shape output for what this client can render —
 * except under `mode: "voice"`, where the effective capabilities are empty so
 * the model answers in plain conversational text (rich formatting is
 * text-mode-only). The device's latest reported location (#31) rides along
 * for location-aware tools; a guest turn carries no `userId`, so metered
 * tools refuse guests regardless of any location.
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
    capabilities: ClientCapability[],
    mode: ChatMode,
    attachmentIds: string[],
    userId: number | undefined,
    location: DeviceLocation | undefined,
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
        generator = runAgent(prompt, sessionId, {
            capabilities: mode === "voice" ? [] : capabilities,
            attachmentIds,
            userId,
            location,
        });
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
