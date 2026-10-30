/**
 * Local cache for the three openWakeWord ONNX files.
 *
 * The satellite prefers the server's unauthenticated
 * `GET /api/wake/model/<file>` route (which is already the browser client's
 * source) and falls back to the upstream release when the server does not serve
 * wake models. Files are written atomically into a private state directory, so
 * the first run needs egress but later runs are offline.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { DEFAULT_WAKE_MODEL_URL, type SatelliteConfig } from "./config";
import { logger } from "./logger";

/** The files `openwakeword-web` loads for `hey_jarvis`. */
export const WAKE_MODEL_FILES = [
    "melspectrogram.onnx",
    "embedding_model.onnx",
    "hey_jarvis_v0.1.onnx",
] as const;

/** A downloaded wake-model file name. */
export type WakeModelFile = (typeof WAKE_MODEL_FILES)[number];

/** Resolves a base URL to one of its files without dropping a path segment. */
function joinUrl(base: string, file: string): string {
    return `${base.replace(/\/+$/, "")}/${file}`;
}

/** Follows one HTTP(S) request and returns the body, or a redirect. */
function fetchFile(
    url: string,
    config: SatelliteConfig,
): Promise<{ body?: Buffer; location?: string }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === "https:" ? https : http;
        const ca =
            parsed.protocol === "https:" && config.caPath !== undefined
                ? readFileSync(config.caPath)
                : undefined;
        const request = transport.get(
            parsed,
            {
                ...(parsed.protocol === "https:"
                    ? { rejectUnauthorized: !config.insecureTls }
                    : {}),
                ...(ca !== undefined ? { ca } : {}),
            },
            (response) => {
                const status = response.statusCode ?? 0;
                if (
                    status >= 300 &&
                    status < 400 &&
                    response.headers.location
                ) {
                    response.resume();
                    resolve({ location: response.headers.location });
                    return;
                }
                if (status !== 200) {
                    response.resume();
                    reject(new Error(`HTTP ${status}`));
                    return;
                }
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () =>
                    resolve({ body: Buffer.concat(chunks) }),
                );
                response.on("error", reject);
            },
        );
        request.on("error", reject);
        request.setTimeout(30_000, () => {
            request.destroy(new Error("download timed out"));
        });
    });
}

/** Downloads one model file, following redirects and writing atomically. */
async function downloadWakeFile(
    baseUrl: string,
    file: WakeModelFile,
    config: SatelliteConfig,
): Promise<void> {
    let url = joinUrl(baseUrl, file);
    for (let redirect = 0; redirect < 5; redirect += 1) {
        const result = await fetchFile(url, config);
        if (result.location !== undefined) {
            url = new URL(result.location, url).toString();
            continue;
        }
        if (result.body === undefined || result.body.length === 0) {
            throw new Error("empty response");
        }
        const destination = path.join(config.wakeModelDir, file);
        const temporary = `${destination}.tmp-${process.pid}`;
        try {
            await writeFile(temporary, result.body, { mode: 0o600 });
            await rename(temporary, destination);
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
        return;
    }
    throw new Error("too many redirects");
}

/**
 * Makes sure all three wake-model files exist locally.
 *
 * @returns The directory to pass as `baseUrl`, or `null` when no source could
 *   provide every file. A `null` result is the caller's cue to fall back to
 *   transcript-based wake matching.
 */
export async function ensureWakeModels(
    config: SatelliteConfig,
): Promise<string | null> {
    mkdirSync(config.wakeModelDir, { recursive: true, mode: 0o700 });
    const missing: WakeModelFile[] = [];
    for (const file of WAKE_MODEL_FILES) {
        try {
            const bytes = await readFile(path.join(config.wakeModelDir, file));
            if (bytes.length === 0) {
                missing.push(file);
            }
        } catch {
            missing.push(file);
        }
    }
    if (missing.length === 0) {
        return config.wakeModelDir;
    }

    const sources = [config.wakeModelUrl, DEFAULT_WAKE_MODEL_URL].filter(
        (source, index, all) =>
            source.length > 0 && all.indexOf(source) === index,
    );
    for (const file of missing) {
        let saved = false;
        for (const source of sources) {
            try {
                logger.info(`Downloading wake model ${file} from ${source}`);
                await downloadWakeFile(source, file, config);
                saved = true;
                break;
            } catch (err) {
                logger.warn(
                    `Could not fetch wake model ${file} from ${source}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        if (!saved) {
            return null;
        }
    }
    return config.wakeModelDir;
}
