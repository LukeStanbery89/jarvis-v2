/**
 * Shared model-file cache tests (issue #107 P3).
 *
 * `src/modelFileCache.ts` is the machinery the STT (`stt/model.ts`) and
 * wake (`wake/model.ts`) suites exercise through their adapters; these
 * tests pin the shared class directly — including the two behaviors folded
 * in for #107 that the old copies lacked: the streamed body write (no
 * whole-archive memory buffer) and the upstream fetch timeout.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelFileCache, type ModelFetcher } from "../src/modelFileCache";

const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);

/** A spec pointing at a private temp dir with a fixed file name. */
function makeSpec(modelDir: string) {
    return {
        modelDir,
        fileName: (key: string) => `${key}.bin`,
        upstreamUrl: (key: string) => `https://example.com/${key}`,
        upstreamLabel: "test model",
    };
}

describe("ModelFileCache", () => {
    let modelDir: string;

    beforeEach(() => {
        modelDir = mkdtempSync(path.join(tmpdir(), "jarvis-modelfile-"));
    });

    afterEach(() => {
        rmSync(modelDir, { recursive: true, force: true });
    });

    it("streams a multi-chunk response body to the cache file", async () => {
        const fetcher: ModelFetcher = vi.fn(() => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.enqueue(new Uint8Array([4, 5, 6]));
                    controller.enqueue(new Uint8Array([7]));
                    controller.close();
                },
            });
            return Promise.resolve(new Response(stream, { status: 200 }));
        });
        const cache = new ModelFileCache(makeSpec(modelDir), fetcher);
        const file = await cache.path("model");
        expect(readFileSync(file)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7]));
        // Only the final file lands — the temp name is renamed away.
        expect(readdirSync(modelDir)).toEqual(["model.bin"]);
    });

    it("aborts a hung upstream fetch at the spec's timeout and retries after", async () => {
        let first = true;
        const calls = { count: 0 };
        const fetcher: ModelFetcher = vi.fn((_url, init) => {
            calls.count += 1;
            if (first) {
                first = false;
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new Error("the fetch timed out")),
                    );
                });
            }
            return Promise.resolve(new Response(BYTES, { status: 200 }));
        });
        const cache = new ModelFileCache(
            { ...makeSpec(modelDir), downloadTimeoutMs: 20 },
            fetcher,
        );
        await expect(cache.path("model")).rejects.toThrow(/timed out/);
        expect(calls.count).toBe(1);
        // The failure reset the in-flight entry, so the next request really
        // fetches and succeeds.
        const file = await cache.path("model");
        expect(calls.count).toBe(2);
        expect(readFileSync(file).equals(BYTES)).toBe(true);
    });

    it("keeps downloads for different keys independent", async () => {
        const calls = { count: 0 };
        const fetcher: ModelFetcher = vi.fn(() => {
            calls.count += 1;
            return Promise.resolve(new Response(BYTES, { status: 200 }));
        });
        const cache = new ModelFileCache(makeSpec(modelDir), fetcher);
        const [a, b] = await Promise.all([
            cache.path("one"),
            cache.path("two"),
        ]);
        expect(calls.count).toBe(2);
        expect(a).not.toBe(b);
        expect(readdirSync(modelDir).sort()).toEqual(["one.bin", "two.bin"]);
    });
});
