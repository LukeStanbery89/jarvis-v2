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
import { createCorsMiddleware } from "./http/cors";
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
 * GETs back the portal's `index.html`. The web chat client (built React SPA
 * from `packages/web`) is mounted at `/web` the same way when
 * `appConfig.webDir` holds `index.html`, before the portal's fallback so it
 * never inherits the portal shell. Without a portal build, `/` answers the
 * legacy "Hello World" text; a missing web build leaves `/web` unmounted.
 * Machine health checks use `GET /health` regardless, so monitoring never
 * depends on either SPA being present.
 */
export function createApp(store: AppDatabase, appConfig: AppConfig) {
    const app = express();

    // Believe X-Forwarded-For only from the configured proxy hops (#63). Set
    // before any middleware so `req.ip` is correct everywhere — most visibly in
    // the credential throttle, whose per-(ip, username) and per-ip keys would
    // otherwise collapse into one shared bucket for every client behind the
    // proxy. Empty/unset trusts nothing, which is fail-closed.
    if (appConfig.trustProxyCidrs && appConfig.trustProxyCidrs.length > 0) {
        app.set("trust proxy", [...appConfig.trustProxyCidrs]);
        logger.info(
            `trusting X-Forwarded-For from ${appConfig.trustProxyCidrs.join(", ")}`,
        );
    }

    // Ahead of express.json() and the contract validator: a browser preflight is
    // an OPTIONS request that the validator would reject against POST-only
    // paths (see the module doc for the full ordering rationale).
    app.use(createCorsMiddleware(appConfig.corsOrigins));

    app.use(express.json());

    // Runtime contract gate: /api request shapes always, /api + /health
    // response shapes only under JARVIS_API_CONTRACT=verify (see the module).
    mountContractValidator(app, appConfig.apiContractVerify === true);

    app.get("/health", (req, res) => {
        res.status(200).json({ ok: true });
    });

    app.use("/api", createAuthRouter(store, appConfig));

    const webIndex = appConfig.webDir
        ? path.join(appConfig.webDir, "index.html")
        : null;
    const webMounted = Boolean(webIndex && existsSync(webIndex));
    if (webMounted) {
        logger.info(
            `serving web chat client from ${appConfig.webDir} (index.html found)`,
        );
        // The web client renders remote (https) images from the model and dials
        // the same-origin `/ws` socket, so its CSP widens `img-src` beyond the
        // portal's `'self' data:` posture and adds this request's ws/wss origin.
        app.use(
            "/web",
            spaSecurityHeaders({ remoteImages: true, websocketOrigins: true }),
        );
        // `index: "index.html"` makes `GET /web` itself serve the shell.
        app.use(
            "/web",
            express.static(appConfig.webDir!, { index: "index.html" }),
        );
        app.use("/web", spaFallback(webIndex!));
    } else if (appConfig.webDir) {
        logger.warn(
            `web chat client not found at ${appConfig.webDir}; serving without it (build packages/web first, or set JARVIS_WEB_DIR)`,
        );
    }

    const portalIndex = appConfig.portalDir
        ? path.join(appConfig.portalDir, "index.html")
        : null;
    if (portalIndex && existsSync(portalIndex)) {
        logger.info(
            `serving web portal from ${appConfig.portalDir} (index.html found)`,
        );
        app.use(spaSecurityHeaders());
        // `index: "index.html"` makes `GET /` itself serve the SPA shell.
        app.use(express.static(appConfig.portalDir!, { index: "index.html" }));
        app.use(spaFallback(portalIndex, "/web"));
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
 * Options for {@link spaSecurityHeaders}.
 */
interface SpaSecurityHeaderOptions {
    /**
     * Whether the served app may load remote (https) images. The admin portal
     * renders no model content and stays on the conservative `'self' data:`
     * posture; the web chat client renders model-produced Markdown image
     * links and widens `img-src` by `https:`.
     */
    remoteImages?: boolean;
    /**
     * Whether `connect-src` additionally allows this request's same-origin
     * `ws`/`wss` socket origin. The chat client dials `/ws` on the server it
     * loaded from; the admin portal keeps the static `'self'` posture.
     */
    websocketOrigins?: boolean;
}

/**
 * Dialog-friendly Content-Security-Policy middleware for a served SPA.
 *
 * Vite ships a production build as same-origin module scripts and stylesheets,
 * so `default-src 'self'` covers both; inline `style` attributes (React's
 * `style={{…}}` and the styling non-goal-excluded convenience) need
 * `style-src 'unsafe-inline'`. No inline scripts are emitted by Vite builds.
 * `connect-src` pins to this request's origin plus (when
 * `websocketOrigins` is set, as the chat client needs) that request's
 * `ws`/`wss` origin — derived from the `Host` header only when it is a bare
 * host[:port] (anything else drops the socket sources rather than trusting
 * a malformed value in the header).
 */
function spaSecurityHeaders({
    remoteImages = false,
    websocketOrigins = false,
}: SpaSecurityHeaderOptions = {}) {
    return (req: Request, res: Response, next: NextFunction) => {
        const imgSrc = remoteImages
            ? "img-src 'self' data: https:"
            : "img-src 'self' data:";
        const host = req.headers.host;
        const socketOrigins =
            websocketOrigins &&
            typeof host === "string" &&
            /^[\w.-]+(:\d+)?$/.test(host)
                ? ` ws://${host} wss://${host}`
                : "";
        res.setHeader(
            "Content-Security-Policy",
            `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ${imgSrc}; connect-src 'self'${socketOrigins}`,
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
        next();
    };
}

/**
 * SPA fallback: any GET/HEAD outside `/api`, `/health`, and `skipPrefix`
 * (when set) that `express.static` didn't answer becomes the SPA shell, so
 * client-side routes (e.g. `/#/users`) reload at the same URL. The shell is
 * served `no-cache` so a new bundle is picked up on the next reload after a
 * deploy.
 *
 * `skipPrefix` keeps the portal's root-level fallback from swallowing the
 * `/web`-mounted chat-client paths (the *web* mount owns those, when built)
 * — and from answering `/web` at all otherwise, where a 404 is the honest
 * answer. The match is path-boundary aware: `/webfoo` is NOT skipped, only
 * `/web` itself and `/web/…` are.
 */
function spaFallback(indexHtml: string, skipPrefix: string | null = null) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
            next();
            return;
        }
        if (req.path.startsWith("/api")) {
            next();
            return;
        }
        if (
            skipPrefix &&
            (req.path === skipPrefix || req.path.startsWith(`${skipPrefix}/`))
        ) {
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
