/**
 * STT model serving tests (issue #84, phase 3b).
 *
 * The cache is driven with an injectable fetcher (no network), a private
 * temp directory stands in for `~/.jarvis/stt`, and the route handler is
 * exercised through supertest on a minimal Express app — covering the
 * download-once semantics, in-flight collapse, retry after failure, the
 * JSON 404/503 contract shapes, and the private-file posture.
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
import { createSttModelHandler, SttModelCache } from "../src/stt/model";

const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);

/** Builds a fetcher that answers 200 with the archive bytes. */
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

/** A minimal app carrying only the model route. */
function appWith(cache: SttModelCache | null) {
    const app = express();
    app.get("/api/stt/model", createSttModelHandler(cache));
    return app;
}

describe("SttModelCache", () => {
    let modelDir: string;

    beforeAll(() => {
        modelDir = mkdtempSync(path.join(tmpdir(), "jarvis-stt-"));
    });

    afterAll(() => {
        rmSync(modelDir, { recursive: true, force: true });
    });

    it("derives a sanitized file name from the upstream URL", () => {
        const cache = new SttModelCache(
            {
                modelUrl:
                    "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz",
                modelDir,
            },
            okFetcher({ count: 0 }),
        );
        expect(cache.fileName).toBe("vosk-model-small-en-us-0.15.tar.gz");
        expect(cache.targetPath).toBe(
            path.join(modelDir, "vosk-model-small-en-us-0.15.tar.gz"),
        );
    });

    it("falls back to a safe name for an unusable URL", () => {
        const cache = new SttModelCache(
            { modelUrl: "::not a url::", modelDir },
            okFetcher({ count: 0 }),
        );
        expect(cache.fileName).toBe("model.tar.gz");
    });

    it("never resolves the cache name to a relative segment", () => {
        // The sanitizer keeps dots, so a URL whose last segment is all dots
        // would otherwise sanitize to `.`/`..` and `path.join` would land
        // outside the cache dir.
        for (const url of [
            "https://example.com/models/..",
            "https://example.com/models/.",
            // Dot-prefixed names that are not relative segments stay usable.
            "https://example.com/..tar.gz",
        ]) {
            const cache = new SttModelCache(
                { modelUrl: url, modelDir },
                okFetcher({ count: 0 }),
            );
            expect(cache.fileName).not.toBe(".");
            expect(cache.fileName).not.toBe("..");
            expect(cache.targetPath.startsWith(modelDir + path.sep)).toBe(true);
        }
    });

    it("downloads once, then serves from the cache", async () => {
        const calls = { count: 0 };
        const cache = new SttModelCache(
            { modelUrl: "https://example.com/model.tar.gz", modelDir },
            okFetcher(calls),
        );
        const first = await cache.path();
        expect(calls.count).toBe(1);
        expect(readFileSync(first).equals(BYTES)).toBe(true);
        // Private posture: the archive sits in a 0700 dir, chmod 0600.
        expect((statSync(first).mode & 0o777) === 0o600).toBe(true);
        const second = await cache.path();
        expect(second).toBe(first);
        expect(calls.count).toBe(1);
        // Only the archive lands in the dir — the temp file is renamed away.
        expect(readdirSync(modelDir)).toEqual(["model.tar.gz"]);
    });

    it("collapses concurrent downloads into one fetch", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-stt-"));
        try {
            const cache = new SttModelCache(
                { modelUrl: "https://example.com/model.tar.gz", modelDir: dir },
                okFetcher(calls),
            );
            const paths = await Promise.all([
                cache.path(),
                cache.path(),
                cache.path(),
            ]);
            expect(calls.count).toBe(1);
            expect(new Set(paths).size).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects on an upstream failure and retries on the next request", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-stt-"));
        try {
            const cache = new SttModelCache(
                { modelUrl: "https://example.com/model.tar.gz", modelDir: dir },
                statusFetcher(calls, 502),
            );
            await expect(cache.path()).rejects.toThrow(/HTTP 502/);
            expect(calls.count).toBe(1);
            await expect(cache.path()).rejects.toThrow(/HTTP 502/);
            expect(calls.count).toBe(2); // reset, so the retry really fetches
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("GET /api/stt/model", () => {
    let modelDir: string;

    beforeAll(() => {
        modelDir = mkdtempSync(path.join(tmpdir(), "jarvis-stt-route-"));
    });

    afterAll(() => {
        rmSync(modelDir, { recursive: true, force: true });
    });

    it("answers a JSON 404 when STT model serving is unconfigured", async () => {
        const res = await request(appWith(null)).get("/api/stt/model");
        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.body).toMatchObject({ error: expect.any(String) });
    });

    it("streams the cached archive with caching headers once configured", async () => {
        const calls = { count: 0 };
        const cache = new SttModelCache(
            { modelUrl: "https://example.com/model.tar.gz", modelDir },
            okFetcher(calls),
        );
        const res = await request(appWith(cache)).get("/api/stt/model");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("application/gzip");
        expect(res.headers["cache-control"]).toContain("max-age=86400");
        expect(Buffer.from(res.body).equals(Buffer.from(BYTES))).toBe(true);
    });

    it("answers a JSON 503 when the upstream download fails", async () => {
        const calls = { count: 0 };
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-stt-fail-"));
        try {
            const cache = new SttModelCache(
                { modelUrl: "https://example.com/model.tar.gz", modelDir: dir },
                statusFetcher(calls, 500),
            );
            const res = await request(appWith(cache)).get("/api/stt/model");
            expect(res.status).toBe(503);
            expect(res.headers["content-type"]).toMatch(/application\/json/);
            expect(res.body).toMatchObject({ error: expect.any(String) });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
