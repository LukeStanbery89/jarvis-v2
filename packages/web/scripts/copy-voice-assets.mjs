/**
 * Copies the wake-word runtime assets into `packages/web/public/ort/` (#84 P4).
 *
 * The chat client cannot import these with Vite's `?url` — both packages gate
 * their internals behind `exports` maps — so the build stages them as static
 * files under the `/web/ort/` directory the client derives at runtime:
 *
 * - `mic-worklet.js`          — openwakeword-web's AudioWorklet processor; its
 *   own `new URL(..., import.meta.url)` default resolves inside the bundle.
 * - `ort-wasm-simd-threaded.jsep.{mjs,wasm}` — the ONNX Runtime Web assets
 *   that `ort.bundle.min.mjs` (the `onnxruntime-web` browser entry) actually
 *   fetches, resolved against the `wasmPaths` prefix the provider passes.
 *
 * Runs on Vite `buildStart` (dev server + `vite build`) and standalone via
 * `node scripts/copy-voice-assets.mjs`. Throws when a source file is missing
 * so a broken install fails the build instead of 404ing at wake-arm time.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const WEB_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const OUT_DIR = path.join(WEB_ROOT, "public", "ort");

/**
 * Locates an installed package's directory by walking `node_modules` upward
 * from `fromDir` — bypasses `exports` maps (which hide `package.json`).
 *
 * @param {string} name - Package name to find.
 * @param {string} fromDir - Directory to start the upward walk at.
 * @returns {string} The package's root directory.
 */
function findPackageRoot(name, fromDir) {
    let dir = fromDir;
    for (;;) {
        const candidate = path.join(dir, "node_modules", name, "package.json");
        if (existsSync(candidate)) {
            return path.dirname(candidate);
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(
                `copy-voice-assets: ${name} not found above ${fromDir}`,
            );
        }
        dir = parent;
    }
}

/**
 * Stages the wake-word runtime assets into `public/ort/`.
 *
 * @returns {string[]} The destination paths written (for logging).
 */
export function copyVoiceAssets() {
    const owwRoot = findPackageRoot("openwakeword-web", WEB_ROOT);
    // Resolve ORT the same way openwakeword-web will at runtime, so the
    // staged files always match the bundle the browser loads.
    const require = createRequire(path.join(owwRoot, "package.json"));
    const ortRoot = path.dirname(
        path.dirname(require.resolve("onnxruntime-web")),
    );

    const files = [
        [path.join(owwRoot, "src", "mic-worklet.js"), "mic-worklet.js"],
        [
            path.join(ortRoot, "dist", "ort-wasm-simd-threaded.jsep.mjs"),
            "ort-wasm-simd-threaded.jsep.mjs",
        ],
        [
            path.join(ortRoot, "dist", "ort-wasm-simd-threaded.jsep.wasm"),
            "ort-wasm-simd-threaded.jsep.wasm",
        ],
    ];
    mkdirSync(OUT_DIR, { recursive: true });
    const written = [];
    for (const [src, name] of files) {
        if (!existsSync(src)) {
            throw new Error(`copy-voice-assets: missing ${src}`);
        }
        const dest = path.join(OUT_DIR, name);
        copyFileSync(src, dest);
        written.push(dest);
    }
    return written;
}

// Standalone invocation (not when imported by vite.config.ts).
if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    for (const file of copyVoiceAssets()) {
        console.log(`copy-voice-assets: ${path.relative(WEB_ROOT, file)}`);
    }
}
