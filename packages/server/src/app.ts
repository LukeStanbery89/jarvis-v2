import express from "express";
import type { ErrorRequestHandler } from "express";
import type { AppConfig } from "./config";
import type { AppDatabase } from "@lukestanbery/jarvis-auth";
import { createAuthRouter } from "./http/authRoutes";

/**
 * Creates the Express app that serves the HTTP endpoints.
 *
 * Kept as a factory (rather than a module-level app) so tests can import it
 * via supertest without binding a port. The network bootstrap lives in
 * `index.ts`. `store` backs the `/api` management routes and `appConfig`
 * supplies their settings.
 */
export function createApp(store: AppDatabase, appConfig: AppConfig) {
    const app = express();
    app.use(express.json());

    app.get("/", (req, res) => {
        res.send("Hello World");
    });

    app.use("/api", createAuthRouter(store, appConfig));

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
    next(err);
};
