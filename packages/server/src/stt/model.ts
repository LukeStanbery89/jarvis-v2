/**
 * Local STT model serving (issue #84, phase 3b) — the server half of the
 * client-side WASM speech engine.
 *
 * The web client's Vosk engine downloads its model archive (~40 MB tar.gz
 * of the model folder) from `GET /api/stt/model`. The serving machinery —
 * download-once cache, in-flight collapse, streamed temp-file-then-rename
 * write, private-cache posture, and the 200/404/503 route behavior — is the
 * shared `src/modelFileCache.ts` (issue #107 P3); this module is the STT
 * spec on top of it: the single archive key derived (and sanitized) from
 * `JARVIS_STT_MODEL_URL`, and the route's messages/content type.
 *
 * The archive is fetched from the configured upstream exactly once, cached
 * privately under `~/.jarvis/stt` (mirroring the TTS weights cache under
 * `~/.jarvis/tts`), and streamed from the cache after that — so a
 * deployment needs external egress only on the first client request, and
 * the archive (open-source model weights, never user data) travels
 * same-origin to the browser. Serving is unauthenticated by design: the
 * recognition worker cannot attach auth headers to its fetch.
 */
import type { RequestHandler } from "express";
import type { SttModelConfig } from "../config";
import {
    createModelFileHandler,
    ModelFileCache,
    type ModelFetcher,
} from "../modelFileCache";

/**
 * The STT cache's single file key — the spec derives the real file name
 * from the configured upstream URL, so the key itself carries no meaning.
 */
const STT_KEY = "";

/** The fallback archive name when the upstream URL is unusable. */
const DEFAULT_STT_FILE_NAME = "model.tar.gz";

/**
 * Derives the archive's cached file name from the upstream URL path,
 * sanitized to a safe file-system name (`vosk-model-…tar.gz`).
 *
 * @param modelUrl - The configured upstream archive URL.
 * @returns The safe file name.
 */
function sttFileName(modelUrl: string): string {
    try {
        const base = new URL(modelUrl).pathname.split("/").pop();
        const safe = (base ?? "").replace(/[^\w.-]/g, "_");
        // The sanitizer keeps dots, so a URL ending in `.` or `..`
        // sanitizes to a relative segment — `path.join` would then land
        // outside the cache dir, breaking the stated invariant. Fall
        // back to the default name.
        return safe === "" || safe === "." || safe === ".."
            ? DEFAULT_STT_FILE_NAME
            : safe;
    } catch {
        return DEFAULT_STT_FILE_NAME;
    }
}

/**
 * The download-once STT archive cache. One instance per server; `path()` is
 * the single entry point (cache hit, or one collapsed download). A thin
 * single-key wrapper over the shared {@link ModelFileCache}.
 */
export class SttModelCache {
    /** The wrapped shared cache (single key). */
    readonly inner: ModelFileCache;
    /** The configured upstream archive URL (fileName derives from it). */
    private readonly modelUrl: string;

    /**
     * @param config - Where the archive comes from and where it caches.
     * @param fetcher - Fetch override for tests.
     */
    constructor(config: SttModelConfig, fetcher?: ModelFetcher) {
        this.modelUrl = config.modelUrl;
        this.inner = new ModelFileCache(
            {
                modelDir: config.modelDir,
                upstreamLabel: "model",
                fileName: () => sttFileName(config.modelUrl),
                upstreamUrl: () => config.modelUrl,
            },
            fetcher,
        );
    }

    /**
     * The cached archive's file name, derived from the upstream URL path
     * and sanitized to a safe file-system name (`vosk-model-…tar.gz`).
     */
    get fileName(): string {
        return sttFileName(this.modelUrl);
    }

    /** The archive's absolute cache path. */
    get targetPath(): string {
        return this.inner.targetPath(STT_KEY);
    }

    /**
     * Resolves the archive path: a cache hit returns immediately;
     * otherwise one download runs and every concurrent caller awaits it.
     * A failed download rejects every waiter and resets, so the next
     * request retries.
     *
     * @returns The absolute path of the cached archive.
     */
    path(): Promise<string> {
        return this.inner.path(STT_KEY);
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
    return createModelFileHandler({
        cache: cache === null ? null : cache.inner,
        contentType: "application/gzip",
        notConfiguredMessage:
            "speech model serving is not configured (JARVIS_STT_PROVIDER unset)",
        unavailableMessage: "the speech model is temporarily unavailable",
        logLabel: "STT model",
    });
}
