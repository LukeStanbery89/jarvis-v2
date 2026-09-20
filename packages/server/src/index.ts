/**
 * Server entry point.
 *
 * Builds the Express app, attaches the WebSocket chat server, and listens on
 * the configured port (default 54321, overridable via `PORT`).
 */
import { createApp } from "./app";
import { attachChatServer } from "./ws";

const port = Number(process.env.PORT ?? 54321);

const server = createApp().listen(port, () => {
    console.log(`Jarvis server listening on http://localhost:${port}`);
});

attachChatServer(server);
