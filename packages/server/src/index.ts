/**
 * Server entry point.
 *
 * Builds the Express app, boots the agent graph (creating `~/.jarvis` and the
 * checkpoint store), opens the app database (users/devices/sessions), attaches
 * the WebSocket chat server, and listens on the configured port (default
 * 54321, overridable via `PORT`).
 */
import { createApp } from "./app";
import { logger } from "./logger";
import { getAppConfig, getServerPort } from "./config";
import { attachChatServer } from "./ws";
import { initAgentGraph } from "./agent";
import { openAppStore } from "./auth";

const port = getServerPort();
const appConfig = getAppConfig();

initAgentGraph();
const store = openAppStore(appConfig.appDbPath);

const server = createApp(store, appConfig).listen(port, () => {
    logger.info(`J.A.R.V.I.S. server listening on http://localhost:${port}`);
});

attachChatServer(server, store, {
    turnTimeoutMs: appConfig.turnTimeoutMs,
});
