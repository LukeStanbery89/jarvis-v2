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
import { runAgent } from "./agent";

/** A frame the server sends to chat clients over `/ws`. */
type ServerFrame = { chunk: string } | { done: true } | { error: string };

/**
 * Attaches the WebSocket chat server to an HTTP server and returns it.
 *
 * `httpServer` should already be listening; the chat server accepts
 * connections on the `"/ws"` path.
 */
export function attachChatServer(httpServer: Server): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (socket) => {
        console.info("[INFO] New WebSocket connection");
        let active: Promise<void> | null = null;

        socket.on("message", (raw) => {
            if (active) {
                console.warn(
                    "[WARN] Rejecting prompt: another request is already in progress",
                );
                sendError(socket, "another request is already in progress");
                return;
            }
            active = handleMessage(raw, socket).finally(() => {
                active = null;
            });
        });
    });

    return wss;
}

/**
 * Handles one incoming frame: parses the `prompt` field and streams the
 * model's response tokens back over the socket. Invalid messages get an error
 * frame, as do LLM failures. Returns a promise that settles when the response
 * is fully streamed or the stream fails.
 */
async function handleMessage(raw: RawData, socket: WebSocket): Promise<void> {
    const frameText = raw.toString();
    console.info(`[INFO] Received message from WebSocket: ${frameText}`);
    let prompt: string;
    try {
        const parsed: unknown = JSON.parse(frameText);
        const promptField = (parsed as { prompt?: unknown }).prompt;
        if (typeof promptField !== "string" || promptField.trim() === "") {
            throw new Error("expected a non-empty string field 'prompt'");
        }
        prompt = promptField;
    } catch (err) {
        const detail = err instanceof Error ? err.message : "unknown error";
        console.error(`[ERROR] Failed to parse WebSocket message: ${detail}`);
        sendError(
            socket,
            "invalid message format; expected a non-empty string field 'prompt'",
        );
        return;
    }

    await streamTokensToSocket(socket, prompt);
}

/**
 * Streams the LLM's response tokens to the socket as `{"chunk": ...}` frames,
 * finishing with `{"done": true}`, or an error frame followed by `done` if the
 * model request fails or the socket closes mid-stream.
 */
async function streamTokensToSocket(
    socket: WebSocket,
    prompt: string,
): Promise<void> {
    try {
        for await (const token of runAgent(prompt)) {
            console.debug(`[DEBUG] LLM token: ${token}`);
            if (socket.readyState !== WebSocket.OPEN) {
                return;
            }
            sendFrame(socket, { chunk: token });
        }
        console.debug("[DEBUG] LLM stream complete");
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        sendFrame(socket, { done: true });
    } catch (err) {
        console.error(
            `[ERROR] LLM stream failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        sendError(socket, "model request failed");
    }
}

/** Sends an error frame followed by a `done` frame. */
function sendError(socket: WebSocket, message: string): void {
    console.info(`[INFO] Sending error frame to WebSocket: ${message}`);
    sendFrame(socket, { error: message });
    sendFrame(socket, { done: true });
}

/** Serializes and sends one server frame. */
function sendFrame(socket: WebSocket, frame: ServerFrame): void {
    socket.send(JSON.stringify(frame));
}
