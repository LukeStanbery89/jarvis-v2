/**
 * WebSocket chat client for the J.A.R.V.I.S. server.
 *
 * Connects lazily on the first `prompt()` call and reconnects automatically
 * if the connection drops. When constructed with a stored device `token`, the
 * socket authenticates on connect: `{ "type": "auth", token }` is sent as the
 * socket's **first frame** and the client waits for the server's `authResult`
 * verdict before the socket is usable. A rejected token falls back to a guest
 * socket (the server drops the auth attempt and continues), and a `revoked`
 * token mid-prompt is surfaced the same way — in both cases `onAuthRejected`
 * tells the caller to clear the stored credential. Each prompt carries the
 * conversation's `sessionId` so the server continues the same thread. Uses
 * Node's built-in `WebSocket`, so this module adds no third-party runtime
 * dependency.
 *
 * Frame parsing and serialization come from `@lukestanbery/jarvis-protocol`, the single
 * source of truth for the wire protocol; this module only maps parsed frames
 * onto the `PromptHandlers` callbacks. The token is a credential and is never
 * logged — diagnostics name only the confirmed user and device.
 */
import {
    parseFrame,
    serializeAuth,
    serializeRequest,
} from "@lukestanbery/jarvis-protocol";
import { logger } from "./logger";

/** How long a connect waits for the server's auth verdict before assuming guest. */
export const AUTH_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Why an auth attempt failed and the stored credential should be cleared.
 *
 * `"invalid"` is a connect-time rejection (bad or expired token); `"revoked"`
 * is a live socket the server cut off mid-conversation.
 */
export type AuthRejection = "invalid" | "revoked";

/** Identity confirmed by the server's `authResult` handshake frame. */
export interface AuthIdentity {
    /** The authenticated user's username. */
    user: string;
    /** The name of the device the token was issued to. */
    device: string;
}

/** How one auth handshake attempt ended. */
type HandshakeOutcome = "authenticated" | "invalid" | "timeout";

/** Callbacks invoked as events arrive during a `prompt()` exchange. */
export interface PromptHandlers {
    /** Called for each streamed text chunk of the answer. */
    onChunk: (chunk: string) => void;
    /** Called when the agent starts a tool call. */
    onTool?: (name: string, args: unknown) => void;
    /** Called when a tool finishes and returns its output. */
    onToolResult?: (name: string, output: unknown) => void;
}

/**
 * WebSocket chat client for the J.A.R.V.I.S. server.
 *
 * Connects lazily on the first `prompt()` call and reconnects automatically
 * if the connection drops. With an auth token present, the connection
 * authenticates on its first frame and waits for the verdict before accepting
 * prompts; rejected credentials fall back to a guest socket and report the
 * rejection through {@link AuthRejection}. Each prompt carries the
 * conversation's `sessionId` so the server continues the same thread. Uses
 * Node's built-in `WebSocket`, so this module adds no third-party runtime
 * dependency.
 */
export class ChatClient {
    private socket: WebSocket | null = null;
    private active = false;
    /** In-memory copy of the auth token; cleared once a rejection is observed. */
    private token?: string;
    /** Identity confirmed by the current socket's handshake. */
    private identity: AuthIdentity | null = null;

    constructor(
        private readonly url: string,
        authToken?: string,
        private readonly onAuthRejected?: (reason: AuthRejection) => void,
        private readonly authTimeoutMs: number = AUTH_HANDSHAKE_TIMEOUT_MS,
    ) {
        this.token = authToken;
    }

    /**
     * Returns the identity confirmed by the current socket's auth handshake.
     *
     * `null` for an unconnected or guest socket. A handshake timed out without
     * a verdict also leaves it `null` (the socket runs as a guest).
     */
    getIdentity(): AuthIdentity | null {
        return this.identity;
    }

    /**
     * Sends `text` for conversation `sessionId` and drives the `handlers`
     * callbacks with the server's events until `done`.
     *
     * Rejects with an `Error` if the server reports an error frame, the
     * connection fails, or another prompt is already streaming on this socket.
     */
    async prompt(
        text: string,
        sessionId: string,
        handlers: PromptHandlers,
    ): Promise<void> {
        if (this.active) {
            throw new Error("another prompt is already in progress");
        }
        this.active = true;
        try {
            const socket = await this.ensureConnected();
            socket.send(serializeRequest(text, sessionId));

            await new Promise<void>((resolve, reject) => {
                const teardown = (): void => {
                    socket.onmessage = null;
                    socket.onerror = null;
                    socket.onclose = null;
                };
                socket.onmessage = (event: MessageEvent): void => {
                    const frame = parseFrame(String(event.data));
                    if ("chunk" in frame) {
                        handlers.onChunk(frame.chunk);
                    } else if ("tool" in frame) {
                        handlers.onTool?.(frame.tool.name, frame.tool.args);
                    } else if ("toolResult" in frame) {
                        handlers.onToolResult?.(
                            frame.toolResult.name,
                            frame.toolResult.output,
                        );
                    } else if ("error" in frame) {
                        teardown();
                        if (
                            frame.error ===
                            "device token revoked; reconnect to re-authenticate"
                        ) {
                            this.token = undefined;
                            this.onAuthRejected?.("revoked");
                        }
                        reject(new Error(frame.error));
                    } else if ("done" in frame) {
                        teardown();
                        resolve();
                    } else if ("authResult" in frame) {
                        teardown();
                        reject(
                            new Error("unexpected authResult during a prompt"),
                        );
                    } else {
                        teardown();
                        reject(new Error("unexpected frame from the server"));
                    }
                };
                socket.onerror = (): void => {
                    teardown();
                    reject(new Error("connection error"));
                };
                socket.onclose = (): void => {
                    teardown();
                    reject(new Error("connection closed while streaming"));
                };
            });
        } finally {
            this.active = false;
        }
    }

    /** Closes the connection if one is currently open. */
    close(): void {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.close();
        }
    }

    /**
     * Returns whether a prompt is currently streaming on this client.
     *
     * The REPL uses this to refuse `login`/`logout` mid-response instead of
     * reporting a confusing failure from inside `prompt()`.
     */
    isBusy(): boolean {
        return this.active;
    }

    /** Returns the open socket, connecting (and authenticating) first if needed. */
    private async ensureConnected(): Promise<WebSocket> {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return this.socket;
        }

        const socket = new WebSocket(this.url);
        await new Promise<void>((resolve, reject) => {
            socket.onopen = (): void => resolve();
            socket.onerror = (): void =>
                reject(new Error(`could not connect to ${this.url}`));
        });

        // A fresh connection starts unauthenticated; an authResult may
        // re-establish identity below.
        this.identity = null;
        // Only handshake when a token is still held: a rejection clears the
        // in-memory token, so a reconnect after one goes straight to guest.
        if (this.token) {
            const outcome = await this.handshake(socket);
            if (outcome === "authenticated") {
                logger.info(
                    `Authenticated as ${this.identity!.user} (device: ${this.identity!.device})`,
                );
            } else if (outcome === "invalid") {
                this.token = undefined;
                this.onAuthRejected?.("invalid");
            } else {
                // Timed out waiting for a verdict: the server (if it answered
                // at all) treats this socket as a guest. Keep the stored token
                // on disk — we never learned it was bad — but stop re-sending
                // it on this socket.
                this.token = undefined;
                logger.warn(
                    `No auth verdict after ${this.authTimeoutMs}ms from ${this.url}; continuing as a guest`,
                );
            }
        }
        if (socket.readyState === WebSocket.OPEN) {
            this.socket = socket;
            return socket;
        }
        throw new Error(`connection to ${this.url} was closed during setup`);
    }

    /**
     * Sends the auth handshake and waits for the server's verdict.
     *
     * Resolves `"authenticated"` on an `authResult` frame (recording the
     * confirmed identity), `"invalid"` on an error frame or a socket that
     * dies before a verdict, and `"timeout"` if neither arrives within
     * `authTimeoutMs`. Every path detaches the handshake listener first so it
     * can never consume a prompt's frames.
     */
    private handshake(socket: WebSocket): Promise<HandshakeOutcome> {
        return new Promise((resolve) => {
            const teardown = (): void => {
                clearTimeout(timer);
                socket.onmessage = null;
                socket.onerror = null;
                socket.onclose = null;
            };
            const timer = setTimeout(() => {
                teardown();
                resolve("timeout");
            }, this.authTimeoutMs);
            socket.onmessage = (event: MessageEvent): void => {
                const frame = parseFrame(String(event.data));
                if ("authResult" in frame) {
                    teardown();
                    this.identity = {
                        user: frame.authResult.user,
                        device: frame.authResult.device,
                    };
                    resolve("authenticated");
                } else if ("error" in frame) {
                    teardown();
                    resolve("invalid");
                }
            };
            socket.onerror = (): void => {
                teardown();
                resolve("invalid");
            };
            socket.onclose = (): void => {
                teardown();
                resolve("invalid");
            };
            socket.send(serializeAuth(this.token!));
        });
    }
}
