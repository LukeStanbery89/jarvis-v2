import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyVoiceAssets } from "./scripts/copy-voice-assets.mjs";

/**
 * Locates an installed package's directory by walking `node_modules`
 * upward. openwakeword-web exports ESM-only with no `require` entry, and
 * `onnxruntime-web` is pulled in under the "extern wasm" resolve condition,
 * so both are aliased to their raw sources below.
 */
function findPackageRoot(name: string, fromDir: string): string {
    let dir = fromDir;
    for (;;) {
        const candidate = path.join(dir, "node_modules", name, "package.json");
        if (existsSync(candidate)) {
            return path.dirname(candidate);
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`${name} not found above ${fromDir}`);
        }
        dir = parent;
    }
}

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWW_SRC = path.join(
    findPackageRoot("openwakeword-web", CONFIG_DIR),
    "src",
);

/**
 * Dev server for the web chat client.
 *
 * The built SPA is served by the JARVIS server at `/web` (see
 * `packages/server/src/app.ts`), so `base` is `/web/` and every asset and
 * route lives under that prefix. `npm run dev` serves the client on Vite's
 * default port with HMR and proxies `/api` and `/ws` (with WebSocket upgrade)
 * to the running JARVIS server, so the client dials the same same-origin
 * URLs it will use in production.
 *
 * `@lukestanbery/jarvis-protocol` is a linked workspace package whose build
 * output is CommonJS. Linked deps skip Vite's automatic pre-bundling, so in
 * dev it would otherwise be served raw and crash in the browser
 * (`exports is not defined` — a blank page; `vite build` bundles it fine).
 * Listing it in `optimizeDeps.include` forces the CJS→ESM pre-bundle.
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
    ],
    base: "/web/",
    resolve: {
        // `onnxruntime-web` ships a "use extern wasm" variant that loads its
        // wasm pair from `wasmPaths` at runtime instead of bundling it —
        // otherwise Vite emits a duplicate 28 MB wasm asset next to the
        // staged `public/ort/` copy.
        conditions: ["onnxruntime-web-use-extern-wasm"],
        alias: [
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
            "@lukestanbery/jarvis-protocol",
            // Same situation as the protocol: a linked workspace package
            // whose build output is CommonJS. Without the forced pre-bundle
            // the dev server serves voice's dist raw and every named import
            // from it fails ("does not provide an export named …").
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
        },
    },
    build: {
        outDir: "dist",
    },
});
