/**
 * Server entry point.
 *
 * Builds the Express app, boots the agent graph (creating `~/.jarvis` and the
 * checkpoint store), attaches the WebSocket chat server, and listens on the
 * configured port (default 54321, overridable via `PORT`).
 */
import { createApp } from "./app";
import { logger } from "./logger";
import { getServerPort } from "./config";
import { attachChatServer } from "./ws";
import { initAgentGraph } from "./agent";

const port = getServerPort();

initAgentGraph();

const server = createApp().listen(port, () => {
    logger.info(`J.A.R.V.I.S. server listening on http://localhost:${port}`);
});

attachChatServer(server);
