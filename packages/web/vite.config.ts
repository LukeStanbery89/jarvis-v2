import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
    copyVoiceAssets,
    findPackageRoot,
} from "./scripts/copy-voice-assets.mjs";

// Aliasing note: `openwakeword-web` exports ESM-only with no `require`
// entry, and `onnxruntime-web` is pulled in under the "extern wasm" resolve
// condition, so both are aliased to their raw sources below — located by
// the shared `findPackageRoot` from the asset copier (#107 P7).
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWW_SRC = path.join(
    findPackageRoot("openwakeword-web", CONFIG_DIR),
    "src",
);
/**
 * The protocol's TypeScript sources: the workspace package next door, not a
 * node_modules dependency (`findPackageRoot` above looks there; a sibling is a
 * plain relative walk) — and `..`, not `../..`, because `CONFIG_DIR` is
 * `packages/web`.
 */
const PROTOCOL_SRC = path.resolve(CONFIG_DIR, "..", "protocol", "src");

/**
 * Stamps the service worker with this build's id (#189).
 *
 * `public/sw.js` is copied verbatim by Vite, so its `__JARVIS_BUILD__`
 * placeholder has to be replaced in the output. A per-build cache name lets
 * the worker delete the previous shell cache on activation instead of carrying
 * every retired hashed asset forever. The replacement happens in
 * `closeBundle`, after Vite has copied `public/` into `dist/`.
 */
function serviceWorkerBuildPlugin(): Plugin {
    return {
        name: "jarvis-service-worker-version",
        apply: "build",
        closeBundle() {
            const file = path.join(CONFIG_DIR, "dist", "sw.js");
            if (!existsSync(file)) {
                return;
            }
            const source = readFileSync(file, "utf8");
            if (!source.includes("__JARVIS_BUILD__")) {
                return;
            }
            writeFileSync(
                file,
                source.split("__JARVIS_BUILD__").join(Date.now().toString(36)),
            );
        },
    };
}

/**
 * Dev server for the web app.
 *
 * The built SPA is served by the JARVIS server at `/` (see
 * `packages/server/src/app.ts`): it is the app's front door, so `base` is `/`
 * and every asset and route lives directly under the origin. `npm run dev`
 * serves the app on Vite's default port with HMR and proxies `/api` and `/ws`
 * (with WebSocket upgrade) to the running JARVIS server, so the app dials the
 * same same-origin URLs it will use in production.
 *
 * (Until #90 phase 6a the client lived at `/web` with `base: "/web/"`, and the
 * server 301s that path to `/`.)
 *
 * `@lukestanbery/jarvis-voice` is a linked workspace package whose build output
 * is CommonJS. Linked deps skip Vite's automatic pre-bundling, so in dev it would
 * otherwise be served raw and crash in the browser (`exports is not defined` — a
 * blank page; `vite build` bundles it fine). Listing it in
 * `optimizeDeps.include` forces the CJS→ESM pre-bundle.
 *
 * `@lukestanbery/jarvis-protocol` used to be listed there for the same reason,
 * and is now aliased to its sources instead (#90 phase 8e): the forced bundle is
 * keyed on *this file*, not on the linked package's output, so a rebuild was
 * invisible — and Vite serves dep bundles `immutable`, so the browser held the
 * stale copy at an unchanged URL. Aliasing a pure TypeScript package costs
 * nothing and cannot go stale. Voice carries the caveat still: after rebuilding
 * it, hard-reload the browser.
 */
export default defineConfig({
    plugins: [
        react(),
        {
            // Stage the ORT/openWakeWord runtime assets under `public/ort/`
            // for both dev and build (#84 P4; see copy-voice-assets.mjs).
            name: "jarvis-voice-assets",
            buildStart() {
                copyVoiceAssets();
            },
        },
        serviceWorkerBuildPlugin(),
    ],
    base: "/",
    resolve: {
        // `onnxruntime-web` ships a "use extern wasm" variant that loads its
        // wasm pair from `wasmPaths` at runtime instead of bundling it —
        // otherwise Vite emits a duplicate 28 MB wasm asset next to the
        // staged `public/ort/` copy.
        conditions: ["onnxruntime-web-use-extern-wasm"],
        alias: [
            {
                // The protocol is aliased to its **source**, not pre-bundled
                // (#90 phase 8e). It is pure TypeScript with no runtime deps, so
                // Vite compiles it directly — and that is what makes a rebuild
                // visible: a forced pre-bundle is content-addressed by *this
                // config*, so editing the package produced a new bundle at the
                // same URL, which Vite then serves `immutable` for a year. The
                // browser kept the old copy, and the first new *export* to land
                // in it (`parseJobRepeat`) crashed the reminders page with `is
                // not a function` until the cache was cleared by hand.
                //
                // Bare entry only, like the two below: a subpath import must not
                // be swallowed by the prefix match.
                find: /^@lukestanbery\/jarvis-protocol$/,
                replacement: path.join(PROTOCOL_SRC, "index.ts"),
            },
            {
                // Bare entry only — an unanchored find would swallow
                // `openwakeword-web/microphone` too (rolldown aliases match
                // by prefix).
                find: /^openwakeword-web$/,
                replacement: path.join(OWW_SRC, "openwakeword.js"),
            },
            {
                find: /^openwakeword-web\//,
                replacement: `${OWW_SRC}/`,
            },
        ],
    },
    optimizeDeps: {
        include: [
            // The protocol is deliberately *not* here: it is aliased to its
            // sources above, which is what keeps a rebuild visible. Voice still
            // is, because its dist is CommonJS and Vite cannot compile it as-is —
            // so it carries the same cache caveat: after rebuilding voice, hard
            // reload (`the dep bundle is served immutable at a URL that does not
            // change`).
            "@lukestanbery/jarvis-voice",
        ],
    },
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
            /**
             * The admin portal is a **different app** on the real server
             * (`/admin`, cookie auth — see `packages/server/src/app.ts`), and
             * the launcher links to it. Without this proxy the dev server
             * answers `/admin` with *this* app's shell, which renders the
             * launcher (an unknown path), so the link appeared to go nowhere
             * while production was correct. Proxying keeps dev and production
             * agreeing on every address the app links to.
             */
            "/admin": {
                target: "http://localhost:54321",
                changeOrigin: false,
            },
        },
    },
    build: {
        outDir: "dist",
    },
});
