/**
 * Local STT model serving (issue #84, phase 3b) — the server half of the
 * client-side WASM speech engine.
 *
 * The web client's Vosk engine downloads its model archive (~40 MB tar.gz
 * of the model folder) from `GET /api/stt/model`. This module owns the
 * server side of that route: the archive is fetched from the configured
 * upstream (`JARVIS_STT_MODEL_URL`) exactly once, cached privately under
 * `~/.jarvis/stt` (mirroring the TTS weights cache under `~/.jarvis/tts`),
 * and streamed from the cache after that — so a deployment needs external
 * egress only on the first client request, and the archive (open-source
 * model weights, never user data) travels same-origin to the browser.
 *
 * Download-once semantics are deliberately lazy and retry-friendly, like
 * the Kokoro engine's weights: the fetch happens on the first model
 * request (not at boot), concurrent requests collapse into one download,
 * a failed fetch rejects every waiter and resets so the next request
 * retries, and a partial download never lands in the cache (it is written
 * to a temp file and renamed). Serving is unauthenticated by design: the
 * model is not user data, and the recognition worker cannot attach auth
 * headers to its fetch.
 *
 * The route handler is built here too (`createSttModelHandler`) so the
 * contract surface and the cache live side by side and tests can drive the
 * handler without the whole app.
 */
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { ensurePrivateDir, ensurePrivateFile } from "@lukestanbery/jarvis-auth";
import type { RequestHandler } from "express";
import type { SttModelConfig } from "../config";
import { logger } from "../logger";

/**
 * Fetches the model archive from a URL. Injectable so tests never touch
 * the network; defaults to the platform `fetch` (Node 24 global).
 */
export type ModelFetcher = (url: string) => Promise<Response>;

/** The real fetcher: the platform global. */
const defaultFetcher: ModelFetcher = (url) => fetch(url);

/**
 * The download-once model cache. One instance per server; `path()` is the
 * single entry point (cache hit, or one collapsed download).
 */
export class SttModelCache {
    private readonly config: SttModelConfig;
    private readonly fetcher: ModelFetcher;
    /** The collapsed in-flight download; reset on failure so callers retry. */
    private inFlight: Promise<string> | null = null;

    /**
     * @param config - Where the archive comes from and where it caches.
     * @param fetcher - Fetch override for tests.
     */
    constructor(config: SttModelConfig, fetcher?: ModelFetcher) {
        this.config = config;
        this.fetcher = fetcher ?? defaultFetcher;
    }

    /**
     * The cached archive's file name, derived from the upstream URL path
     * and sanitized to a safe file-system name (`vosk-model-…tar.gz`).
     */
    get fileName(): string {
        try {
            const base = new URL(this.config.modelUrl).pathname
                .split("/")
                .pop();
            const safe = (base ?? "").replace(/[^\w.-]/g, "_");
            // The sanitizer keeps dots, so a URL ending in `.` or `..`
            // sanitizes to a relative segment — `path.join` would then land
            // outside the cache dir, breaking the stated invariant. Fall
            // back to the default name.
            return safe === "" || safe === "." || safe === ".."
                ? "model.tar.gz"
                : safe;
        } catch {
            return "model.tar.gz";
        }
    }

    /** The archive's absolute cache path. */
    get targetPath(): string {
        return path.join(this.config.modelDir, this.fileName);
    }

    /**
     * Resolves the archive path: a cache hit returns immediately;
     * otherwise one download runs and every concurrent caller awaits it.
     * A failed download rejects every waiter and resets, so the next
     * request retries.
     *
     * @returns The absolute path of the cached archive.
     */
    async path(): Promise<string> {
        if (existsSync(this.targetPath)) {
            return this.targetPath;
        }
        if (this.inFlight === null) {
            this.inFlight = this.download().catch((err: unknown) => {
                this.inFlight = null;
                throw err;
            });
        }
        return this.inFlight;
    }

    /**
     * Fetches the archive upstream and lands it in the private cache.
     * Written to a temp name and renamed, so a partial or failed download
     * never masquerades as a cached model.
     *
     * @returns The absolute path of the cached archive.
     */
    private async download(): Promise<string> {
        ensurePrivateDir(this.config.modelDir);
        const response = await this.fetcher(this.config.modelUrl);
        if (!response.ok) {
            throw new Error(
                `the model upstream answered HTTP ${response.status}`,
            );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const tempPath = `${this.targetPath}.tmp`;
        await fsp.writeFile(tempPath, bytes);
        await fsp.rename(tempPath, this.targetPath);
        ensurePrivateFile(this.targetPath);
        return this.targetPath;
    }
}

/**
 * Builds the `GET /api/stt/model` handler (contract `sttModelGet`): the
 * cached archive with long-lived caching headers, a JSON 404 when STT
 * model serving is unconfigured, and a JSON 503 when the upstream download
 * failed (transient — the next request retries).
 *
 * @param cache - The configured cache, or `null` when
 * `JARVIS_STT_PROVIDER` is unset.
 * @returns The Express request handler.
 */
export function createSttModelHandler(
    cache: SttModelCache | null,
): RequestHandler {
    return (_req, res) => {
        if (cache === null) {
            res.status(404).json({
                error: "speech model serving is not configured (JARVIS_STT_PROVIDER unset)",
            });
            return;
        }
        void cache
            .path()
            .then((modelPath) => {
                res.setHeader("Content-Type", "application/gzip");
                // The archive only changes when the server's configuration
                // does; letting browsers cache it keeps repeat visits cheap
                // even when the vosk worker re-fetches the URL.
                res.setHeader("Cache-Control", "public, max-age=86400");
                // `res.sendFile` uses `send`, whose default `dotfiles:
                // "ignore"` shield hides any path segment beginning with a
                // dot — our private cache lives under `~/.jarvis/stt`, so
                // the `.jarvis` segment would 404. The path is composed of
                // the configured model dir plus a sanitized URL basename
                // (`[\w.-]`, no slashes), so it cannot escape that dir;
                // allowing dotfiles just un-hides the intentionally private
                // location.
                res.sendFile(modelPath, { dotfiles: "allow" });
            })
            .catch((err: unknown) => {
                res.status(503).json({
                    error: "the speech model is temporarily unavailable",
                });
                if (err instanceof Error) {
                    logger.warn(`STT model download failed: ${err.message}`);
                }
            });
    };
}
