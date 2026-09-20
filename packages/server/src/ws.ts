/**
 * WebSocket chat endpoint.
 *
 * Mounted on the `"/ws"` path of the HTTP server. Clients send JSON prompt
 * frames and receive chunk/done frames back (see the package README for the
 * protocol).
 */
import type { Server } from "http";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import { responseTokens } from "./stream";

const STREAM_DELAY_MS = 150;

/**
 * Attaches the WebSocket chat server to an HTTP server and returns it.
 *
 * `httpServer` should already be listening; the chat server accepts
 * connections on the `"/ws"` path.
 */
export function attachChatServer(httpServer: Server): WebSocketServer {
    console.info("Attaching WebSocket server to HTTP server");
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (socket) => {
        console.info(`New WebSocket connection from ${socket.url}`);
        socket.on("message", (raw) => handleMessage(raw, socket));
    });

    console.log("WebSocket server attached to HTTP server");
    return wss;
}

/**
 * Handles one incoming frame: parses the `prompt` field and streams the
 * response tokens back over the socket. Invalid messages get an error frame.
 *
 * TEMPORARY: once the server is wired to a real LLM, this will be replaced by
 * logic that forwards the prompt to the model and streams its tokens.
 */
function handleMessage(raw: RawData, socket: WebSocket): void {
    console.info(`Received message from WebSocket: ${raw.toString()}`);
    let prompt: string;
    try {
        const parsed: unknown = JSON.parse(raw.toString());
        const promptField = (parsed as { prompt?: unknown }).prompt;
        if (typeof promptField !== "string" || promptField.trim() === "") {
            throw new Error("expected a non-empty string field 'prompt'");
        }
        prompt = promptField;
    } catch (err) {
        console.error(
            `Error parsing WebSocket message: ${err instanceof Error ? err.message : "invalid message"}`,
        );
        sendError(
            socket,
            err instanceof Error ? err.message : "invalid message",
        );
        return;
    }

    streamTokens(socket, responseTokens(prompt));
}

/**
 * Streams `tokens` to the socket as `{"chunk": "..."}` frames at a fixed
 * interval, finishing with `{"done": true}` once all tokens are sent.
 * Spins down early if the socket closes mid-stream.
 *
 * TEMPORARY: the fixed-delay timer simulates streaming. When a real LLM is
 * connected, the chunk frames will instead be driven by the model's own
 * token stream.
 */
function streamTokens(socket: WebSocket, tokens: string[]): void {
    let index = 0;
    const timer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) {
            clearInterval(timer);
            return;
        }
        if (index < tokens.length) {
            socket.send(JSON.stringify({ chunk: tokens[index++] }));
        } else {
            clearInterval(timer);
            socket.send(JSON.stringify({ done: true }));
        }
    }, STREAM_DELAY_MS);
}

/** Sends an error frame followed by a `done` frame. */
function sendError(socket: WebSocket, message: string): void {
    socket.send(JSON.stringify({ error: message }));
    socket.send(JSON.stringify({ done: true }));
}
