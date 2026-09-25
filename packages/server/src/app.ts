import express from "express";
import type {
    ErrorRequestHandler,
    NextFunction,
    Request,
    Response,
} from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { createAuthRouter } from "./http/authRoutes";
import {
    contractErrorResponse,
    mountContractValidator,
} from "./http/contractValidation";
import { logger } from "./logger";

/**
 * Creates the Express app that serves the HTTP endpoints.
 *
 * Kept as a factory (rather than a module-level app) so tests can import it
 * via supertest without binding a port. The network bootstrap lives in
 * `index.ts`. `store` backs the `/api` management routes and `appConfig`
 * supplies their settings.
 *
 * The web portal (built React SPA from `packages/portal`) is served at `/`
 * when `appConfig.portalDir` points at a folder containing `index.html`: a CSP
 * header, `express.static`, and an SPA fallback that hands unknown non-`/api`
 * GETs back the portal's `index.html`. Without a portal build, `/` answers the
 * legacy "Hello World" text. Machine health checks use `GET /health`
 * regardless, so monitoring never depends on the portal being present.
 */
export function createApp(store: AppDatabase, appConfig: AppConfig) {
    const app = express();
    app.use(express.json());

    // Runtime contract gate: /api request shapes always, /api + /health
    // response shapes only under JARVIS_API_CONTRACT=verify (see the module).
    mountContractValidator(app, appConfig.apiContractVerify === true);

    app.get("/health", (req, res) => {
        res.status(200).json({ ok: true });
    });

    app.use("/api", createAuthRouter(store, appConfig));

    const portalIndex = appConfig.portalDir
        ? path.join(appConfig.portalDir, "index.html")
        : null;
    if (portalIndex && existsSync(portalIndex)) {
        logger.info(
            `serving web portal from ${appConfig.portalDir} (index.html found)`,
        );
        app.use(portalSecurityHeaders);
        // `index: "index.html"` makes `GET /` itself serve the SPA shell.
        app.use(express.static(appConfig.portalDir!, { index: "index.html" }));
        app.use(spaFallback(portalIndex));
    } else {
        if (appConfig.portalDir) {
            logger.warn(
                `web portal not found at ${appConfig.portalDir}; serving without it (build packages/portal first, or set JARVIS_PORTAL_DIR)`,
            );
        }
        app.get("/", (req, res) => {
            res.send("Hello World");
        });
    }

    app.use(jsonErrorHandler);

    return app;
}

/**
 * Creates the plain-HTTP upgrade-off app used when TLS is enabled.
 *
 * While the server speaks HTTPS on `PORT`, this app runs on the
 * `JARVIS_HTTP_REDIRECT_PORT` (default `PORT + 1`) and bounces every request
 * to the HTTPS origin with a 302, so an old `http://` bookmark or an
 * autodiscovered cleartext URL still reaches the encrypted server instead of
 * silently staying on cleartext. The target hostname comes from each request's
 * `Host` header (dropping its port), so LAN clients are redirected to their own
 * address rather than `localhost`.
 */
export function createHttpsRedirectApp(httpsPort: number) {
    const app = express();
    app.use((req, res) => {
        // URL.parse → .hostname strips the port AND keeps IPv6 brackets
        // (`[::1]:54321` → `[::1]`), which a naive split(":") would mangle.
        const host =
            new URL(`http://${req.headers.host ?? "localhost"}`).hostname ??
            "localhost";
        res.redirect(302, `https://${host}:${httpsPort}${req.originalUrl}`);
    });
    return app;
}

/** Returns JSON `{ "error" }` for bad HTTP bodies instead of the HTML page. */
const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
    if (
        typeof err === "object" &&
        err !== null &&
        (err as { type?: string }).type === "entity.parse.failed"
    ) {
        res.status(400).json({ error: "invalid JSON body" });
        return;
    }
    if (
        typeof err === "object" &&
        err !== null &&
        ((err as { type?: string }).type === "entity.too.large" ||
            (err as { statusCode?: number }).statusCode === 413)
    ) {
        res.status(413).json({ error: "request body too large" });
        return;
    }
    const contractError = contractErrorResponse(err);
    if (contractError) {
        res.status(contractError.status).json({ error: contractError.error });
        return;
    }
    next(err);
};

/**
 * Dialog-friendly Content-Security-Policy for the served portal.
 *
 * Vite ships a production build as same-origin module scripts and stylesheets,
 * so `default-src 'self'` covers both; inline `style` attributes (React's
 * `style={{…}}` and the styling non-goal-excluded convenience) need
 * `style-src 'unsafe-inline'`. No inline scripts are emitted by Vite builds.
 */
function portalSecurityHeaders(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
}

/**
 * SPA fallback: any GET/HEAD outside `/api` and `/health` that `express.static`
 * didn't answer becomes the portal shell, so client-side routes (e.g.
 * `/#/users`) reload at the same URL. The shell is served `no-cache` so a new
 * bundle is picked up on the next reload after a deploy.
 */
function spaFallback(indexHtml: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
            next();
            return;
        }
        if (req.path.startsWith("/api")) {
            next();
            return;
        }
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile(indexHtml, (err) => {
            if (err) {
                next(err);
            }
        });
    };
}
