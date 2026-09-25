/**
 * Server entry point.
 *
 * Builds the Express app, boots the agent graph (creating `~/.jarvis` and the
 * checkpoint store), opens the app database (users/devices/sessions), hands
 * the app to the listener seam, and attaches the WebSocket chat server.
 *
 * Transport selection, TLS, the cert reads, and the HTTPS redirect listener
 * all live in `src/listener.ts`; this file is a thin composition root.
 */
// Must stay the first import: dotenv loads `.env` into `process.env` before
// `config.ts` reads it. Real environment variables always win over the file.
import "dotenv/config";
import { createApp } from "./app";
import { getAppConfig, getServerPort, DEFAULT_HOST } from "./config";
import { attachChatServer } from "./ws";
import { initAgentGraph } from "./agent";
import { openAppDatabase } from "@lukestanbery/jarvis-auth";
import { createJarvisServer } from "./listener";

const port = getServerPort();
const appConfig = getAppConfig();
const host = appConfig.host ?? DEFAULT_HOST;

initAgentGraph();
const store = openAppDatabase(appConfig.appDbPath);
const webApp = createApp(store, appConfig);

const { server } = createJarvisServer(webApp, {
    port,
    host,
    tlsCertPath: appConfig.tlsCertPath,
    tlsKeyPath: appConfig.tlsKeyPath,
    redirectPort: appConfig.httpRedirectPort,
});
attachChatServer(server, store, { turnTimeoutMs: appConfig.turnTimeoutMs });
