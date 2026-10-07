/**
 * Kokoro TTS provider tests (issue #83, phase 1).
 *
 * The module loader seam is injected, so the whole lifecycle — lazy init
 * once per provider, voice/speed pass-through, cooperative abort, empty-text
 * refusal, failed-init retry — runs against a fake kokoro module with no
 * network, no model download, and no native ONNX runtime.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    DEFAULT_KOKORO_MODEL_ID,
    DEFAULT_KOKORO_VOICE,
    KokoroTtsProvider,
    type KokoroModuleLoader,
} from "../src/tts/kokoro";
import type { KokoroRawAudio } from "kokoro-js";

/** Calls recorded against the fake engine. */
interface FakeKokoroCalls {
    fromPretrained: Array<{ modelId: string; options: unknown }>;
    generate: Array<{ text: string; options: unknown }>;
    loaderCalls: number;
}

/** Builds a loader whose fake engine answers every generate with 1s of PCM. */
function makeFakeLoader(sampleRate = 24_000): {
    loader: KokoroModuleLoader;
    calls: FakeKokoroCalls;
    /** Makes the next init fail (e.g. optional dependency missing). */
    failNextInit(reason: string): void;
} {
    const calls: FakeKokoroCalls = {
        fromPretrained: [],
        generate: [],
        loaderCalls: 0,
    };
    let initFailure: string | null = null;
    const loader: KokoroModuleLoader = () => {
        calls.loaderCalls += 1;
        if (initFailure !== null) {
            const reason = initFailure;
            initFailure = null;
            return Promise.reject(new Error(reason));
        }
        const fake = {
            KokoroTTS: {
                from_pretrained: (modelId: string, options?: unknown) => {
                    calls.fromPretrained.push({ modelId, options });
                    return Promise.resolve({
                        generate: (text: string, options?: unknown) => {
                            calls.generate.push({ text, options });
                            const raw: KokoroRawAudio = {
                                audio: new Float32Array(sampleRate),
                                sampling_rate: sampleRate,
                                toWav: () => new ArrayBuffer(0),
                            };
                            return Promise.resolve(raw);
                        },
                    });
                },
            },
        };
        return Promise.resolve(
            fake as unknown as Awaited<ReturnType<KokoroModuleLoader>>,
        );
    };
    return {
        loader,
        calls,
        failNextInit: (reason) => {
            initFailure = reason;
        },
    };
}

/** A private scratch cache dir so tests never touch `~/.jarvis`. */
function scratchCacheDir(): string {
    return mkdtempSync(join(tmpdir(), "jarvis-tts-test-"));
}

describe("KokoroTtsProvider", () => {
    it("synthesizes text into PCM and passes voice + speed through", async () => {
        const { loader, calls } = makeFakeLoader(16_000);
        const provider = new KokoroTtsProvider(
            { cacheDir: scratchCacheDir(), voice: "bm_george", speed: 1.1 },
            loader,
        );
        const speech = await provider.synthesize("  The light is on.  ");
        expect(speech.sampleRate).toBe(16_000);
        expect(speech.pcm).toBeInstanceOf(Float32Array);
        expect(calls.generate).toEqual([
            {
                text: "The light is on.",
                options: { voice: "bm_george", speed: 1.1 },
            },
        ]);
    });

    it("initializes the engine once and reuses it across calls", async () => {
        const { loader, calls } = makeFakeLoader();
        const provider = new KokoroTtsProvider(
            { cacheDir: scratchCacheDir() },
            loader,
        );
        await provider.synthesize("one");
        await provider.synthesize("two");
        expect(calls.loaderCalls).toBe(1);
        expect(calls.fromPretrained).toHaveLength(1);
        expect(calls.fromPretrained[0]).toEqual({
            modelId: DEFAULT_KOKORO_MODEL_ID,
            options: { dtype: "q8", device: "cpu" },
        });
        expect(calls.generate).toHaveLength(2);
        // The unset voice falls back to the default J.A.R.V.I.S. voice.
        expect(calls.generate[0]?.options).toEqual({
            voice: DEFAULT_KOKORO_VOICE,
            speed: 1,
        });
    });

    it("refuses to synthesize empty or whitespace-only text", async () => {
        const { loader, calls } = makeFakeLoader();
        const provider = new KokoroTtsProvider(
            { cacheDir: scratchCacheDir() },
            loader,
        );
        await expect(provider.synthesize("   ")).rejects.toThrow(
            "refusing to synthesize empty text",
        );
        expect(calls.loaderCalls).toBe(0);
    });

    it("rejects with the signal's reason when aborted before the call", async () => {
        const { loader, calls } = makeFakeLoader();
        const provider = new KokoroTtsProvider(
            { cacheDir: scratchCacheDir() },
            loader,
        );
        const controller = new AbortController();
        controller.abort();
        await expect(
            provider.synthesize("hello", { signal: controller.signal }),
        ).rejects.toBe(controller.signal.reason);
        expect(calls.loaderCalls).toBe(0);
    });

    it("cooperatively aborts between init and generate", async () => {
        const { loader, calls } = makeFakeLoader();
        const provider = new KokoroTtsProvider(
            { cacheDir: scratchCacheDir() },
            loader,
        );
        const controller = new AbortController();
        const pending = provider.synthesize("hello", {
            signal: controller.signal,
        });
        controller.abort();
        await expect(pending).rejects.toBe(controller.signal.reason);
        expect(calls.generate).toEqual([]);
    });

    it("a failed init can retry on the next call", async () => {
        const { loader, calls, failNextInit } = makeFakeLoader();
        const provider = new KokoroTtsProvider(
            { cacheDir: scratchCacheDir() },
            loader,
        );
        failNextInit("kokoro-js is not installed");
        await expect(provider.synthesize("hello")).rejects.toThrow(
            "kokoro-js is not installed",
        );
        await provider.synthesize("hello again");
        expect(calls.loaderCalls).toBe(2);
        expect(calls.generate).toHaveLength(1);
    });

    it("reports the kokoro provider id", () => {
        const { loader } = makeFakeLoader();
        const provider = new KokoroTtsProvider({}, loader);
        expect(provider.id).toBe("kokoro");
    });
});
