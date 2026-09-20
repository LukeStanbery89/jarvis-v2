import express from "express";

/**
 * Creates the Express app that serves the HTTP endpoints.
 *
 * Kept as a factory (rather than a module-level app) so tests can import it
 * via supertest without binding a port. The network bootstrap lives in
 * `index.ts`.
 */
export function createApp() {
    console.info("[INFO] Creating Express app...");
    const app = express();
    app.use(express.json());

    console.info("[INFO] Registering HTTP endpoints...");
    app.get("/", (req, res) => {
        res.send("Hello World");
    });

    console.info("[INFO] Registered HTTP endpoints successfully ✓");
    console.info("[INFO] Express app created successfully ✓");
    return app;
}
