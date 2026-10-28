/**
 * WebSocket voice client for the satellite.
 *
 * This is the satellite's own turn runner rather than the text CLI's
 * `ChatClient`: it declares the `audio` capability, sends `mode: "voice"`
 * prompts, and collects the binary `pcm_s16le` stream that follows. Text
 * frames still use `@lukestanbery/jarvis-protocol` for parsing, so the wire
 * contract has one owner.
 *
 * A turn resolves only after the server's terminal `done` and, when audio
 * started, the matching `audioEnd`. That keeps playback from starting before
 * the reply is complete and makes a failed TTS pipeline (text without audio)
 * a normal text-only result.
 */
import { readFileSync } from "node:fs";
import WebSocket, { type RawData } from "ws";
import {
    parseFrame,
    serializeAuth,
    serializeHello,
    serializeRequest,
    type NotificationFrame,
    type ServerFrame,
} from "@lukestanbery/jarvis-protocol";
import { logger } from "./logger";

/** The identity confirmed by the server's `authResult`. */
export interface AuthIdentity {
    user: string;
    device: string;
}

/** Callbacks for one turn. */
export interface PromptHandlers {
    onChunk?: (chunk: string) => void;
    onTool?: (name: string, args: unknown) => void;
    onToolResult?: (name: string, output: unknown) => void;
}

/** One turn's spoken audio. */
export interface PromptAudio {
    /** Mono little-endian signed 16-bit PCM. */
    pcm: Buffer;
    /** The sample rate from `audioStart`. */
    sampleRate: number;
}

/** The settled result of one voice prompt. */
export interface PromptResult {
    text: string;
    audio: PromptAudio | null;
}

export interface SatelliteClientOptions {
    url: string;
    token?: string;
    insecureTls: boolean;
    caPath?: string;
    connectTimeoutMs: number;
    authTimeoutMs: number;
    onNotification?: (notification: NotificationFrame["notification"]) => void;
}

interface ActiveTurn {
    text: string;
    chunks: Buffer[];
    sampleRate: number | undefined;
    audioStarted: boolean;
    audioEnded: boolean;
    sawDone: boolean;
    handlers: PromptHandlers;
    resolve: (result: PromptResult) => void;
    reject: (error: Error) => void;
}

interface AuthWaiter {
    resolve: (identity: AuthIdentity) => void;
    reject: (error: Error) => void;
}

/** Normalizes ws's message payload into a Buffer. */
function asBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    return Buffer.from(data);
}

/** One authenticated satellite socket. */
export class SatelliteClient {
    private socket: WebSocket | null = null;
    private connectPromise: Promise<void> | null = null;
    private authWaiter: AuthWaiter | null = null;
    private active: ActiveTurn | null = null;
    private identity: AuthIdentity | null = null;

    constructor(private readonly options: SatelliteClientOptions) {}

    /** The identity confirmed by the current socket, or `null` for a guest. */
    getIdentity(): AuthIdentity | null {
        return this.identity;
    }

    /** Opens and handshakes if there is no live socket. */
    async connect(): Promise<void> {
        if (this.socket?.readyState === WebSocket.OPEN) {
            return;
        }
        if (this.connectPromise !== null) {
            return this.connectPromise;
        }
        this.connectPromise = this.openAndHandshake();
        try {
            await this.connectPromise;
        } catch (err) {
            this.socket?.close();
            this.socket = null;
            throw err;
        } finally {
            this.connectPromise = null;
        }
    }

    /**
     * Sends one voice prompt and waits for its text and (optional) audio.
     *
     * Only one turn may be in flight on a socket; the server enforces the same
     * rule per thread, but failing before the wire makes the client's state
     * unambiguous.
     */
    async prompt(
        text: string,
        sessionId: string,
        handlers: PromptHandlers = {},
    ): Promise<PromptResult> {
        await this.connect();
        if (this.active !== null) {
            throw new Error("another satellite turn is already in flight");
        }
        const socket = this.socket;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
            throw new Error("satellite socket is not connected");
        }
        const active: ActiveTurn = {
            text: "",
            chunks: [],
            sampleRate: undefined,
            audioStarted: false,
            audioEnded: false,
            sawDone: false,
            handlers,
            resolve: () => {},
            reject: () => {},
        };
        const result = new Promise<PromptResult>((resolve, reject) => {
            active.resolve = resolve;
            active.reject = reject;
        });
        this.active = active;
        try {
            socket.send(serializeRequest(text, sessionId, { mode: "voice" }));
        } catch (err) {
            this.active = null;
            active.reject(err instanceof Error ? err : new Error(String(err)));
        }
        return result;
    }

    /** Closes the socket; an in-flight turn is rejected. */
    close(): void {
        this.failAll(new Error("satellite client closed"));
        this.socket?.close();
        this.socket = null;
    }

    private async openAndHandshake(): Promise<void> {
        if (this.options.insecureTls) {
            logger.warn(
                "TLS verification is disabled; use only for a local self-signed server",
            );
        }
        const ca =
            this.options.caPath !== undefined
                ? readFileSync(this.options.caPath)
                : undefined;
        const socket = new WebSocket(this.options.url, {
            rejectUnauthorized: !this.options.insecureTls,
            ...(ca !== undefined ? { ca } : {}),
        });
        this.socket = socket;
        socket.on("message", (data, isBinary) =>
            this.onMessage(data, isBinary),
        );
        socket.on("error", (err) => {
            logger.warn(`Satellite socket error: ${err.message}`);
            this.failAll(new Error(`socket error: ${err.message}`));
        });
        socket.on("close", (code, reason) => {
            logger.debug(
                `Satellite socket closed (${code}${reason.length > 0 ? `: ${reason.toString()}` : ""})`,
            );
            this.socket = null;
            this.identity = null;
            this.failAll(new Error("satellite socket closed"));
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                socket.terminate();
                reject(
                    new Error(
                        `could not connect to ${this.options.url}: timed out after ${this.options.connectTimeoutMs}ms`,
                    ),
                );
            }, this.options.connectTimeoutMs);
            const cleanup = (): void => {
                clearTimeout(timer);
                socket.off("open", onOpen);
                socket.off("error", onError);
            };
            const onOpen = (): void => {
                cleanup();
                resolve();
            };
            const onError = (err: Error): void => {
                cleanup();
                reject(new Error(`could not connect: ${err.message}`));
            };
            socket.once("open", onOpen);
            socket.once("error", onError);
        });

        if (this.options.token !== undefined) {
            // The server accepts `hello` as the opening frame and `auth`
            // immediately after it. Sending auth first makes the later hello
            // late (and an error), so declare rendering capability first.
            socket.send(serializeHello(["audio"]));
            const identity = await this.requestAuth(socket, this.options.token);
            this.identity = identity;
            logger.info(
                `Authenticated as ${identity.user} (device: ${identity.device})`,
            );
        } else {
            socket.send(serializeHello(["audio"]));
            logger.warn(
                "No satellite device token found; running as a guest. Run the text CLI login or set JARVIS_SATELLITE_TOKEN for a persistent owner thread.",
            );
        }
    }

    /** Sends auth and waits for the server's verdict. */
    private requestAuth(
        socket: WebSocket,
        token: string,
    ): Promise<AuthIdentity> {
        return new Promise<AuthIdentity>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.authWaiter = null;
                reject(
                    new Error(
                        `authentication timed out after ${this.options.authTimeoutMs}ms`,
                    ),
                );
                socket.terminate();
            }, this.options.authTimeoutMs);
            this.authWaiter = {
                resolve: (identity) => {
                    clearTimeout(timer);
                    resolve(identity);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            try {
                socket.send(serializeAuth(token));
            } catch (err) {
                clearTimeout(timer);
                this.authWaiter = null;
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private onMessage(data: RawData, isBinary: boolean): void {
        if (isBinary) {
            const active = this.active;
            if (active !== null && active.audioStarted) {
                active.chunks.push(asBuffer(data));
            }
            return;
        }
        let frame: ServerFrame;
        try {
            frame = parseFrame(asBuffer(data).toString("utf8"));
        } catch (err) {
            logger.warn(
                `Unreadable satellite frame: ${err instanceof Error ? err.message : String(err)}`,
            );
            this.failActive(
                new Error("unreadable frame from the JARVIS server"),
            );
            return;
        }
        this.handleFrame(frame);
    }

    private handleFrame(frame: ServerFrame): void {
        if ("authResult" in frame) {
            const waiter = this.authWaiter;
            this.authWaiter = null;
            waiter?.resolve(frame.authResult);
            return;
        }
        if ("notification" in frame) {
            this.options.onNotification?.(frame.notification);
            return;
        }
        if ("audioStart" in frame) {
            const active = this.active;
            if (active !== null) {
                active.audioStarted = true;
                active.sampleRate = frame.audioStart.sampleRate;
            }
            return;
        }
        if ("audioEnd" in frame) {
            const active = this.active;
            if (active !== null) {
                active.audioEnded = true;
                this.maybeFinish();
            }
            return;
        }
        if ("chunk" in frame) {
            const active = this.active;
            if (active !== null) {
                active.text += frame.chunk;
                active.handlers.onChunk?.(frame.chunk);
            }
            return;
        }
        if ("tool" in frame) {
            this.active?.handlers.onTool?.(frame.tool.name, frame.tool.args);
            return;
        }
        if ("toolResult" in frame) {
            this.active?.handlers.onToolResult?.(
                frame.toolResult.name,
                frame.toolResult.output,
            );
            return;
        }
        if ("error" in frame) {
            const error = new Error(frame.error);
            const waiter = this.authWaiter;
            this.authWaiter = null;
            waiter?.reject(error);
            this.failActive(error);
            return;
        }
        if ("done" in frame) {
            const active = this.active;
            if (active !== null) {
                active.sawDone = true;
                this.maybeFinish();
            }
            return;
        }
        if (
            "sessionTitle" in frame ||
            "sessionActivity" in frame ||
            "sessionDeleted" in frame
        ) {
            return;
        }
        logger.debug(
            `Ignoring out-of-turn satellite frame: ${Object.keys(frame).join(", ")}`,
        );
    }

    /** Resolves a turn once `done` and any started audio span have arrived. */
    private maybeFinish(): void {
        const active = this.active;
        if (
            active === null ||
            !active.sawDone ||
            (active.audioStarted && !active.audioEnded)
        ) {
            return;
        }
        this.active = null;
        active.resolve({
            text: active.text,
            audio: active.audioStarted
                ? {
                      pcm: Buffer.concat(active.chunks),
                      sampleRate: active.sampleRate ?? 24_000,
                  }
                : null,
        });
    }

    private failActive(error: Error): void {
        const active = this.active;
        if (active === null) {
            return;
        }
        this.active = null;
        active.reject(error);
    }

    private failAll(error: Error): void {
        const waiter = this.authWaiter;
        this.authWaiter = null;
        waiter?.reject(error);
        this.failActive(error);
    }
}
