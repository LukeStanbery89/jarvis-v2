/**
 * Server entry point.
 *
 * Builds the Express app, attaches the WebSocket chat server, and listens on
 * the configured port (default 54321, overridable via `PORT`).
 */
import { createApp } from "./app";
import { logger } from "./logger";
import { attachChatServer } from "./ws";

// Default port 54321 is referenced by the CLI's default server URL
// (packages/cli/src/config.ts) — keep the two in sync.
const port = Number(process.env.PORT ?? 54321);

const server = createApp().listen(port, () => {
    logger.info(`J.A.R.V.I.S. server listening on http://localhost:${port}`);
});

attachChatServer(server);
