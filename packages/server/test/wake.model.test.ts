/**
 * Wake-word model serving tests (issue #84, phase 4).
 *
 * The per-file cache is driven with an injectable fetcher (no network), a
 * private temp directory stands in for `~/.jarvis/wake`, and the route
 * handler is exercised through supertest on a minimal Express app —
 * covering the per-file download-once semantics, in-flight collapse, retry
 * after failure, the allowlist 404, the HEAD capability probe (no
 * download), the JSON 404/503 contract shapes, and the private-file
 * posture.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import {
    createWakeModelHandler,
    isWakeModelFile,
    WakeModelCache,
    WAKE_MODEL_FILES,
} from "../src/wake/model";

const BYTES = new Uint8Array([0x08, 0x01, 0x02, 0x03, 0x04]);
const MODEL_URL = "https://example.com/wake";

/** Builds a fetcher that answers 200 with the model bytes. */
function okFetcher(calls: { count: number }) {
    return vi.fn(() => {
        calls.count += 1;
        return Promise.resolve(new Response(BYTES, { status: 200 }));
    });
}

/** Builds a fetcher that answers with the given HTTP status. */
function statusFetcher(calls: { count: number }, status: number) {
    return vi.fn(() => {
        calls.count += 1;
        return Promise.resolve(
            new Response("nope", { status, statusText: "nope" }),
        );
    });
}

/** A minimal app carrying only the wake model route. */
function appWith(cache: WakeModelCache | null) {
    const app = express();
    app.get("/api/wake/model/:file", createWakeModelHandler(cache));
    return app;
}

describe("wake model file allowlist", () => {
    it("accepts exactly the three upstream files", () => {
        expect([...WAKE_MODEL_FILES]).toEqual([
            "melspectrogram.onnx",
            "embedding_model.onnx",
            "hey_jarvis_v0.1.onnx",
        ]);
        for (const file of WAKE_MODEL_FILES) {
            expect(isWakeModelFile(file)).toBe(true);
        }
    });

    it("refuses traversal, foreign names, and empty strings", () => {
        expect(isWakeModelFile("../../etc/passwd")).toBe(false);
        expect(isWakeModelFile("evil.onnx")).toBe(false);
        expect(isWakeModelFile("")).toBe(false);
        expect(isWakeModelFile("melspectrogram.onnx.tmp")).toBe(false);
    });
});

describe("WakeModelCache", () => {
    let modelDir: string;

    beforeAll(() => {
        modelDir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-"));
    });

    afterAll(() => {
        rmSync(modelDir, { recursive: true, force: true });
    });

    it("joins the base URL per file, tolerating a trailing slash", () => {
        const calls = { count: 0 };
        const cache = new WakeModelCache(
            { baseUrl: `${MODEL_URL}/`, modelDir },
            okFetcher(calls),
        );
        expect(cache.targetPath("hey_jarvis_v0.1.onnx")).toBe(
            path.join(modelDir, "hey_jarvis_v0.1.onnx"),
        );
        expect(calls.count).toBe(0);
    });

    it("downloads each file once, then serves from the cache", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-"));
        try {
            const cache = new WakeModelCache(
                { baseUrl: MODEL_URL, modelDir: dir },
                okFetcher(calls),
            );
            const first = await cache.path("melspectrogram.onnx");
            expect(calls.count).toBe(1);
            expect(readFileSync(first).equals(BYTES)).toBe(true);
            // Private posture: the file sits in a 0700 dir, chmod 0600.
            expect((statSync(first).mode & 0o777) === 0o600).toBe(true);
            const second = await cache.path("melspectrogram.onnx");
            expect(second).toBe(first);
            expect(calls.count).toBe(1);
            // A second file downloads independently.
            await cache.path("embedding_model.onnx");
            expect(calls.count).toBe(2);
            // Only the model files land in the dir — temp files renamed away.
            expect(readdirSync(dir).sort()).toEqual([
                "embedding_model.onnx",
                "melspectrogram.onnx",
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("collapses concurrent downloads of the same file into one fetch", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-"));
        try {
            const cache = new WakeModelCache(
                { baseUrl: MODEL_URL, modelDir: dir },
                okFetcher(calls),
            );
            const paths = await Promise.all([
                cache.path("hey_jarvis_v0.1.onnx"),
                cache.path("hey_jarvis_v0.1.onnx"),
                cache.path("hey_jarvis_v0.1.onnx"),
            ]);
            expect(calls.count).toBe(1);
            expect(new Set(paths).size).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects on an upstream failure and retries on the next request", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-"));
        try {
            const cache = new WakeModelCache(
                { baseUrl: MODEL_URL, modelDir: dir },
                statusFetcher(calls, 502),
            );
            await expect(cache.path("melspectrogram.onnx")).rejects.toThrow(
                /HTTP 502/,
            );
            expect(calls.count).toBe(1);
            await expect(cache.path("melspectrogram.onnx")).rejects.toThrow(
                /HTTP 502/,
            );
            expect(calls.count).toBe(2); // reset, so the retry really fetches
            // The failure left nothing behind to masquerade as a cache hit.
            expect(readdirSync(dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("GET/HEAD /api/wake/model/:file", () => {
    let modelDir: string;

    beforeAll(() => {
        modelDir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-route-"));
    });

    afterAll(() => {
        rmSync(modelDir, { recursive: true, force: true });
    });

    it("answers a JSON 404 when wake model serving is unconfigured", async () => {
        const res = await request(appWith(null)).get(
            "/api/wake/model/melspectrogram.onnx",
        );
        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.body).toMatchObject({ error: expect.any(String) });
    });

    it("answers a JSON 404 for a file outside the allowlist (configured)", async () => {
        const cache = new WakeModelCache(
            { baseUrl: MODEL_URL, modelDir },
            okFetcher({ count: 0 }),
        );
        const res = await request(appWith(cache)).get(
            "/api/wake/model/evil.onnx",
        );
        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.body).toMatchObject({ error: "unknown wake model file" });
    });

    it("streams the cached model with caching headers once configured", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-route-"));
        try {
            const cache = new WakeModelCache(
                { baseUrl: MODEL_URL, modelDir: dir },
                okFetcher(calls),
            );
            const res = await request(appWith(cache)).get(
                "/api/wake/model/melspectrogram.onnx",
            );
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toBe(
                "application/octet-stream",
            );
            expect(res.headers["cache-control"]).toContain("max-age=86400");
            expect(Buffer.from(res.body).equals(Buffer.from(BYTES))).toBe(true);
            expect(calls.count).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("answers HEAD 200 from configuration alone, downloading nothing", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-head-"));
        try {
            const cache = new WakeModelCache(
                { baseUrl: MODEL_URL, modelDir: dir },
                okFetcher(calls),
            );
            const res = await request(appWith(cache)).head(
                "/api/wake/model/hey_jarvis_v0.1.onnx",
            );
            expect(res.status).toBe(200);
            expect(calls.count).toBe(0);
            expect(readdirSync(dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("answers HEAD 404 for an unknown file or an unconfigured server", async () => {
        const configured = new WakeModelCache(
            { baseUrl: MODEL_URL, modelDir },
            okFetcher({ count: 0 }),
        );
        const unknown = await request(appWith(configured)).head(
            "/api/wake/model/evil.onnx",
        );
        expect(unknown.status).toBe(404);
        const unconfigured = await request(appWith(null)).head(
            "/api/wake/model/melspectrogram.onnx",
        );
        expect(unconfigured.status).toBe(404);
    });

    it("answers a JSON 503 when the upstream download fails", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-fail-"));
        try {
            const cache = new WakeModelCache(
                { baseUrl: MODEL_URL, modelDir: dir },
                statusFetcher(calls, 500),
            );
            const res = await request(appWith(cache)).get(
                "/api/wake/model/melspectrogram.onnx",
            );
            expect(res.status).toBe(503);
            expect(res.headers["content-type"]).toMatch(/application\/json/);
            expect(res.body).toMatchObject({ error: expect.any(String) });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
