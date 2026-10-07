/**
 * Web Speech provider tests (issue #84, phase 2).
 *
 * A fake recognition engine is installed on `globalThis` per test, so the
 * provider's full contract — partial/final delivery, stop-and-flush,
 * cancel-before-callback, error mapping, stale-session isolation — runs in
 * the node test environment with no browser or microphone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    WebSpeechSttProvider,
    createBrowserStt,
    isWebSpeechSupported,
} from "../src/providers/webSpeech";
import type { SttCallbacks, VoiceError } from "../src/types";

/**
 * Minimal `SpeechRecognition` double: records lifecycle calls and hands
 * test drivers for the three engine events the provider listens to.
 */
class FakeRecognition {
    /** Every instance created since the last test reset. */
    static instances: FakeRecognition[] = [];

    continuous = false;
    interimResults = false;
    lang = "";
    maxAlternatives = 1;
    onresult: ((event: never) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    startCount = 0;
    stopCount = 0;
    abortCount = 0;

    constructor() {
        FakeRecognition.instances.push(this);
    }

    start(): void {
        this.startCount += 1;
    }

    stop(): void {
        this.stopCount += 1;
    }

    abort(): void {
        this.abortCount += 1;
    }

    /** Test driver: one `onresult` batch of {isFinal, transcript} results. */
    emitResults(
        resultIndex: number,
        results: Array<{ isFinal: boolean; transcript: string }>,
    ): void {
        const event = {
            resultIndex,
            results: results.map((r) => ({
                isFinal: r.isFinal,
                length: 1,
                0: { transcript: r.transcript, confidence: 0.9 },
            })),
        };
        this.onresult?.(event as never);
    }

    /** Test driver: one `onerror`. */
    emitError(code: string): void {
        this.onerror?.({ error: code });
    }

    /** Test driver: one `onend` (session over). */
    emitEnd(): void {
        this.onend?.();
    }
}

/** Recording sink for provider deliveries. */
interface Recorder {
    partials: string[];
    results: string[];
    errors: VoiceError[];
    callbacks: SttCallbacks;
}

function makeRecorder(): Recorder {
    const recorder: Recorder = {
        partials: [],
        results: [],
        errors: [],
        callbacks: {
            onPartial: () => {},
            onResult: () => {},
            onError: () => {},
        },
    };
    recorder.callbacks = {
        onPartial: (text: string) => recorder.partials.push(text),
        onResult: (text: string) => recorder.results.push(text),
        onError: (error: VoiceError) => recorder.errors.push(error),
    };
    return recorder;
}

/** The most recent fake engine (tests drive one at a time). */
function latestEngine(): FakeRecognition {
    const instances = FakeRecognition.instances;
    const engine = instances[instances.length - 1];
    if (engine === undefined) {
        throw new Error("no recognition engine was created");
    }
    return engine;
}

beforeEach(() => {
    FakeRecognition.instances = [];
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition =
        FakeRecognition;
});

afterEach(() => {
    delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe("support detection", () => {
    it("reports supported when the constructor exists", () => {
        expect(isWebSpeechSupported()).toBe(true);
        expect(createBrowserStt()).toBeInstanceOf(WebSpeechSttProvider);
    });

    it("reports unsupported (factory null) without the constructor", () => {
        delete (globalThis as { SpeechRecognition?: unknown })
            .SpeechRecognition;
        expect(isWebSpeechSupported()).toBe(false);
        expect(createBrowserStt()).toBeNull();
    });
});

describe("start", () => {
    it("configures and starts the engine, moving to running", async () => {
        const provider = new WebSpeechSttProvider({ lang: "en-GB" });
        expect(provider.state).toBe("idle");
        await provider.start(makeRecorder().callbacks);
        const engine = latestEngine();
        expect(engine.startCount).toBe(1);
        expect(engine.continuous).toBe(false);
        expect(engine.interimResults).toBe(true);
        expect(engine.maxAlternatives).toBe(1);
        expect(engine.lang).toBe("en-GB");
        expect(provider.state).toBe("running");
    });

    it("rejects while a session is already active", async () => {
        const provider = new WebSpeechSttProvider();
        await provider.start(makeRecorder().callbacks);
        await expect(provider.start(makeRecorder().callbacks)).rejects.toEqual({
            code: "engine",
            message: "recognition is already active",
        });
        expect(latestEngine().startCount).toBe(1);
    });

    it("rejects with unsupported when no engine exists", async () => {
        delete (globalThis as { SpeechRecognition?: unknown })
            .SpeechRecognition;
        const provider = new WebSpeechSttProvider();
        await expect(provider.start(makeRecorder().callbacks)).rejects.toEqual({
            code: "unsupported",
            message: "speech recognition is unavailable in this browser",
        });
    });
});

describe("results", () => {
    it("delivers trimmed partials and a trimmed final, then settles on end", async () => {
        const provider = new WebSpeechSttProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const engine = latestEngine();

        engine.emitResults(0, [
            { isFinal: false, transcript: "  what time  " },
        ]);
        expect(recorder.partials).toEqual(["what time"]);
        expect(provider.state).toBe("running");

        engine.emitResults(0, [
            { isFinal: true, transcript: "  what time is it  " },
        ]);
        expect(recorder.results).toEqual(["what time is it"]);
        expect(provider.state).toBe("running");

        engine.emitEnd();
        expect(provider.state).toBe("idle");
        expect(recorder.errors).toEqual([]);
    });

    it("skips empty interim results and empty finals", async () => {
        const provider = new WebSpeechSttProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const engine = latestEngine();

        engine.emitResults(0, [
            { isFinal: false, transcript: "   " },
            { isFinal: true, transcript: "   " },
        ]);
        expect(recorder.partials).toEqual([]);
        expect(recorder.results).toEqual([]);

        engine.emitEnd();
        expect(provider.state).toBe("idle");
        expect(recorder.errors).toEqual([
            { code: "no-speech", message: "no transcript was produced" },
        ]);
    });

    it("ignores results from a previous session", async () => {
        const provider = new WebSpeechSttProvider();
        const first = makeRecorder();
        await provider.start(first.callbacks);
        const staleEngine = latestEngine();
        await provider.cancel();

        const second = makeRecorder();
        await provider.start(second.callbacks);
        // The first engine (cancelled) delivers late — it must be dropped.
        staleEngine.emitResults(0, [{ isFinal: true, transcript: "stale" }]);
        expect(first.results).toEqual([]);
        expect(second.results).toEqual([]);
    });
});

describe("stop and cancel", () => {
    it("stop() flushes: final delivery settles the session and resolves", async () => {
        const provider = new WebSpeechSttProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const engine = latestEngine();

        let settled = false;
        const stopped = provider.stop().then(() => {
            settled = true;
        });
        expect(engine.stopCount).toBe(1);
        expect(provider.state).toBe("stopping");
        expect(settled).toBe(false);

        engine.emitResults(0, [{ isFinal: true, transcript: "flushed" }]);
        expect(recorder.results).toEqual(["flushed"]);
        engine.emitEnd();
        await stopped;
        expect(provider.state).toBe("idle");
        expect(recorder.errors).toEqual([]);
    });

    it("stop() with no final transcript reports no-speech", async () => {
        const provider = new WebSpeechSttProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const stopped = provider.stop();
        const engine = latestEngine();
        engine.emitEnd();
        await stopped;
        expect(recorder.results).toEqual([]);
        expect(recorder.errors).toEqual([
            { code: "no-speech", message: "no transcript was produced" },
        ]);
    });

    it("cancel() aborts the engine and no callback fires afterwards", async () => {
        const provider = new WebSpeechSttProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const engine = latestEngine();

        await provider.cancel();
        expect(engine.abortCount).toBe(1);
        expect(provider.state).toBe("idle");

        // Late engine events after cancel: all dropped.
        engine.emitResults(0, [
            { isFinal: false, transcript: "partial" },
            { isFinal: true, transcript: "final" },
        ]);
        engine.emitError("no-speech");
        engine.emitEnd();
        expect(recorder.partials).toEqual([]);
        expect(recorder.results).toEqual([]);
        expect(recorder.errors).toEqual([]);
    });

    it("cancel() is a no-op when idle", async () => {
        const provider = new WebSpeechSttProvider();
        await provider.cancel();
        expect(FakeRecognition.instances).toEqual([]);
    });
});

describe("errors", () => {
    it("maps engine error codes to voice error codes", async () => {
        const cases: Array<{ engine: string; expected: VoiceError }> = [
            {
                engine: "no-speech",
                expected: {
                    code: "no-speech",
                    message: "no speech was detected",
                },
            },
            {
                engine: "not-allowed",
                expected: {
                    code: "permission-denied",
                    message: "microphone access was denied",
                },
            },
            {
                engine: "service-not-allowed",
                expected: {
                    code: "permission-denied",
                    message: "microphone access was denied",
                },
            },
            {
                engine: "network",
                expected: {
                    code: "engine",
                    message: "recognition failed: network",
                },
            },
        ];
        for (const { engine: code, expected } of cases) {
            const provider = new WebSpeechSttProvider();
            const recorder = makeRecorder();
            await provider.start(recorder.callbacks);
            const engine = latestEngine();
            engine.emitError(code);
            engine.emitEnd();
            expect(recorder.errors).toEqual([expected]);
        }
    });

    it("does not map the engine's aborted error; an end without a transcript is no-speech", async () => {
        const provider = new WebSpeechSttProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const engine = latestEngine();
        engine.emitError("aborted");
        engine.emitEnd();
        // The aborted code itself is ignored (cancellation owns that path —
        // and a user cancel settles before onend, delivering nothing); an
        // engine-initiated end with no transcript still reports no-speech.
        expect(recorder.errors).toEqual([
            { code: "no-speech", message: "no transcript was produced" },
        ]);
    });

    it("delivers at most one error per session", async () => {
        const provider = new WebSpeechSttProvider();
        const recorder = makeRecorder();
        await provider.start(recorder.callbacks);
        const engine = latestEngine();
        engine.emitError("network");
        engine.emitError("network");
        engine.emitEnd();
        expect(recorder.errors.length).toBe(1);
    });
});
