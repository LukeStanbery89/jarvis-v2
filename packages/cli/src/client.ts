/**
 * A single frame received from the server.
 */
type ChatEvent =
    | { type: "chunk"; text: string }
    | { type: "done" }
    | { type: "error"; message: string };

/**
 * WebSocket chat client for the Jarvis server.
 *
 * Connects lazily on the first `prompt()` call and reconnects automatically
 * if the connection drops. Uses Node's built-in `WebSocket`, so this package
 * has no runtime dependencies.
 */
export class ChatClient {
    private socket: WebSocket | null = null;

    constructor(private readonly url: string) {}

    /**
     * Sends a prompt and invokes `onChunk` for each streamed chunk until the
     * server signals `done`.
     *
     * Rejects with an `Error` if the server reports an error frame or the
     * connection fails.
     */
    async prompt(
        text: string,
        onChunk: (chunk: string) => void,
    ): Promise<void> {
        const socket = await this.ensureConnected();
        socket.send(JSON.stringify({ prompt: text }));

        await new Promise<void>((resolve, reject) => {
            socket.onmessage = (event: MessageEvent): void => {
                const frame = parseFrame(String(event.data));
                switch (frame.type) {
                    case "chunk":
                        onChunk(frame.text);
                        break;
                    case "done":
                        socket.onmessage = null;
                        resolve();
                        break;
                    case "error":
                        socket.onmessage = null;
                        reject(new Error(frame.message));
                        break;
                }
            };
            socket.onerror = (): void => {
                socket.onmessage = null;
                reject(new Error("connection error"));
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
    };
    if (typeof frame.chunk === "string") {
        return { type: "chunk", text: frame.chunk };
    }
    if (frame.done === true) {
        return { type: "done" };
    }
    if (typeof frame.error === "string") {
        return { type: "error", message: frame.error };
    }
    throw new Error("received an unrecognized message from the server");
}
