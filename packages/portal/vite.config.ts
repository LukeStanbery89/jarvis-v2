import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev server for the portal SPA.
 *
 * `npm run dev` serves the portal on Vite's default port with HMR and proxies
 * every `/api` request to the running JARVIS server, so the `jarvis_session`
 * cookie and its origin stay same-site during development. Production builds
 * emit plain static assets that the server itself serves from `/`.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/api": {
                target: "http://localhost:54321",
                changeOrigin: false,
            },
        },
    },
    build: {
        outDir: "dist",
    },
});
