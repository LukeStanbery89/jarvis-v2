/**
 * WebSocket chat endpoint.
 *
 * Mounted on the `"/ws"` path of the HTTP server. Clients send JSON prompt
 * frames and receive chunk/done frames back. The frame shapes and
 * parse/serialize logic live in `@jarvis/protocol` — the single source of
 * truth for the wire protocol — so the server never re-declares them.
 */
import type { Server } from "http";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import { parseRequest, serializeFrame } from "@jarvis/protocol";
import type { ServerFrame } from "@jarvis/protocol";
import { runAgent } from "./agent";
import { logger } from "./logger";

/**
 * Attaches the WebSocket chat server to an HTTP server and returns it.
 *
 * `httpServer` should already be listening; the chat server accepts
 * connections on the `"/ws"` path.
 */
export function attachChatServer(httpServer: Server): WebSocketServer {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (socket) => {
        logger.info("New WebSocket connection");
        let active: Promise<void> | null = null;

        socket.on("message", (raw) => {
            if (active) {
                logger.warn(
                    "Rejecting prompt: another request is already in progress",
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
 * Handles one incoming frame: parses the `prompt` and `sessionId` fields and
 * streams the agent's events back over the socket. Invalid messages get an
 * error frame, as do LLM failures. Returns a promise that settles when the
 * response is fully streamed or the stream fails.
 */
async function handleMessage(raw: RawData, socket: WebSocket): Promise<void> {
    const frameText = raw.toString();
    logger.sensitive("Received message from WebSocket", frameText);
    let prompt: string;
    let sessionId: string;
    try {
        const request = parseRequest(frameText);
        prompt = request.prompt;
        sessionId = request.sessionId;
    } catch (err) {
        const detail = err instanceof Error ? err.message : "unknown error";
        logger.error(`Failed to parse WebSocket message: ${detail}`);
        sendError(
            socket,
            "invalid message format; expected 'prompt' and 'sessionId' " +
                "non-empty string fields",
        );
        return;
    }

    await streamEventsToSocket(socket, prompt, sessionId);
}

/**
 * Streams the agent's events to the socket as frames, finishing with
 * `{"done": true}`, or an error frame followed by `done` if the agent fails or
 * the socket closes mid-stream.
 */
async function streamEventsToSocket(
    socket: WebSocket,
    prompt: string,
    sessionId: string,
): Promise<void> {
    try {
        for await (const event of runAgent(prompt, sessionId)) {
            if (socket.readyState !== WebSocket.OPEN) {
                return;
            }
            switch (event.type) {
                case "token":
                    logger.sensitiveDebug("LLM token", event.text);
                    sendFrame(socket, { chunk: event.text });
                    break;
                case "tool":
                    logger.info(`Agent calling tool ${event.name}`);
                    sendFrame(socket, {
                        tool: { name: event.name, args: event.args },
                    });
                    break;
                case "toolResult":
                    logger.debug(`Tool ${event.name} returned`);
                    sendFrame(socket, {
                        toolResult: {
                            name: event.name,
                            output: event.output,
                        },
                    });
                    break;
            }
        }
        logger.debug("Agent stream complete");
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        sendFrame(socket, { done: true });
    } catch (err) {
        logger.error(
            `LLM stream failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        sendError(socket, "model request failed");
    }
}

/** Sends an error frame followed by a `done` frame. */
function sendError(socket: WebSocket, message: string): void {
    logger.info(`Sending error frame to WebSocket: ${message}`);
    sendFrame(socket, { error: message });
    sendFrame(socket, { done: true });
}

/** Serializes and sends one server frame. */
function sendFrame(socket: WebSocket, frame: ServerFrame): void {
    socket.send(serializeFrame(frame));
}
