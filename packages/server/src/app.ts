import express from "express";
import type { ErrorRequestHandler } from "express";
import type { AppConfig } from "./config";
import type { AppStore } from "./auth";
import { createAuthRouter } from "./http/authRoutes";

/**
 * Creates the Express app that serves the HTTP endpoints.
 *
 * Kept as a factory (rather than a module-level app) so tests can import it
 * via supertest without binding a port. The network bootstrap lives in
 * `index.ts`. `store` backs the `/api` management routes and `appConfig`
 * supplies their settings.
 */
export function createApp(store: AppStore, appConfig: AppConfig) {
    const app = express();
    app.use(express.json());

    app.get("/", (req, res) => {
        res.send("Hello World");
    });

    app.use("/api", createAuthRouter(store, appConfig));

    app.use(jsonErrorHandler);

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
