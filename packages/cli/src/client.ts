/**
 * A single frame received from the server.
 */
type ChatEvent =
    | { type: "chunk"; text: string }
    | { type: "tool"; name: string; args?: unknown }
    | { type: "toolResult"; name: string; output?: unknown }
    | { type: "done" }
    | { type: "error"; message: string };

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

    constructor(private readonly url: string) {}

    /**
     * Sends `text` for conversation `sessionId` and drives the `handlers`
     * callbacks with the server's events until `done`.
     *
     * Rejects with an `Error` if the server reports an error frame or the
     * connection fails.
     */
    async prompt(
        text: string,
        sessionId: string,
        handlers: PromptHandlers,
    ): Promise<void> {
        const socket = await this.ensureConnected();
        socket.send(JSON.stringify({ prompt: text, sessionId }));

        await new Promise<void>((resolve, reject) => {
            const teardown = (): void => {
                socket.onmessage = null;
                socket.onerror = null;
                socket.onclose = null;
            };
            socket.onmessage = (event: MessageEvent): void => {
                const frame = parseFrame(String(event.data));
                switch (frame.type) {
                    case "chunk":
                        handlers.onChunk(frame.text);
                        break;
                    case "tool":
                        handlers.onTool?.(frame.name, frame.args);
                        break;
                    case "toolResult":
                        handlers.onToolResult?.(frame.name, frame.output);
                        break;
                    case "done":
                        teardown();
                        resolve();
                        break;
                    case "error":
                        teardown();
                        reject(new Error(frame.message));
                        break;
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

/**
 * Parses one raw server frame into a typed `ChatEvent`.
 *
 * Throws if the payload is not valid JSON or matches no known frame shape.
 */
function parseFrame(raw: string): ChatEvent {
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
        return { type: "chunk", text: frame.chunk };
    }
    if (frame.tool && typeof frame.tool.name === "string") {
        return {
            type: "tool",
            name: frame.tool.name,
            args: frame.tool.args,
        };
    }
    if (frame.toolResult && typeof frame.toolResult.name === "string") {
        return {
            type: "toolResult",
            name: frame.toolResult.name,
            output: frame.toolResult.output,
        };
    }
    if (frame.done === true) {
        return { type: "done" };
    }
    if (typeof frame.error === "string") {
        return { type: "error", message: frame.error };
    }
    throw new Error("received an unrecognized message from the server");
}
