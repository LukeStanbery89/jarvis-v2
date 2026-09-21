/**
 * WebSocket chat client for the J.A.R.V.I.S. server.
 *
 * Connects lazily on the first `prompt()` call and reconnects automatically
 * if the connection drops. Each prompt carries the conversation's `sessionId`
 * so the server continues the same thread. Uses Node's built-in `WebSocket`,
 * so this module adds no third-party runtime dependency.
 *
 * Frame parsing and serialization come from `@jarvis/protocol`, the single
 * source of truth for the wire protocol; this module only maps parsed frames
 * onto the `PromptHandlers` callbacks.
 */
import { parseFrame, serializeRequest } from "@jarvis/protocol";

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
 * if the connection drops. Each prompt carries the conversation's `sessionId`
 * so the server continues the same thread. Uses Node's built-in `WebSocket`,
 * so this module adds no third-party runtime dependency.
 */
export class ChatClient {
    private socket: WebSocket | null = null;
    private active = false;

    constructor(private readonly url: string) {}

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
                        reject(new Error(frame.error));
                    } else {
                        teardown();
                        resolve();
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

    /** Returns the open socket, connecting to the server first if needed. */
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
        this.socket = socket;
        return socket;
    }
}
