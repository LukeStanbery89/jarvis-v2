/**
 * Shared download-once model-file serving (issue #107 P3).
 *
 * The STT archive (`src/stt/model.ts`) and the wake-word ONNX files
 * (`src/wake/model.ts`) previously carried two hand-copied implementations
 * of the same machinery: a lazy download-once cache with in-flight
 * collapse, a temp-file-then-rename write, private-cache posture, and an
 * Express handler answering 200/404/503 with long-lived caching headers.
 * They now share the {@link ModelFileCache} + {@link createModelFileHandler}
 * implemented here and describe only their differences — where the bytes
 * come from, what a key means, and the route's messages — as a
 * {@link ModelFileSpec}.
 *
 * Two robustness upgrades are folded in (approved for #107): an upstream
 * fetch is bounded by {@link DEFAULT_DOWNLOAD_TIMEOUT_MS} (the old code
 * would wait on a hung upstream forever), and the body is streamed to disk
 * through `pipeline(Readable.fromWeb(...))` instead of buffered whole in
 * memory (the STT archive is ~40 MB).
 *
 * Serving posture is unchanged: the files are open-source model weights,
 * never user data, and the browser workers cannot attach auth headers —
 * the routes stay unauthenticated by design.
 */
import { existsSync, createWriteStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { ensurePrivateDir, ensurePrivateFile } from "@lukestanbery/jarvis-auth";
import type { Request, RequestHandler } from "express";
import { logger } from "./logger";

/** Hard deadline for one upstream model fetch (generous for ~40 MB). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;

/**
 * Fetches a model file from a URL. Injectable so tests never touch the
 * network; defaults to the platform `fetch` (Node 24 global). The optional
 * `init` carries the download's abort signal.
 */
export type ModelFetcher = (
    url: string,
    init?: { signal?: AbortSignal },
) => Promise<Response>;

/** The real fetcher: the platform global. */
const defaultFetcher: ModelFetcher = (url, init) => fetch(url, init);

/**
 * Describes one served model file family — the difference between the STT
 * archive and the wake-word files, expressed as data.
 */
export interface ModelFileSpec {
    /** The private cache directory (ensured `0700` before a download). */
    readonly modelDir: string;
    /**
     * The safe file-system name for a key: no separators, so the composed
     * cache path can never escape `modelDir`.
     */
    fileName(key: string): string;
    /** The upstream URL a key is fetched from. */
    upstreamUrl(key: string): string;
    /** Human label for logs and upstream-failure errors ("model", "wake model"). */
    readonly upstreamLabel: string;
    /** Hard deadline for one upstream fetch. Defaults to {@link DEFAULT_DOWNLOAD_TIMEOUT_MS}. */
    readonly downloadTimeoutMs?: number;
}

/**
 * The download-once model cache behind both the STT and wake routes.
 * `path(key)` is the single entry point: a cache hit returns immediately,
 * otherwise one download runs and every concurrent caller for that same key
 * awaits it. A failed download rejects every waiter and resets, so the next
 * request retries.
 */
export class ModelFileCache {
    private readonly spec: ModelFileSpec;
    private readonly fetcher: ModelFetcher;
    /**
     * The collapsed in-flight downloads, keyed by file key; an entry is
     * reset on failure so callers retry.
     */
    private readonly inFlight = new Map<string, Promise<string>>();

    /**
     * @param spec - Where the files come from and where they cache.
     * @param fetcher - Fetch override for tests.
     */
    constructor(spec: ModelFileSpec, fetcher?: ModelFetcher) {
        this.spec = spec;
        this.fetcher = fetcher ?? defaultFetcher;
    }

    /** A key's absolute cache path (the sanitized file name under the dir). */
    targetPath(key: string): string {
        return path.join(this.spec.modelDir, this.spec.fileName(key));
    }

    /**
     * Resolves a key's cache path: a cache hit returns immediately;
     * otherwise one download runs and every concurrent caller for that same
     * key awaits it. A failed download rejects every waiter and resets, so
     * the next request retries.
     *
     * @param key - The spec's file key.
     * @returns The absolute path of the cached file.
     */
    async path(key: string): Promise<string> {
        const target = this.targetPath(key);
        if (existsSync(target)) {
            return target;
        }
        const inFlight = this.inFlight.get(key);
        if (inFlight !== undefined) {
            return inFlight;
        }
        const download = this.download(key).catch((err: unknown) => {
            this.inFlight.delete(key);
            throw err;
        });
        this.inFlight.set(key, download);
        return download;
    }

    /**
     * Fetches one file upstream and lands it in the private cache. The body
     * streams to a temp name and is renamed, so a partial or failed download
     * never masquerades as a cached model and the ~40 MB archive never sits
     * whole in memory.
     *
     * @param key - The spec's file key.
     * @returns The absolute path of the cached file.
     */
    private async download(key: string): Promise<string> {
        ensurePrivateDir(this.spec.modelDir);
        const target = this.targetPath(key);
        const response = await this.fetcher(this.spec.upstreamUrl(key), {
            signal: AbortSignal.timeout(
                this.spec.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
            ),
        });
        if (!response.ok || response.body === null) {
            throw new Error(
                `the ${this.spec.upstreamLabel} upstream answered HTTP ${response.status}`,
            );
        }
        const tempPath = `${target}.tmp`;
        await pipeline(
            Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
            createWriteStream(tempPath),
        );
        await fsp.rename(tempPath, target);
        ensurePrivateFile(target);
        return target;
    }
}

/**
 * Options for {@link createModelFileHandler} — the shared route behavior
 * parameterized by messages, content type, and (for per-file routes) how
 * the request resolves to a cache key.
 */
export interface ModelFileHandlerOptions {
    /** The configured cache, or `null` when serving is unconfigured. */
    readonly cache: ModelFileCache | null;
    /** The `Content-Type` served for a hit. */
    readonly contentType: string;
    /** The JSON 404 body when the cache is `null`. */
    readonly notConfiguredMessage: string;
    /** The JSON 503 body when the upstream download failed. */
    readonly unavailableMessage: string;
    /** Log label for the download-failure warning ("STT model", "wake model"). */
    readonly logLabel: string;
    /**
     * Resolves the request's cache key for a per-file route (`:file`);
     * returning `null` answers the {@link unknownFileMessage} 404 — the
     * allowlist guard that keeps the route from proxying arbitrary upstream
     * paths. Absent for a fixed-key route (the STT archive).
     */
    readonly requestKey?: (req: Request) => string | null;
    /** The JSON 404 body for a request whose key resolves to `null`. */
    readonly unknownFileMessage?: string;
    /**
     * Answer a `HEAD` with a bare 200 before touching the cache — the
     * client's capability probe must never trigger a download.
     */
    readonly headProbe?: boolean;
}

/**
 * Builds a model-serving request handler (contract `sttModelGet` /
 * `wakeModelGet`): the cached file with long-lived caching headers, a JSON
 * 404 for an unknown file or when serving is unconfigured, an optional bare
 * 200 for `HEAD`, and a JSON 503 when the upstream download failed
 * (transient — the next request retries).
 *
 * @param options - The cache plus the route's messages and key resolution
 *   (see {@link ModelFileHandlerOptions}).
 * @returns The Express request handler.
 */
export function createModelFileHandler(
    options: ModelFileHandlerOptions,
): RequestHandler {
    return (req, res) => {
        let key = "";
        if (options.requestKey !== undefined) {
            const resolved = options.requestKey(req);
            if (resolved === null) {
                res.status(404).json({
                    error: options.unknownFileMessage ?? "unknown model file",
                });
                return;
            }
            key = resolved;
        }
        if (options.cache === null) {
            res.status(404).json({ error: options.notConfiguredMessage });
            return;
        }
        // A HEAD probe answers from configuration alone so toggling a UI
        // switch never triggers a multi-megabyte download.
        if (options.headProbe === true && req.method === "HEAD") {
            res.status(200).end();
            return;
        }
        void options.cache
            .path(key)
            .then((modelPath) => {
                res.setHeader("Content-Type", options.contentType);
                // The file only changes when the server's configuration
                // does; letting browsers cache it keeps repeat visits cheap.
                res.setHeader("Cache-Control", "public, max-age=86400");
                // `res.sendFile` uses `send`, whose default `dotfiles:
                // "ignore"` shield hides any path segment beginning with a
                // dot — our private cache lives under `~/.jarvis/…`, so the
                // `.jarvis` segment would 404. The path is composed of the
                // configured model dir plus a spec-controlled file name (no
                // separators), so it cannot escape that dir; allowing
                // dotfiles just un-hides the intentionally private location.
                res.sendFile(modelPath, { dotfiles: "allow" });
            })
            .catch((err: unknown) => {
                res.status(503).json({ error: options.unavailableMessage });
                if (err instanceof Error) {
                    const suffix =
                        options.requestKey !== undefined ? ` (${key})` : "";
                    logger.warn(
                        `${options.logLabel} download failed${suffix}: ${err.message}`,
                    );
                }
            });
    };
}
