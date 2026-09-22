/**
 * Listener seam: turns an Express app + listen settings into a running
 * HTTP(S) server.
 *
 * Owns transport selection (plain HTTP vs. in-node TLS), the half-set-TLS
 * guard, the `https` cert/key reads, the bind + `listen()` call, and — in
 * TLS mode — the cleartext HTTP redirect listener that upgrades browsers to
 * the HTTPS port. `src/index.ts` is the only caller, keeping the entry point
 * a thin composition root that never touches `node:http`/`node:https`.
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Express } from "express";
import { createHttpsRedirectApp } from "./app";
import { logger } from "./logger";

/** Listen settings resolved by the caller (env parsing stays in config.ts). */
export interface ListenerSettings {
    /** Main listener port. */
    port: number;
    /** Bind address (e.g. `0.0.0.0` keeps the LAN posture). */
    host: string;
    /** PEM certificate path (`JARVIS_TLS_CERT`); together with `tlsKeyPath` enables TLS. */
    tlsCertPath?: string;
    /** PEM private-key path (`JARVIS_TLS_KEY`). */
    tlsKeyPath?: string;
    /**
     * Cleartext upgrade port in TLS mode (`JARVIS_HTTP_REDIRECT_PORT`);
     * defaults to `port + 1` when unset.
     */
    redirectPort?: number;
}

/** A running listener: the node server plus the scheme/url used for logging. */
export interface Listener {
    server: HttpServer;
    scheme: "http" | "https";
    url: string;
}

/**
 * Resolves a sane cleartext upgrade port.
 *
 * Invalid input (`NaN`, non-positive, or colliding with the HTTPS port) falls
 * back to `port + 1`. Pure so the guard is unit-testable without certs.
 */
export function validateRedirectPort(
    redirectPort: number | undefined,
    port: number,
): number {
    return redirectPort !== undefined &&
        Number.isInteger(redirectPort) &&
        redirectPort > 0 &&
        redirectPort !== port
        ? redirectPort
        : port + 1;
}

/**
 * Builds and listens on the main HTTP(S) server, and — only when TLS is
 * configured — starts the cleartext redirect listener. Logs the bind URL.
 *
 * A half-set TLS pair (cert without key or vice-versa) is almost always a
 * typo, so it is logged loudly and the server falls back to plain HTTP
 * rather than silently serving cleartext the operator believes is encrypted.
 */
export function createJarvisServer(
    webApp: Express,
    settings: ListenerSettings,
): Listener {
    const { port, host, tlsCertPath, tlsKeyPath } = settings;
    const tlsEnabled = Boolean(tlsCertPath && tlsKeyPath);
    if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
        logger.error(
            `JARVIS_TLS_CERT=${tlsCertPath ?? "<unset>"} but ` +
                `JARVIS_TLS_KEY=${tlsKeyPath ?? "<unset>"}; ` +
                "both or neither must be set. Falling back to plain HTTP.",
        );
    }
    const scheme = tlsEnabled ? "https" : "http";
    const url = `${scheme}://localhost:${port}`;
    const server = tlsEnabled
        ? createHttpsServer(
              {
                  key: readFileSync(tlsKeyPath!, { encoding: "utf8" }),
                  cert: readFileSync(tlsCertPath!, { encoding: "utf8" }),
              },
              webApp,
          )
        : createHttpServer(webApp);

    server.listen(port, host, () => {
        logger.info(
            `J.A.R.V.I.S. server listening on ${url} (bind ${host}, HTTPS ${tlsEnabled})`,
        );
    });

    if (tlsEnabled) {
        const redirectPort = validateRedirectPort(settings.redirectPort, port);
        createHttpsRedirectApp(port).listen(redirectPort, host, () => {
            logger.info(
                `Cleartext port ${redirectPort} now redirects to ${url}`,
            );
        });
    }

    return { server, scheme, url };
}
