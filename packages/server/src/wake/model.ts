/**
 * Local wake-word model serving (issue #84, phase 4) — the server half of
 * the client-side openWakeWord detector.
 *
 * The web client's wake-word engine loads three ONNX files — the two shared
 * feature models (`melspectrogram.onnx`, `embedding_model.onnx`) plus the
 * `hey_jarvis` classifier (`hey_jarvis_v0.1.onnx`) — from
 * `GET /api/wake/model/<file>`. This module owns the server side of that
 * route: each file is fetched from the configured upstream
 * (`JARVIS_WAKE_MODEL_URL` base) exactly once, cached privately under
 * `~/.jarvis/wake` (mirroring the STT archive cache under `~/.jarvis/stt`),
 * and streamed from the cache after that — so a deployment needs external
 * egress only on the first client request, and the model weights
 * (open-source, never user data) travel same-origin to the browser. Serving
 * same-origin is also required by CORS: the upstream GitHub release assets
 * send no `Access-Control-Allow-Origin`, so a browser fetch from the page
 * would be blocked.
 *
 * Download-once semantics are deliberately lazy and retry-friendly, like the
 * STT archive: the fetch happens on the first request for a given file (not
 * at boot), concurrent requests for the same file collapse into one
 * download, a failed fetch rejects every waiter and resets so the next
 * request retries, and a partial download never lands in the cache (it is
 * written to a temp file and renamed). Serving is unauthenticated by design:
 * the model is not user data, and the detector's worker cannot attach auth
 * headers to its fetch.
 *
 * Only the three known files are served — the route parameter is validated
 * against {@link WAKE_MODEL_FILES}, so the handler can never be used as an
 * open proxy for arbitrary upstream paths. The route handler is built here
 * too (`createWakeModelHandler`) so the contract surface and the cache live
 * side by side and tests can drive the handler without the whole app.
 */
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { ensurePrivateDir, ensurePrivateFile } from "@lukestanbery/jarvis-auth";
import type { RequestHandler } from "express";
import type { WakeModelConfig } from "../config";
import { logger } from "../logger";

/**
 * The exact files the client's openWakeWord engine loads: the two shared
 * feature models and the `hey_jarvis` classifier. The route only serves
 * these, so the `:file` parameter is never an arbitrary upstream path.
 */
export const WAKE_MODEL_FILES = [
    "melspectrogram.onnx",
    "embedding_model.onnx",
    "hey_jarvis_v0.1.onnx",
] as const;

/** A served wake-model file name. */
export type WakeModelFile = (typeof WAKE_MODEL_FILES)[number];

/**
 * Whether a route parameter names a file the server is willing to serve.
 *
 * @param file - The untrusted `:file` route parameter.
 * @returns True when the name is on the {@link WAKE_MODEL_FILES} allowlist.
 */
export function isWakeModelFile(file: string): file is WakeModelFile {
    return (WAKE_MODEL_FILES as readonly string[]).includes(file);
}

/**
 * Fetches a model file from a URL. Injectable so tests never touch the
 * network; defaults to the platform `fetch` (Node 24 global).
 */
export type ModelFetcher = (url: string) => Promise<Response>;

/** The real fetcher: the platform global. */
const defaultFetcher: ModelFetcher = (url) => fetch(url);

/**
 * The per-file download-once model cache. One instance per server;
 * `path(file)` is the single entry point (cache hit, or one collapsed
 * download per file — the three files download independently).
 */
export class WakeModelCache {
    private readonly config: WakeModelConfig;
    private readonly fetcher: ModelFetcher;
    /**
     * The collapsed in-flight downloads, keyed by file name; an entry is
     * reset on failure so callers retry.
     */
    private readonly inFlight = new Map<string, Promise<string>>();

    /**
     * @param config - Where the files come from and where they cache.
     * @param fetcher - Fetch override for tests.
     */
    constructor(config: WakeModelConfig, fetcher?: ModelFetcher) {
        this.config = config;
        this.fetcher = fetcher ?? defaultFetcher;
    }

    /** The file's absolute cache path. */
    targetPath(file: WakeModelFile): string {
        return path.join(this.config.modelDir, file);
    }

    /**
     * Resolves a file's cache path: a cache hit returns immediately;
     * otherwise one download runs and every concurrent caller for that same
     * file awaits it. A failed download rejects every waiter and resets, so
     * the next request retries.
     *
     * @param file - The allowlisted file to resolve.
     * @returns The absolute path of the cached file.
     */
    async path(file: WakeModelFile): Promise<string> {
        const target = this.targetPath(file);
        if (existsSync(target)) {
            return target;
        }
        const inFlight = this.inFlight.get(file);
        if (inFlight !== undefined) {
            return inFlight;
        }
        const download = this.download(file).catch((err: unknown) => {
            this.inFlight.delete(file);
            throw err;
        });
        this.inFlight.set(file, download);
        return download;
    }

    /**
     * Fetches one file upstream and lands it in the private cache. Written
     * to a temp name and renamed, so a partial or failed download never
     * masquerades as a cached model.
     *
     * @param file - The allowlisted file to download.
     * @returns The absolute path of the cached file.
     */
    private async download(file: WakeModelFile): Promise<string> {
        ensurePrivateDir(this.config.modelDir);
        const target = this.targetPath(file);
        const response = await this.fetcher(this.upstreamUrl(file));
        if (!response.ok) {
            throw new Error(
                `the wake model upstream answered HTTP ${response.status}`,
            );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const tempPath = `${target}.tmp`;
        await fsp.writeFile(tempPath, bytes);
        await fsp.rename(tempPath, target);
        ensurePrivateFile(target);
        return target;
    }

    /**
     * The upstream URL for a file (base, trailing slash dropped). Extracted
     * so `download` and any caller agree on the join.
     *
     * @param file - The allowlisted file.
     * @returns The absolute upstream URL.
     */
    private upstreamUrl(file: WakeModelFile): string {
        return `${this.config.baseUrl.replace(/\/+$/, "")}/${file}`;
    }
}

/**
 * Builds the `GET`/`HEAD /api/wake/model/:file` handler (contract
 * `wakeModelGet`): the cached file with long-lived caching headers, a JSON
 * 404 for an unknown file or when wake model serving is unconfigured, a bare
 * 200 for `HEAD` (the client's capability probe — no download is triggered),
 * and a JSON 503 when the upstream download failed (transient — the next
 * request retries).
 *
 * @param cache - The configured cache, or `null` when `JARVIS_WAKE_PROVIDER`
 * is unset.
 * @returns The Express request handler.
 */
export function createWakeModelHandler(
    cache: WakeModelCache | null,
): RequestHandler {
    return (req, res) => {
        const file = req.params.file;
        if (typeof file !== "string" || !isWakeModelFile(file)) {
            res.status(404).json({ error: "unknown wake model file" });
            return;
        }
        if (cache === null) {
            res.status(404).json({
                error: "wake model serving is not configured (JARVIS_WAKE_PROVIDER unset)",
            });
            return;
        }
        // A HEAD is the client's "is wake supported here?" probe: answer
        // from configuration alone so it never triggers a multi-megabyte
        // download just to toggle a UI switch.
        if (req.method === "HEAD") {
            res.status(200).end();
            return;
        }
        void cache
            .path(file)
            .then((modelPath) => {
                res.setHeader("Content-Type", "application/octet-stream");
                // The file only changes when the server's configuration
                // does; letting browsers cache it keeps repeat visits cheap.
                res.setHeader("Cache-Control", "public, max-age=86400");
                // `res.sendFile` uses `send`, whose default `dotfiles:
                // "ignore"` shield hides any path segment beginning with a
                // dot — our private cache lives under `~/.jarvis/wake`, so
                // the `.jarvis` segment would 404. The path is composed of
                // the configured model dir plus an allowlisted file name (no
                // separators), so it cannot escape that dir; allowing
                // dotfiles just un-hides the intentionally private location.
                res.sendFile(modelPath, { dotfiles: "allow" });
            })
            .catch((err: unknown) => {
                res.status(503).json({
                    error: "the wake model is temporarily unavailable",
                });
                if (err instanceof Error) {
                    logger.warn(
                        `wake model download failed (${file}): ${err.message}`,
                    );
                }
            });
    };
}
