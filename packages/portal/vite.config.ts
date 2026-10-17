import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev server for the admin portal SPA.
 *
 * `npm run dev` serves the portal on Vite's default port with HMR and proxies
 * every `/api` request to the running JARVIS server, so the `jarvis_session`
 * cookie and its origin stay same-site during development. Production builds
 * emit plain static assets that the server serves from `/admin` (#90 phase
 * 6a moved it there; the app's front door is `/`), so `base` matches that
 * mount and the dev server answers under the same path.
 */
export default defineConfig({
    plugins: [react()],
    base: "/admin/",
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
