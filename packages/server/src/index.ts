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
import {
    getAppConfig,
    getLlmConfig,
    getServerPort,
    DEFAULT_HOST,
    DEFAULT_ATTACHMENT_CONFIG,
} from "./config";
import { attachChatServer } from "./ws";
import { initAgentGraph } from "./agent";
import { createVisionModel } from "./llm/visionModel";
import {
    createAttachmentStore,
    sweepOrphanAttachments,
} from "./attachments/store";
import { InFlightLimiter, VlCallLimiter } from "./attachments/limiters";
import { openAppDatabase } from "@lukestanbery/jarvis-auth";
import { createJarvisServer } from "./listener";

const port = getServerPort();
const appConfig = getAppConfig();
const host = appConfig.host ?? DEFAULT_HOST;

const attachmentConfig = appConfig.attachments ?? DEFAULT_ATTACHMENT_CONFIG;
// Clear last process's orphans before anything can upload; the mtime filter
// keeps this race-free against a request that lands while it runs.
void sweepOrphanAttachments(attachmentConfig);
const attachments = createAttachmentStore(attachmentConfig);
const inFlight = new InFlightLimiter(attachmentConfig.maxInflight);
const vlLimiter = new VlCallLimiter(attachmentConfig.vlCallsPerMin);

initAgentGraph({
    attachments,
    vision: createVisionModel(getLlmConfig()),
    vlLimiter,
});
const store = openAppDatabase(appConfig.appDbPath);
const webApp = createApp(store, appConfig, attachments, inFlight);

const { server } = createJarvisServer(webApp, {
    port,
    host,
    tlsCertPath: appConfig.tlsCertPath,
    tlsKeyPath: appConfig.tlsKeyPath,
    redirectPort: appConfig.httpRedirectPort,
});
attachChatServer(server, store, {
    turnTimeoutMs: appConfig.turnTimeoutMs,
    attachments,
});
