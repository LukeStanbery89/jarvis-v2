/**
 * Server entry point.
 *
 * Builds the Express app, boots the agent graph (creating `~/.jarvis` and the
 * checkpoint store), opens the app database (users/devices/sessions), attaches
 * the WebSocket chat server, and listens on the configured host + port.
 *
 * Transport selection: with `JARVIS_TLS_CERT` + `JARVIS_TLS_KEY` set, the main
 * listener speaks HTTPS and a plain-HTTP redirect app (`PORT + 1`, or
 * `JARVIS_HTTP_REDIRECT_PORT`) upgrades requests to it; otherwise the server
 * is plain HTTP (the LAN posture). `JARVIS_HOST` controls the bind address
 * (default `0.0.0.0`).
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createApp, createHttpsRedirectApp } from "./app";
import { logger } from "./logger";
import { getAppConfig, getServerPort, DEFAULT_HOST } from "./config";
import { attachChatServer } from "./ws";
import { initAgentGraph } from "./agent";
import { openAppStore } from "./auth";

const port = getServerPort();
const appConfig = getAppConfig();
const host = appConfig.host ?? DEFAULT_HOST;
const tlsEnabled = Boolean(appConfig.tlsCertPath && appConfig.tlsKeyPath);
if (Boolean(appConfig.tlsCertPath) !== Boolean(appConfig.tlsKeyPath)) {
    // Half-set TLS is almost always a typo; fail loud instead of silently
    // serving cleartext that the operator believes is encrypted.
    logger.error(
        `JARVIS_TLS_CERT=${appConfig.tlsCertPath ?? "<unset>"} but ` +
            `JARVIS_TLS_KEY=${appConfig.tlsKeyPath ?? "<unset>"}; ` +
            "both or neither must be set. Falling back to plain HTTP.",
    );
}

initAgentGraph();
const store = openAppStore(appConfig.appDbPath);

const webApp = createApp(store, appConfig);
const url = `http${tlsEnabled ? "s" : ""}://localhost:${port}`;
const turnOptions = { turnTimeoutMs: appConfig.turnTimeoutMs };

const server = tlsEnabled
    ? createHttpsServer(
          {
              key: readFileSync(appConfig.tlsKeyPath!, { encoding: "utf8" }),
              cert: readFileSync(appConfig.tlsCertPath!, { encoding: "utf8" }),
          },
          webApp,
      )
    : createHttpServer(webApp);

server.listen(port, host, () => {
    logger.info(
        `J.A.R.V.I.S. server listening on ${url} (bind ${host}, HTTPS ${tlsEnabled})`,
    );
});
attachChatServer(server, store, turnOptions);

if (tlsEnabled) {
    const rawRedirect = Number(
        process.env.JARVIS_HTTP_REDIRECT_PORT ?? port + 1,
    );
    const redirectPort =
        Number.isInteger(rawRedirect) && rawRedirect > 0 && rawRedirect !== port
            ? rawRedirect
            : port + 1;
    createHttpsRedirectApp(port).listen(redirectPort, host, () => {
        logger.info(`Cleartext port ${redirectPort} now redirects to ${url}`);
    });
}
