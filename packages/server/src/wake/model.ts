/**
 * Local wake-word model serving (issue #84, phase 4) — the server half of
 * the client-side openWakeWord detector.
 *
 * The web client's wake-word engine loads three ONNX files — the two shared
 * feature models (`melspectrogram.onnx`, `embedding_model.onnx`) plus the
 * `hey_jarvis` classifier (`hey_jarvis_v0.1.onnx`) — from
 * `GET /api/wake/model/<file>`. The serving machinery — per-file
 * download-once cache, in-flight collapse, streamed temp-file-then-rename
 * write, private-cache posture, and the 200/404/503 route behavior — is the
 * shared `src/modelFileCache.ts` (issue #107 P3); this module is the wake
 * spec on top of it: the three-file allowlist, the base-URL join, and the
 * route's messages/content type.
 *
 * Each file is fetched from the configured upstream (`JARVIS_WAKE_MODEL_URL`
 * base) exactly once, cached privately under `~/.jarvis/wake` (mirroring the
 * STT archive cache under `~/.jarvis/stt`), and streamed from the cache
 * after that — so a deployment needs external egress only on the first
 * client request, and the model weights (open-source, never user data)
 * travel same-origin to the browser. Serving same-origin is also required
 * by CORS: the upstream GitHub release assets send no
 * `Access-Control-Allow-Origin`, so a browser fetch from the page would be
 * blocked. Serving is unauthenticated by design: the detector's worker
 * cannot attach auth headers to its fetch.
 *
 * Only the three known files are served — the route parameter is validated
 * against {@link WAKE_MODEL_FILES}, so the handler can never be used as an
 * open proxy for arbitrary upstream paths.
 */
import type { Request, RequestHandler } from "express";
import type { WakeModelConfig } from "../config";
import {
    createModelFileHandler,
    ModelFileCache,
    type ModelFetcher,
} from "../modelFileCache";

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
 * The per-file download-once model cache. One instance per server;
 * `path(file)` is the single entry point (cache hit, or one collapsed
 * download per file — the three files download independently). A thin
 * allowlist-keyed wrapper over the shared {@link ModelFileCache}.
 */
export class WakeModelCache {
    /** The wrapped shared cache (keyed by allowlisted file name). */
    readonly inner: ModelFileCache;

    /**
     * @param config - Where the files come from and where they cache.
     * @param fetcher - Fetch override for tests.
     */
    constructor(config: WakeModelConfig, fetcher?: ModelFetcher) {
        this.inner = new ModelFileCache(
            {
                modelDir: config.modelDir,
                upstreamLabel: "wake model",
                // The key is an allowlisted plain file name — already separator-free.
                fileName: (file) => file,
                upstreamUrl: (file) =>
                    `${config.baseUrl.replace(/\/+$/, "")}/${file}`,
            },
            fetcher,
        );
    }

    /** The file's absolute cache path. */
    targetPath(file: WakeModelFile): string {
        return this.inner.targetPath(file);
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
    path(file: WakeModelFile): Promise<string> {
        return this.inner.path(file);
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
    return createModelFileHandler({
        cache: cache === null ? null : cache.inner,
        contentType: "application/octet-stream",
        notConfiguredMessage:
            "wake model serving is not configured (JARVIS_WAKE_PROVIDER unset)",
        unavailableMessage: "the wake model is temporarily unavailable",
        logLabel: "wake model",
        requestKey: (req: Request) => {
            const file = req.params.file;
            return typeof file === "string" && isWakeModelFile(file)
                ? file
                : null;
        },
        unknownFileMessage: "unknown wake model file",
        headProbe: true,
    });
}
