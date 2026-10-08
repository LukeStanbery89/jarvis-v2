import express from "express";
import type {
    ErrorRequestHandler,
    NextFunction,
    Request,
    Response,
} from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { createAuthRouter } from "./http/authRoutes";
import {
    contractErrorResponse,
    mountContractValidator,
} from "./http/contractValidation";
import { createCorsMiddleware } from "./http/cors";
import { createAttachmentRouter } from "./http/attachmentRoutes";
import type { AttachmentStore } from "./attachments/store";
import type { InFlightLimiter } from "./attachments/limiters";
import { DEFAULT_ATTACHMENT_MAX_BYTES, type AppConfig } from "./config";
import { logger } from "./logger";
import { createSttModelHandler, SttModelCache } from "./stt/model";
import { createWakeModelHandler, WakeModelCache } from "./wake/model";

/** Returns `413` with the {@link AttachmentTooLarge} contract shape. */
const attachmentBodyTooLarge = (_appConfig: AppConfig, maxBytes: number) => {
    const handler: ErrorRequestHandler = (err, _req, res, next) => {
        if (
            typeof err === "object" &&
            err !== null &&
            ((err as { type?: string }).type === "entity.too.large" ||
                (err as { statusCode?: number }).statusCode === 413)
        ) {
            res.status(413).json({
                error: "request body too large",
                code: "ATTACHMENT_TOO_LARGE",
                maxBytes,
            });
            return;
        }
        next(err);
    };
    return handler;
};

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
export function createApp(
    store: AppDatabase,
    appConfig: AppConfig,
    attachments?: AttachmentStore,
    inFlight?: InFlightLimiter,
) {
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

    // The attachment upload parser mounts FIRST (when the surface is wired):
    // it must claim `/api/attachments` bodies before the global 100 KB parser
    // marks them read, and before the validator, whose own body-size posture
    // is not the enforcement point (review findings B1/B2). The limit is the
    // base64 bound of the decoded cap plus JSON-overhead slack.
    if (attachments) {
        const maxBytes =
            appConfig.attachments?.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
        app.use(
            "/api/attachments",
            express.json({ limit: Math.ceil(maxBytes / 3) * 4 + 65_536 }),
        );
        // Maps the parser's own (raw-byte) rejections onto the same
        // AttachmentTooLarge shape the route answers with (R10).
        app.use(
            "/api/attachments",
            attachmentBodyTooLarge(appConfig, maxBytes),
        );
    }

    app.use(express.json());

    // Runtime contract gate: /api request shapes always, /api + /health
    // response shapes only under JARVIS_API_CONTRACT=verify (see the module).
    mountContractValidator(app, appConfig.apiContractVerify === true);

    app.get("/health", (req, res) => {
        res.status(200).json({ ok: true });
    });

    // The attachments router mounts after the validator (so its request and
    // response shapes stay contract-checked) but as its own path-scoped
    // router, ahead of the management API.
    if (attachments && inFlight) {
        app.use(
            "/api/attachments",
            createAttachmentRouter(store, appConfig, attachments, inFlight),
        );
    }

    app.use("/api", createAuthRouter(store, appConfig));

    // The local STT model route (#84 P3b): the client-side WASM engine's
    // archive, cached download-once under ~/.jarvis/stt when configured and
    // a JSON 404 when not. Public by design (open-source weights, not user
    // data; the recognition worker cannot attach auth headers).
    app.get(
        "/api/stt/model",
        createSttModelHandler(
            appConfig.stt ? new SttModelCache(appConfig.stt) : null,
        ),
    );

    // The local wake-word model route (#84 P4): the client-side
    // openWakeWord detector's three ONNX files, each cached download-once
    // under ~/.jarvis/wake when configured and a JSON 404 when not (or for
    // a file outside the allowlist). `HEAD` answers a bare 200 from
    // configuration alone — the web client's capability probe, which must
    // not trigger a download. Public by design (open-source weights, not
    // user data; the detector's worker cannot attach auth headers).
    app.get(
        "/api/wake/model/:file",
        createWakeModelHandler(
            appConfig.wake ? new WakeModelCache(appConfig.wake) : null,
        ),
    );

    const webIndex = appConfig.webDir
        ? path.join(appConfig.webDir, "index.html")
        : null;
    const webMounted = Boolean(webIndex && existsSync(webIndex));
    if (webMounted) {
        logger.info(
            `serving web chat client from ${appConfig.webDir} (index.html found)`,
        );
        // The web client renders remote (https) images from the model, dials
        // the same-origin `/ws` socket, and runs the local speech engine in a
        // same-origin module worker (#84 P3b), so its CSP widens `img-src`
        // beyond the portal's `'self' data:` posture, adds this request's
        // ws/wss origin, declares the worker source, and allows Wasm
        // compilation (`'wasm-unsafe-eval'` — JS eval stays blocked) for the
        // engine's Kaldi binary.
        app.use(
            "/web",
            spaSecurityHeaders({
                remoteImages: true,
                websocketOrigins: true,
                workerSrc: true,
                wasmUnsafeEval: true,
            }),
        );
        // The speech engine's worker script carries its own CSP. embind's
        // runtime additionally synthesizes a per-method invoker function
        // with `new Function` on first call (`craftInvokerFunction` — a
        // second eval site the fork cannot remove), and a dedicated worker
        // whose entry script declares a Content-Security-Policy runs under
        // that policy instead of the owner's, so granting `'unsafe-eval'`
        // here scopes it to this hashed, same-origin module — the page
        // itself never evaluates strings.
        const workerScriptCsp =
            "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'";
        app.use("/web", (req, res, next) => {
            if (/^\/assets\/vosk\.worker-[A-Za-z0-9_-]+\.js$/.test(req.path)) {
                res.setHeader("Content-Security-Policy", workerScriptCsp);
            }
            next();
        });
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
    /**
     * Whether `script-src` additionally allows `'wasm-unsafe-eval'`. The
     * chat client's local speech engine (#84 P3b) compiles its WASM binary
     * inside a same-origin module worker; workers inherit the owner page's
     * `script-src`, and WebAssembly compilation counts as "eval" to the CSP
     * spec, so `script-src 'self'` blocks it. `'wasm-unsafe-eval'` grants
     * Wasm compile/instantiate *only* — JS `eval`/`new Function` stay
     * blocked. The portal runs no Wasm and keeps the strict posture.
     */
    wasmUnsafeEval?: boolean;
    /**
     * Whether `worker-src 'self';` is added. The chat client's local speech
     * engine (#84 P3b) runs in a module worker served from the same origin
     * (`vosk.worker.js`, bundled with the SPA); the explicit directive
     * documents that and decouples worker loading from `script-src`. The
     * portal runs no workers and keeps the strict posture.
     */
    workerSrc?: boolean;
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
    workerSrc: withWorkerSrc = false,
    wasmUnsafeEval: withWasmUnsafeEval = false,
}: SpaSecurityHeaderOptions = {}) {
    return (req: Request, res: Response, next: NextFunction) => {
        const imgSrc = remoteImages
            ? "img-src 'self' data: https:"
            : "img-src 'self' data:";
        const workerSrc = withWorkerSrc ? "worker-src 'self'; " : "";
        const scriptSrc = withWasmUnsafeEval
            ? "script-src 'self' 'wasm-unsafe-eval'; "
            : "script-src 'self'; ";
        const host = req.headers.host;
        const socketOrigins =
            websocketOrigins &&
            typeof host === "string" &&
            /^[\w.-]+(:\d+)?$/.test(host)
                ? ` ws://${host} wss://${host}`
                : "";
        res.setHeader(
            "Content-Security-Policy",
            `default-src 'self'; ${scriptSrc}style-src 'self' 'unsafe-inline'; ${workerSrc}${imgSrc}; connect-src 'self'${socketOrigins}`,
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
