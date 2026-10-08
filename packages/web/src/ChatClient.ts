/**
 * Event-driven chat WebSocket client for the browser.
 *
 * Ports the CLI's `ChatClient` (`packages/cli/src/client.ts`) to an event
 * model a React app can consume: one persistent socket, the `hello` frame as
 * the very first message, the `auth` handshake right behind it, and
 * streaming prompt turns dispatched through {@link ChatClientEvents}. The
 * web client is signed-in-only, so a handshake failure or a mid-stream
 * revocation reports `onAuthRejected` (the app then drops back to the login
 * screen); unexpected drops reconnect automatically with capped backoff
 * (1s → 2s → … → 10s), re-running the full handshake each time.
 *
 * Frame parsing and serialization come from `@lukestanbery/jarvis-protocol`
 * — the single wire-protocol source of truth. One `onmessage` dispatcher
 * drives a small phase state machine (`handshake` → `ready`), so trailing
 * frames the server pairs with errors (the terminal `done` after an error
 * frame) are ignored rather than misread. A malformed server frame rejects
 * the in-flight prompt and is dropped — it never schedules a reconnect.
 *
 * The socket constructor is injectable so node tests can drive the client
 * with a fake; the token is a credential and is never logged.
 */
import {
    parseFrame,
    s16leToPcm,
    serializeAuth,
    serializeHello,
    serializeLocation,
    serializeRequest,
    type ChatMode,
    type ClientCapability,
    type ServerFrame,
} from "@lukestanbery/jarvis-protocol";

/** Connection lifecycle surfaced to the UI. */
export type ChatStatus = "connecting" | "connected" | "reconnecting" | "closed";

/** Callbacks invoked as the connection and turns progress. */
export interface ChatClientEvents {
    /** Connection-state changes (idempotent transitions). */
    onStatus?(status: ChatStatus): void;
    /** One parsed server frame of an in-flight prompt turn. */
    onFrame?(frame: ServerFrame): void;
    /**
     * One binary audio chunk of the in-flight turn's spoken response (#83):
     * little-endian s16le samples decoded to mono float PCM via the
     * protocol's `s16leToPcm`. The chunk's sample rate arrived on the
     * turn's `audioStart` frame (which flows through {@link onFrame}).
     */
    onAudio?(pcm: Float32Array): void;
    /** The credential is permanently unusable (invalid or revoked). */
    onAuthRejected?(): void;
}

/** Constructs the socket; injectable for node tests. */
export type WebSocketFactory = (url: string) => WebSocket;

/** The slice of a WebSocket message event that {@link ChatClient} consumes. */
interface WebSocketMessageEvent {
    /** Text for JSON frames; an ArrayBuffer for binary audio (#83). */
    readonly data: unknown;
}

/** Exact server wording for a mid-life token revocation. */
const REVOKED_MESSAGE = "device token revoked; reconnect to re-authenticate";

/** Backoff cap for reconnect attempts. */
const MAX_BACKOFF_MS = 10_000;

/** The DOM WebSocket's OPEN readyState (numeric to stay lib-agnostic). */
const WS_OPEN = 1;

/** Construction options for {@link ChatClient}. */
export interface ChatClientOptions {
    /** The device token — sent as the `auth` handshake. */
    token: string;
    /** Capabilities announced by the `hello` first frame. */
    capabilities: ClientCapability[];
    /** Event callbacks (all optional). */
    events: ChatClientEvents;
    /** Socket constructor override for tests. */
    socketFactory?: WebSocketFactory;
    /** How long to wait for the `authResult` verdict before retrying. */
    authTimeoutMs?: number;
}

/**
 * The browser chat socket: hello → auth → prompt streaming with
 * auto-reconnect and permanent-rejection handling.
 */
export class ChatClient {
    private socket: WebSocket | null = null;
    /** Machine state: idle (disconnected) → handshake → ready. */
    private phase: "idle" | "handshake" | "ready" = "idle";
    /** Set once the user (or a permanent rejection) ended the client. */
    private closedByUser = false;
    /** Set on invalid/revoked credentials — never reconnect after this. */
    private rejected = false;
    /** Whether a prompt turn is currently consuming frames. */
    private streaming = false;
    /**
     * Client-side TTFA measurement (#83 phase 6): when the turn was
     * submitted, when its `audioStart` arrived, and whether the first
     * binary chunk is still pending — so the first chunk logs "first
     * audible" deltas to the console. The web package has no logger;
     * `console.debug` keeps this invisible unless devtools are open.
     */
    private turnStartedAt: number | null = null;
    private audioSpanStartedAt: number | null = null;
    private awaitingFirstAudioChunk = false;
    /** Reconnect attempt counter (drives backoff; reset on connect). */
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    private resolvePrompt: (() => void) | null = null;
    private rejectPrompt: ((err: Error) => void) | null = null;
    /** Waiters parked until the socket becomes ready (or definitively fails). */
    private readyWaiters: Array<() => void> = [];
    /**
     * The device's latest reported location (#31), kept so each fresh
     * handshake (initial connect and every reconnect — the server's socket
     * state is per-connection) re-announces it for subsequent turns.
     */
    private location: { lat: number; lon: number } | null = null;
    /**
     * The socket the stored location was last announced on — the reconnect
     * path re-sends only when it differs from the live socket, so a report
     * that already rode along during the handshake is never duplicated.
     */
    private locationSentOn: WebSocket | null = null;

    constructor(
        private readonly url: string,
        private readonly options: ChatClientOptions,
    ) {}

    /**
     * Opens the socket and runs the hello+auth handshake (idempotent while
     * connecting or connected). Failed attempts reconnect with backoff;
     * invalid credentials end in {@link ChatClientEvents.onAuthRejected}.
     */
    connect(): void {
        if (this.closedByUser || this.rejected) {
            return;
        }
        if (this.socket && this.phase !== "idle") {
            return;
        }
        this.emitStatus(this.attempt === 0 ? "connecting" : "reconnecting");
        const factory = this.options.socketFactory ?? ((u) => new WebSocket(u));
        const socket = factory(this.url);
        // Binary messages carry the turn's spoken audio (#83); the JSON
        // frames stay text. Declaring arraybuffer makes every binary
        // delivery an ArrayBuffer, which onMessage branches on.
        socket.binaryType = "arraybuffer";
        this.socket = socket;
        this.phase = "handshake";
        socket.onopen = () => {
            // The very first frame must be `hello`; `auth` follows it.
            socket.send(serializeHello(this.options.capabilities));
            socket.send(serializeAuth(this.options.token));
            this.handshakeTimer = setTimeout(() => {
                if (this.phase !== "handshake") {
                    return;
                }
                // Let the close event own the state transition and the
                // reconnect — a single path, no double scheduling.
                socket.close();
            }, this.options.authTimeoutMs ?? 5_000);
        };
        socket.onmessage = (event) => this.onMessage(event);
        socket.onclose = () => this.onClose();
        // onerror is always followed by onclose; nothing to do here.
        socket.onerror = () => {};
    }

    /**
     * Sends one chat turn, waiting for the handshake to finish first if the
     * socket is still connecting or reconnecting.
     *
     * Resolves on the terminal `done` frame; rejects on an error frame (the
     * server's message), a dropped connection, a malformed server frame, or
     * when another prompt is already streaming. When the socket is already
     * ready the turn starts synchronously, so frames the server sends
     * immediately after the call are never missed. `mode` defaults to
     * `"text"` for typed prompts; voice-origin prompts pass `"voice"`
     * (#84) so the server answers in plain conversational text.
     * `attachments` carries attachment ids (#10) obtained from
     * `api.uploadAttachment` — sent on the wire frame when non-empty,
     * omitted entirely otherwise.
     */
    async prompt(
        text: string,
        sessionId: string,
        attachments: string[] = [],
        mode: ChatMode = "text",
    ): Promise<void> {
        if (this.closedByUser) {
            throw new Error("chat client is closed");
        }
        if (this.rejected) {
            throw new Error("authentication failed");
        }
        if (this.streaming) {
            throw new Error("another prompt is already in progress");
        }
        const ready = this.socket;
        if (this.phase === "ready" && ready && ready.readyState === WS_OPEN) {
            return this.startTurn(ready, text, sessionId, attachments, mode);
        }
        // Not ready yet: park until the handshake settles, then re-check.
        await this.whenReady();
        if (this.closedByUser) {
            throw new Error("chat client is closed");
        }
        if (this.rejected) {
            throw new Error("authentication failed");
        }
        const socket = this.socket;
        if (
            this.phase !== "ready" ||
            !socket ||
            socket.readyState !== WS_OPEN
        ) {
            throw new Error("chat client is not connected");
        }
        return this.startTurn(socket, text, sessionId, attachments, mode);
    }

    /**
     * Marks the turn in flight, stores the settle callbacks, and sends the
     * wire frame. Called with the socket already verified open.
     */
    private startTurn(
        socket: WebSocket,
        text: string,
        sessionId: string,
        attachments: string[],
        mode: ChatMode,
    ): Promise<void> {
        this.streaming = true;
        this.turnStartedAt = performance.now();
        this.audioSpanStartedAt = null;
        this.awaitingFirstAudioChunk = false;
        return new Promise<void>((resolve, reject) => {
            this.resolvePrompt = resolve;
            this.rejectPrompt = reject;
            socket.send(
                serializeRequest(text, sessionId, { mode, attachments }),
            );
        });
    }

    /** Whether a prompt turn is currently streaming. */
    isStreaming(): boolean {
        return this.streaming;
    }

    /**
     * Reports the device's location (#31): stores it and sends a `location`
     * frame when the socket is ready — or silently defers to the next
     * handshake otherwise (see {@link resendLocation}), so a report arriving
     * mid-reconnect is never lost. The caller passes already-rounded
     * coordinates (see `location.ts`); this method does no math and never
     * logs them.
     */
    sendLocation(lat: number, lon: number): void {
        this.location = { lat, lon };
        this.sendLocationFrame(lat, lon);
    }

    /**
     * Closes the client for good: cancels reconnects, fails any in-flight
     * prompt, and closes the socket. Safe to call repeatedly.
     */
    close(): void {
        this.closedByUser = true;
        this.clearTimers();
        this.failPrompt(new Error("chat client is closed"));
        const socket = this.socket;
        this.socket = null;
        this.phase = "idle";
        if (socket) {
            this.detach(socket);
            socket.close();
        }
        this.emitStatus("closed");
        this.flushWaiters();
    }

    /**
     * Single message dispatcher. Binary messages are spoken-audio chunks
     * (#83) — decoded and delivered via {@link ChatClientEvents.onAudio},
     * never parsed as frames. During the handshake only `authResult`
     * (success), `error` (bad token → permanent rejection), and ignorable
     * trailing frames are expected. Once ready, prompt frames stream to
     * {@link ChatClientEvents.onFrame} until `done`/`error`.
     */
    private onMessage(event: WebSocketMessageEvent): void {
        if (event.data instanceof ArrayBuffer) {
            if (this.awaitingFirstAudioChunk) {
                this.awaitingFirstAudioChunk = false;
                // First chunk of the span = first audible audio (#83 phase
                // 6). The headline "user stops speaking → first audible
                // JARVIS" reads here, measured from prompt submit and from
                // the `audioStart` frame.
                const now = performance.now();
                const sinceSubmit =
                    this.turnStartedAt === null
                        ? null
                        : Math.round(now - this.turnStartedAt);
                const sinceSpanStart =
                    this.audioSpanStartedAt === null
                        ? null
                        : Math.round(now - this.audioSpanStartedAt);
                console.debug(
                    `[voice] first audio ${sinceSubmit === null ? "?" : `+${sinceSubmit}ms`} since submit, ${sinceSpanStart === null ? "?" : `+${sinceSpanStart}ms`} since audioStart`,
                );
            }
            this.options.events.onAudio?.(
                s16leToPcm(new Uint8Array(event.data)),
            );
            return;
        }
        const raw = String(event.data);
        let frame: ServerFrame;
        try {
            frame = parseFrame(raw);
        } catch (err) {
            // Malformed server frame: fail the in-flight prompt (if any) and
            // drop the frame — never reconnect-spin against a broken server.
            this.failPrompt(
                new Error(
                    err instanceof Error
                        ? err.message
                        : "unparsable server frame",
                ),
            );
            return;
        }
        if (this.phase === "handshake") {
            if ("authResult" in frame) {
                this.clearHandshakeTimer();
                this.phase = "ready";
                this.attempt = 0;
                this.emitStatus("connected");
                this.resendLocation();
                this.flushWaiters();
            } else if ("error" in frame) {
                // A bad token answers `error` (plus a trailing `done` that
                // the phase guard ignores). Permanent: no reconnect.
                this.rejectPermanently();
            }
            return;
        }
        if (this.phase !== "ready") {
            return;
        }
        if ("done" in frame) {
            if (this.streaming) {
                this.streaming = false;
                const resolve = this.resolvePrompt;
                this.resolvePrompt = null;
                this.rejectPrompt = null;
                resolve?.();
            }
            return;
        }
        if ("error" in frame) {
            if (frame.error === REVOKED_MESSAGE) {
                this.rejectPermanently();
                return;
            }
            this.failPrompt(new Error(frame.error));
            return;
        }
        if (this.streaming) {
            if ("audioStart" in frame) {
                this.audioSpanStartedAt = performance.now();
                this.awaitingFirstAudioChunk = true;
            }
            this.options.events.onFrame?.(frame);
        }
    }

    /**
     * Handles an unexpected socket close: fails any in-flight prompt, then
     * either settles as closed (user-initiated or rejected) or schedules a
     * reconnect. The server closes cleanly after a revocation, so the close
     * handler relies on the `rejected` flag (not close codes) to avoid
     * reconnecting a dead credential.
     */
    private onClose(): void {
        this.clearHandshakeTimer();
        this.failPrompt(new Error("connection closed while streaming"));
        this.socket = null;
        this.phase = "idle";
        if (this.closedByUser || this.rejected) {
            this.emitStatus("closed");
            this.flushWaiters();
            return;
        }
        this.scheduleReconnect();
    }

    /** Marks the credential permanently unusable and settles the client. */
    private rejectPermanently(): void {
        this.rejected = true;
        this.clearTimers();
        this.failPrompt(new Error("authentication failed"));
        const socket = this.socket;
        this.socket = null;
        this.phase = "idle";
        if (socket) {
            this.detach(socket);
            socket.close();
        }
        this.emitStatus("closed");
        this.flushWaiters();
        this.options.events.onAuthRejected?.();
    }

    /** Rejects the in-flight prompt (a no-op when none is pending). */
    private failPrompt(err: Error): void {
        if (this.streaming) {
            this.streaming = false;
            const reject = this.rejectPrompt;
            this.resolvePrompt = null;
            this.rejectPrompt = null;
            reject?.(err);
        }
    }

    /** Sends a `location` frame on an open socket (no-op otherwise). */
    private sendLocationFrame(lat: number, lon: number): void {
        const socket = this.socket;
        if (socket && socket.readyState === WS_OPEN) {
            socket.send(serializeLocation(lat, lon));
            this.locationSentOn = socket;
        }
    }

    /** Re-announces the stored location after a fresh handshake (#31). */
    private resendLocation(): void {
        const socket = this.socket;
        if (
            this.location !== null &&
            socket &&
            this.locationSentOn !== socket
        ) {
            this.sendLocationFrame(this.location.lat, this.location.lon);
        }
    }

    /** Schedules the next connect attempt with exponential capped backoff. */
    private scheduleReconnect(): void {
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    /** Resolves once the socket is ready, or when it definitively failed. */
    private whenReady(): Promise<void> {
        if (this.phase === "ready") {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.readyWaiters.push(resolve);
        });
    }

    /** Releases every parked `whenReady` waiter (they re-check state). */
    private flushWaiters(): void {
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const waiter of waiters) {
            waiter();
        }
    }

    private clearHandshakeTimer(): void {
        if (this.handshakeTimer !== null) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
        }
    }

    private clearTimers(): void {
        this.clearHandshakeTimer();
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /** Detaches every listener so a dying socket cannot fire strays. */
    private detach(socket: WebSocket): void {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
    }

    private emitStatus(status: ChatStatus): void {
        this.options.events.onStatus?.(status);
    }
}
