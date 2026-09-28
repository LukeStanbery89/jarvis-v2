import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev server for the web chat client.
 *
 * The built SPA is served by the JARVIS server at `/web` (see
 * `packages/server/src/app.ts`), so `base` is `/web/` and every asset and
 * route lives under that prefix. `npm run dev` serves the client on Vite's
 * default port with HMR and proxies `/api` and `/ws` (with WebSocket upgrade)
 * to the running JARVIS server, so the client dials the same same-origin
 * URLs it will use in production.
 */
export default defineConfig({
    plugins: [react()],
    base: "/web/",
    server: {
        proxy: {
            "/api": {
                target: "http://localhost:54321",
                changeOrigin: false,
            },
            "/ws": {
                target: "ws://localhost:54321",
                ws: true,
            },
        },
    },
    build: {
        outDir: "dist",
    },
});
