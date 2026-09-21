import express from "express";

/**
 * Creates the Express app that serves the HTTP endpoints.
 *
 * Kept as a factory (rather than a module-level app) so tests can import it
 * via supertest without binding a port. The network bootstrap lives in
 * `index.ts`.
 */
export function createApp() {
    const app = express();
    app.use(express.json());

    app.get("/", (req, res) => {
        res.send("Hello World");
    });

    return app;
}
