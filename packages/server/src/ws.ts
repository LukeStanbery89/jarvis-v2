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
 * session's `kind` at first claim, and voice prompts are answered in
 * spoken-word prose — effective capabilities are empty (plain text) and the
 * system prompt gains the spoken-word directive so the reply is shaped for
 * text-to-speech (#83), regardless of the declared capabilities. Either
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
 * The connection lifecycle is hardened against the failure modes that would
 * otherwise take the process or leak its state: transport errors on the
 * `wss` and on every socket are logged, never unhandled (a single malformed
 * frame must not crash the server); a 30-second ping/pong heartbeat
 * terminates half-open peers (a client that vanished without a close frame)
 * so their guest-session cleanup still fires; and stream data (`chunk`
 * frames, binary PCM) respects a send-buffer bound so a slow client cannot
 * grow the send queue without bound — terminal and one-shot frames always
 * send. Inbound frames are logged by shape, never raw: a raw-frame log would
 * render `auth` device tokens and `location` coordinates verbatim.
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
    pcmToS16le,
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
import { speakTurn } from "./tts/orchestrator";
import type { TtsProvider } from "./tts/types";
import type { AttachmentStore } from "./attachments/store";
import { logger } from "./logger";

/** The identity every socket starts with and failed auth falls back to. */
const GUEST_CONTEXT: AuthContext = Object.freeze({ kind: "guest" });

/**
 * How often the keepalive pings each socket (see the heartbeat in
 * {@link attachChatServer}). A socket must answer a ping within one
 * interval or it is terminated as half-open.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The send-buffer bound for stream data (`chunk` frames and binary PCM).
 * Past it, non-terminal stream data is dropped instead of queued: a slow or
 * stalled client would otherwise grow ws's internal send queue without
 * bound — the only unbounded-memory path in the streaming pipeline.
 * Terminal frames (`done`/`error`/`audioEnd`) and one-shot frames
 * (`tool`/`toolResult`/`audioStart`) always send.
 */
const MAX_SEND_BUFFER_BYTES = 1_048_576;

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
    /** Monotonic per-socket turn counter — the audio `generationId` (#83). */
    turnCounter: number;
    /**
     * The in-flight turn's cancellation source (#84 P6): created when the
     * stream starts, aborted by a `cancel` frame, cleared when it settles.
     * `null` between turns.
     */
    active: AbortController | null;
    /**
     * Set by a `cancel` that arrived while the prompt was still queued on
     * the tail (not yet streaming); the stream consumes and honors it at
     * start. Never left set across turns — the stream clears it when it
     * runs, and socket events are macrotasks so a stale one cannot survive
     * a settled turn's cleanup.
     */
    cancelPending: boolean;
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
    /**
     * The server-side TTS engine (#83), present when a provider is
     * configured (`JARVIS_TTS_PROVIDER`). Voice-mode prompts from sockets
     * that declared the `audio` capability are then also synthesized and
     * delivered as an `audioStart` … binary PCM … `audioEnd` span inside the
     * turn. Absent → the socket never sees audio frames.
     */
    tts?: TtsProvider;
    /**
     * Segmenter granularity for spoken turns (#89, `JARVIS_TTS_SEGMENT`):
     * `"sentence"` (default) or `"clause"`. Meaningful only with `tts`.
     */
    ttsSegment?: "sentence" | "clause";
    /**
     * How often each socket is pinged for keepalive (default
     * {@link HEARTBEAT_INTERVAL_MS}); a socket that does not answer within
     * one interval is terminated as half-open. Injectable so tests can use
     * a short interval instead of fake timers.
     */
    heartbeatIntervalMs?: number;
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

    // The ws library re-emits transport/receiver failures (a malformed
    // frame, invalid UTF-8, an oversize message, a write error during a
    // teardown race) as `'error'` on the WebSocketServer; with no listener
    // that becomes an uncaught exception and kills the whole process — a
    // single malformed frame from any LAN peer would be a remote crash. Log
    // and keep serving.
    wss.on("error", (err) => {
        logger.warn(`WebSocket server error: ${err.message}`);
    });

    wss.on("connection", (socket) => {
        logger.info("New WebSocket connection");
        // Same footgun one level down: per-connection errors are re-emitted
        // on the socket itself. Registered first, before any other listener
        // or await, so there is no window where an error can land unhandled.
        socket.on("error", (err) => {
            logger.warn(`WebSocket error: ${err.message}`);
        });
        // Half-open sockets (a client that vanished without a close frame —
        // mobile drop, laptop sleep, NAT expiry) never fire `close`, so
        // their connection state and guest session rows would leak forever.
        // The standard ws heartbeat: every interval, terminate when the
        // previous ping went unanswered, otherwise mark-alive-cleared and
        // ping. A client that answers keeps its `alive` flag true.
        let alive = true;
        socket.on("pong", () => {
            alive = true;
        });
        const heartbeat = setInterval(() => {
            if (!alive) {
                logger.info(
                    "WebSocket connection timed out (no pong); terminating",
                );
                socket.terminate();
                return;
            }
            alive = false;
            socket.ping();
        }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
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
            turnCounter: 0,
            active: null,
            cancelPending: false,
        };

        socket.on("message", (raw) => {
            const frameText = raw.toString();
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
            // Log the shape, not the bytes: a raw-frame log renders `auth`
            // device tokens (and `location` coordinates) verbatim in
            // development — credentials the repo promises never to log.
            // Prompts are the designed sensitive payload and keep their
            // `sensitive` line (redacted in production); every typed frame
            // is logged by type only.
            if ("type" in frame) {
                logger.debug(`Received ${frame.type} frame`);
            } else {
                logger.sensitive("Received prompt", frame.prompt);
            }
            // A `cancel` (#84 P6) must never queue behind the turn it is
            // cancelling — the tail chains on every step's completion, so a
            // cancel that joined it would only run after the turn was over.
            // It aborts the in-flight turn synchronously instead: the
            // stream's loop checks the signal, the model calls reject
            // (AbortSignal threaded to `graph.stream`), and the turn ends
            // with `done`. With no turn running but one still queued on the
            // tail, a pending flag makes the stream abort at start; with
            // neither, the cancel is ignored (idempotent).
            if ("type" in frame && frame.type === "cancel") {
                if (conn.active !== null) {
                    logger.info("Cancelling in-flight turn");
                    conn.active.abort();
                } else if (activePrompt !== null) {
                    logger.info("Cancel queued: turn not started yet");
                    conn.cancelPending = true;
                }
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
            clearInterval(heartbeat);
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
 *
 * A `cancel` frame (#84 P6) never reaches here — the connection's message
 * handler intercepts it before the tail so it aborts synchronously; this
 * branch only keeps the dispatcher total.
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
        } else if (frame.type === "cancel") {
            // Unreachable via the message handler (intercepted before the
            // tail); a no-op keeps the dispatch total.
            logger.warn("Cancel frame reached the tail (ignored)");
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
 * capabilities plus the agent's spoken-word directive (#83), so the model
 * answers in plain conversational text shaped for text-to-speech regardless
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
        stream: async (sessionId) => {
            // The turn's cancellation source (#84 P6): a `cancel` frame
            // aborts it while streaming; a `cancel` that arrived while this
            // prompt was queued aborts it at start (and is consumed — the
            // flag must never leak into the next turn). Cleared in the
            // finally so the connection is registry-clean when the
            // per-thread lock releases.
            const controller = new AbortController();
            conn.active = controller;
            try {
                if (conn.cancelPending) {
                    conn.cancelPending = false;
                    controller.abort();
                }
                await streamEventsToSocket(
                    socket,
                    prompt.prompt,
                    sessionId,
                    options.turnTimeoutMs,
                    conn.capabilities,
                    mode,
                    attachmentIds,
                    conn.ctx.kind === "authed" ? conn.ctx.user.id : undefined,
                    conn.location,
                    options.tts,
                    options.ttsSegment,
                    controller.signal,
                    ++conn.turnCounter,
                );
            } finally {
                if (conn.active === controller) {
                    conn.active = null;
                }
            }
        },
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
 * except under `mode: "voice"`, where the effective capabilities are empty
 * (plain text) and the system prompt gains the spoken-word directive (#83),
 * so the model answers in conversational prose shaped for text-to-speech
 * (rich formatting is text-mode-only). The prompt's chat `mode` rides along
 * so the agent can apply that directive. The device's latest reported
 * location (#31) rides along
 * for location-aware tools; a guest turn carries no `userId`, so metered
 * tools refuse guests regardless of any location.
 *
 * The turn's `token` events are assembled as they stream, so two things can be
 * done once the stream ends: the whole response is logged in one
 * `logger.sensitive` event (visible verbatim in development), and a turn that
 * produced **no prose at all** — whitespace-only chunks included — is reported
 * as `the model returned an empty response` instead of a bare `done`. That
 * empty-answer case is a real model failure, not a client bug: a reasoning
 * model that spends its whole output budget thinking returns an `AIMessage`
 * with empty `content`, which the tracker correctly turns into zero tokens, and
 * the client would otherwise render a permanently blank bubble with no
 * explanation.
 *
 * When a TTS engine is configured and the turn is eligible — a **voice-mode
 * prompt from a socket that declared the `audio` capability** (#83) — the
 * token stream also feeds the segmenter → synthesis pipeline: `audioStart`,
 * binary PCM messages, and `audioEnd` go out as segments finish, all inside
 * the turn (before `done`), so the per-thread lock covers speaking too. A
 * synthesis failure aborts the turn's audio only — the text stream and the
 * `done` are unaffected (audio is a presentation layer; the `audioError`
 * frame is a later #83 phase).
 *
 * The timeout error is emitted by the timer itself; the in-flight generator is
 * also `return()`d, which drains when its current await settles. A `cancel`
 * frame (#84 P6) aborts the turn's {@link AbortSignal} instead: the signal
 * rides into `graph.stream`, so the model's in-flight (even TCP-stalled)
 * calls reject for real, the stream loop notices, the spoken audio is
 * dropped, and the turn ends with a bare `done` — text already streamed
 * stays in history, and no error frame is sent. Draining remains
 * **best-effort on a hung model** that ignores the signal: `return()` cannot
 * interrupt a TCP-stalled read that never resolves, so while that read is
 * stuck the generator never settles and the per-thread lock stays held; for
 * every signal-honoring model the lock drains the moment the abort lands.
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
    tts: TtsProvider | undefined,
    ttsSegment: "sentence" | "clause" | undefined,
    signal: AbortSignal,
    generationId: number,
): Promise<void> {
    const turnStartedAt = Date.now();
    let finished = false;
    let generator: AsyncGenerator<AgentEvent> | null = null;
    // The turn's assembled answer and tool-call count, kept so the response
    // can be logged once as a whole (rather than only as per-token debug
    // lines) and so a turn that produced no prose at all is detectable.
    let responseText = "";
    let toolCallCount = 0;
    // Time-to-first-audio decomposition (#83 phase 6, #89): first LLM
    // token, first queued segment, first PCM delivered — deltas against
    // the turn's start, logged once when the stream completes.
    let firstTokenAt: number | null = null;
    let firstSegmentAt: number | null = null;
    let firstAudioSentAt: number | null = null;
    // The turn's spoken-audio pipeline, created only when TTS is configured
    // and the turn is eligible (voice mode + audio-capable socket, #83).
    const speaking =
        mode === "voice" && capabilities.includes("audio") && tts !== undefined
            ? speakTurn(
                  tts,
                  {
                      audioStart: (sampleRate) => {
                          sendFrame(socket, {
                              audioStart: {
                                  generationId,
                                  format: "pcm_s16le",
                                  sampleRate,
                                  channels: 1,
                              },
                          });
                      },
                      audio: (pcm) => {
                          firstAudioSentAt ??= Date.now();
                          if (socket.readyState === WebSocket.OPEN) {
                              // A cancel during the drain must stop the
                              // audio at the wire too: a synthesis that
                              // resolved just after the abort (the engine
                              // has no abort hook) is a straggler — dropped
                              // here rather than delivered. Past the
                              // send-buffer bound, dropping also bounds the
                              // queue (a gap in the audio is the honest cost
                              // of a client that cannot keep up; the span
                              // still closes with `audioEnd`).
                              if (
                                  signal.aborted ||
                                  socket.bufferedAmount > MAX_SEND_BUFFER_BYTES
                              ) {
                                  if (!signal.aborted) {
                                      noteDroppedStreamData(
                                          socket,
                                          "audio segment(s)",
                                      );
                                  }
                                  return;
                              }
                              socket.send(pcmToS16le(pcm), { binary: true });
                          }
                      },
                      audioEnd: () => {
                          sendFrame(socket, { audioEnd: { generationId } });
                      },
                  },
                  (err) => {
                      logger.error(
                          `TTS failed (turn ${generationId}): ${err instanceof Error ? err.message : String(err)}`,
                      );
                  },
                  {
                      granularity: ttsSegment ?? "sentence",
                      onFirstSegment: () => {
                          firstSegmentAt = Date.now();
                      },
                  },
              )
            : null;
    const finishWithError = (message: string) => {
        if (finished) {
            return;
        }
        finished = true;
        speaking?.abort();
        sendError(socket, message);
    };
    // The `cancel` (#84 P6) epilogue: unlike a failure this is not an error
    // — the text streamed so far stands (history keeps it), the audio drops
    // (a presentation layer), and a bare terminal `done` closes the turn so
    // the client's await settles and the thread lock releases.
    const finishCancelled = () => {
        if (finished) {
            return;
        }
        finished = true;
        speaking?.abort();
        logger.info(`Turn ${generationId} cancelled by client`);
        sendFrame(socket, { done: true });
    };
    const timer = setTimeout(() => {
        logger.warn(`Turn exceeded ${turnTimeoutMs}ms; aborting`);
        finishWithError(`turn timed out after ${turnTimeoutMs}ms`);
        void generator?.return?.(undefined);
    }, turnTimeoutMs);
    try {
        generator = runAgent(prompt, sessionId, {
            capabilities: mode === "voice" ? [] : capabilities,
            mode,
            attachmentIds,
            userId,
            location,
            signal,
        });
        try {
            for await (const event of generator) {
                if (signal.aborted) {
                    finishCancelled();
                    return;
                }
                if (finished || socket.readyState !== WebSocket.OPEN) {
                    speaking?.abort();
                    return;
                }
                logAgentEvent(event);
                if (event.type === "token") {
                    firstTokenAt ??= Date.now();
                    responseText += event.text;
                    speaking?.push(event.text);
                } else if (event.type === "tool") {
                    toolCallCount += 1;
                }
                sendFrame(socket, toServerFrame(event));
            }
        } catch (err) {
            if (signal.aborted) {
                // The model rejected the abort mid-read — the cancellation
                // path, not a failure (the error frame must never fire for
                // a deliberate cancel).
                finishCancelled();
                return;
            }
            logger.error(
                `LLM stream failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            finishWithError("model request failed");
            return;
        }
        if (finished) {
            return;
        }
        if (signal.aborted) {
            finishCancelled();
            return;
        }
        logger.debug("Agent stream complete");
        if (speaking !== null) {
            // TTFA decomposition (#83 phase 6): the headline number the
            // client measures is "user stops speaking → first audible
            // JARVIS"; these are the server-side components of it.
            const elapsed = (at: number | null) =>
                at === null ? "—" : `+${at - turnStartedAt}ms`;
            logger.debug(
                `voice turn ${generationId} TTFA: first token ${elapsed(firstTokenAt)}, first segment ${elapsed(firstSegmentAt)}, first audio sent ${elapsed(firstAudioSentAt)}`,
            );
        }
        logger.sensitive("Agent response", {
            text: responseText,
            toolCalls: toolCallCount,
        });
        if (responseText.trim() === "") {
            logger.warn(
                `Agent produced no response text after ${toolCallCount} tool call(s); reporting an empty response`,
            );
            finishWithError("the model returned an empty response");
            return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        // Speak everything the text stream left buffered before closing the
        // turn: `audioEnd` then `done`, with the per-thread lock still held.
        // The drain runs under the turn's signal: a `cancel` that arrives
        // while the tail is still synthesizing must drop the remaining
        // audio (the cancelled path below), not finish speaking a response
        // the client just interrupted.
        if (speaking !== null) {
            const drained = await Promise.race([
                speaking.finish().then(() => true as const),
                aborted(signal).then(() => false as const),
            ]);
            if (!drained) {
                finishCancelled();
                return;
            }
            if (socket.readyState !== WebSocket.OPEN) {
                return;
            }
            // A failure landed while the tail drained (the turn timeout, a
            // closed socket's error path): it already sent the terminal
            // frames — do not send a second `done` behind it.
            if (finished) {
                return;
            }
        }
        if (signal.aborted) {
            // A cancel that arrived during the audio drain: one `done` from
            // the cancelled path, never a second terminal frame.
            finishCancelled();
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

/**
 * Resolves when `signal` aborts — immediately if it is already aborted.
 * Used to race a long-running await (the audio drain) against a `cancel`.
 */
function aborted(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

/**
 * Stream-data drop counters per socket, so slow-client drops can be logged
 * without a line per dropped frame: the first drop announces the condition,
 * then every 100th reports the running total.
 */
const droppedStreamData = new WeakMap<WebSocket, number>();

/**
 * Records one dropped piece of stream data (a `chunk` frame or a binary PCM
 * message) against the socket, logging the condition coarsely.
 *
 * @param socket - The socket whose send buffer is over the bound.
 * @param what - What was dropped, for the log line.
 */
function noteDroppedStreamData(socket: WebSocket, what: string): void {
    const count = (droppedStreamData.get(socket) ?? 0) + 1;
    droppedStreamData.set(socket, count);
    if (count === 1 || count % 100 === 0) {
        logger.warn(
            `Send buffer exceeded ${MAX_SEND_BUFFER_BYTES} bytes; dropped ${count} × ${what} to a slow client`,
        );
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
 *
 * A plain `chunk` frame additionally respects the send-buffer bound
 * ({@link MAX_SEND_BUFFER_BYTES}): once the client's queue passes it,
 * further chunk frames are dropped (counted, logged coarsely) instead of
 * queued — bounding the only unbounded-memory path in the pipeline. One-shot
 * and terminal frames always send, so every turn still ends coherently.
 */
function sendFrame(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }
    if ("chunk" in frame && socket.bufferedAmount > MAX_SEND_BUFFER_BYTES) {
        noteDroppedStreamData(socket, "chunk frame(s)");
        return;
    }
    socket.send(serializeFrame(frame));
}
