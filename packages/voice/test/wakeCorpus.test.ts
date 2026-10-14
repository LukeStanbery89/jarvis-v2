/**
 * Wake→command corpus baseline (issue #121, phase 1).
 *
 * Drives the *real* controller over the committed fixtures and records what
 * the current design does with them — the executable form of the failure
 * report. Two facts it pins, both of which the redesign (#121 phase 2)
 * deliberately changes:
 *
 * 1. the wake session's engine is fed the **pre-match** audio as well as the
 *    command — the phrase rides into the recognizer, and
 * 2. the phrase stripper cannot repair a mangled phrase that arrives with an
 *    inserted token, so the junk reaches the prompt.
 *
 * The fixtures are the same ones the browser harness replays through the real
 * engine; here a scripted transcript stands in for the ASR, because Node has
 * no Vosk. Audio routing is asserted directly (deterministic, CI-able);
 * transcription quality is Tier B.
 */
import { describe, expect, it } from "vitest";
import { VoiceController } from "../src/index";
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    SttState,
    VoiceError,
    WakeCallbacks,
    WakeDetection,
    WakeWordProvider,
    WavAudio,
} from "../src/index";
import {
    FIXTURE_NAMES,
    findPause,
    listLocalCaptures,
    loadFixture,
    loadRealFixture,
    loadWav,
    sliceMs,
    windowRms,
} from "./support/corpus";

/** Minimal scripted STT engine; the test emits results by hand. */
class FakeStt implements SttProvider {
    readonly id: string;
    state: SttState = "idle";
    startCalls = 0;
    lastStartOptions: SttStartOptions | undefined;
    private callbacks: SttCallbacks | null = null;

    constructor(id = "fake") {
        this.id = id;
    }

    async start(
        callbacks: SttCallbacks,
        options?: SttStartOptions,
    ): Promise<void> {
        this.startCalls += 1;
        this.lastStartOptions = options;
        this.callbacks = callbacks;
        this.state = "running";
    }

    async stop(): Promise<void> {
        this.state = "idle";
    }

    async cancel(): Promise<void> {
        this.callbacks = null;
        this.state = "idle";
    }

    prepare(): Promise<void> {
        return Promise.resolve();
    }

    emitResult(text: string): void {
        this.callbacks?.onResult?.(text);
    }

    emitError(error: VoiceError): void {
        this.callbacks?.onError?.(error);
    }
}

/** Scripted wake detector; the test fires matches and supplies the ring. */
class FakeWake implements WakeWordProvider {
    readonly id = "fake-wake";
    startCalls = 0;
    /** The post-match ring `drainPostMatch()` returns (today's contract). */
    drained: Float32Array | null = null;
    private callbacks: WakeCallbacks | null = null;

    async start(callbacks: WakeCallbacks): Promise<void> {
        this.startCalls += 1;
        this.callbacks = callbacks;
    }

    async stop(): Promise<void> {
        this.callbacks = null;
    }

    drainPostMatch(): Float32Array | null {
        return this.drained;
    }

    emitWake(detection: WakeDetection): void {
        this.callbacks?.onWake(detection);
    }
}

/** Controller + its fakes + recorded submissions, over the corpus. */
interface Harness {
    stt: FakeStt;
    wakeStt: FakeStt;
    wake: FakeWake;
    controller: VoiceController;
    submits: string[];
}

/**
 * Builds a controller in engine-native mode (no VAD, so a final submits
 * immediately) and arms the (fake) wake detector.
 *
 * @returns The harness.
 */
async function makeHarness(): Promise<Harness> {
    const stt = new FakeStt("primary");
    const wakeStt = new FakeStt("wake");
    const wake = new FakeWake();
    const submits: string[] = [];
    const controller = new VoiceController({
        stt,
        wakeStt,
        wake,
        wakePhrase: "Hey JARVIS",
        submit: (text) => {
            submits.push(text);
            return new Promise<void>(() => {
                // Never settles: the test inspects submissions without the
                // session racing on to `idle`.
            });
        },
    });
    await controller.enableWake();
    await drain();
    return { stt, wakeStt, wake, controller, submits };
}

/** Drains the controller's async chains (several microtasks). */
async function drain(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
    }
}

/**
 * Opens a wake session from a fixture, handing the controller the ring the
 * current provider contract reports: `lookback` = the window ending at the
 * match instant (the phrase), drained = everything after it.
 *
 * @param h - The harness.
 * @param audio - The decoded fixture to replay.
 * @param matchMs - The time the wake phrase was detected.
 */
async function openFromCorpus(
    h: Harness,
    audio: WavAudio,
    matchMs: number,
): Promise<void> {
    const totalMs = (audio.pcm.length / audio.sampleRate) * 1000;
    h.wake.drained = sliceMs(audio, matchMs, totalMs);
    h.wake.emitWake({
        confidence: 0.9,
        lookback: sliceMs(audio, 0, matchMs),
        lookbackSampleRate: audio.sampleRate,
    });
    await drain();
}

describe("wake corpus fixtures", () => {
    it("are 16 kHz mono and non-empty", () => {
        for (const name of FIXTURE_NAMES) {
            const audio = loadFixture(name);
            expect(audio.sampleRate).toBe(16000);
            expect(audio.pcm.length).toBeGreaterThan(0);
        }
    });
});

describe("wake corpus — baseline (pre-redesign contract)", () => {
    it("pins the phrase into the wake engine's stream", async () => {
        const h = await makeHarness();
        const audio = loadFixture("pause-then-command");
        await openFromCorpus(h, loadFixture("pause-then-command"), 900);
        const feed = h.wakeStt.lastStartOptions?.feed;
        expect(feed?.sampleRate).toBe(16000);
        // The engine is fed the whole utterance — including the 0.9 s before
        // the match, which is the wake phrase. This is the defect: the STT
        // hears "Hey Jarvis" and everything the stripper can't repair follows.
        expect(feed?.pcm.length).toBe(audio.pcm.length);
        expect(feed?.pcm[0]).toBe(audio.pcm[0]);
    });

    it("pins the mangled-phrase class reaching the prompt", async () => {
        const h = await makeHarness();
        await openFromCorpus(h, loadFixture("pause-then-command"), 900);
        // The ASR's shape on 2026-10-14: the phrase stretched into extra
        // tokens over the pause. The positional fuzzy matcher correctly
        // refuses, so the junk is submitted verbatim.
        h.wakeStt.emitResult("he during a journalist what's the weather");
        await drain();
        expect(h.submits).toEqual([
            "he during a journalist what's the weather",
        ]);
    });

    it("strips a cleanly-recognized phrase down to the command", async () => {
        const h = await makeHarness();
        await openFromCorpus(h, loadFixture("pause-then-command"), 900);
        h.wakeStt.emitResult("hey jarvis what's the weather");
        await drain();
        expect(h.submits).toEqual(["what's the weather"]);
    });

    it("submits nothing for a phrase-only utterance", async () => {
        const h = await makeHarness();
        const audio = loadFixture("phrase-only");
        await openFromCorpus(
            h,
            audio,
            (audio.pcm.length / audio.sampleRate) * 1000,
        );
        h.wakeStt.emitResult("hey jarvis");
        await drain();
        expect(h.submits).toEqual([]);
    });

    it("submits nothing when the detector hears only silence", async () => {
        const h = await makeHarness();
        await openFromCorpus(h, loadFixture("silence"), 0);
        h.wakeStt.emitResult("");
        await drain();
        expect(h.submits).toEqual([]);
    });

    it("keeps the primary engine unused on a wake turn", async () => {
        const h = await makeHarness();
        await openFromCorpus(h, loadFixture("one-breath"), 900);
        expect(h.stt.startCalls).toBe(0);
        expect(h.wakeStt.startCalls).toBe(1);
    });
});

describe("real corpus (#121) — the maintainer's recordings", () => {
    it("are 16 kHz mono and non-empty", () => {
        for (const name of FIXTURE_NAMES) {
            const audio = loadRealFixture(name);
            expect(audio.sampleRate).toBe(16000);
            expect(audio.pcm.length).toBeGreaterThan(0);
        }
    });

    it("pause-then-command really has a pause between phrase and command", () => {
        // The shape the failure needs, asserted from the audio itself rather
        // than a hand-picked offset: speech, a quiet gap, more speech.
        const audio = loadRealFixture("pause-then-command");
        const pause = findPause(audio);
        expect(pause).not.toBeNull();
        expect(pause!.endMs - pause!.startMs).toBeGreaterThanOrEqual(400);
        expect(pause!.startMs).toBeGreaterThan(0);
    });

    it("one-breath has no long internal pause", () => {
        // A one-breath utterance may have a natural inter-word gap, but not a
        // real silence — otherwise it is not testing the clip-risk shape.
        expect(findPause(loadRealFixture("one-breath"))).toBeNull();
    });

    it("silence stays below the speech floor throughout", () => {
        const windows = windowRms(loadRealFixture("silence"));
        expect(windows.length).toBeGreaterThan(0);
        expect(Math.max(...windows)).toBeLessThan(0.01);
    });

    it("phrase-only and command-only are single speech regions", () => {
        expect(findPause(loadRealFixture("phrase-only"))).toBeNull();
        expect(findPause(loadRealFixture("command-only"))).toBeNull();
    });

    it("pins the phrase into the replay on real audio", async () => {
        // The same defect the synthetic corpus pins, now on a real recording:
        // the pre-match window (which the wake provider puts in the replay) is
        // the phrase, and it is loud — not noise the stripper could shrug off.
        const h = await makeHarness();
        const audio = loadRealFixture("pause-then-command");
        const pause = findPause(audio);
        expect(pause).not.toBeNull();
        const matchMs = pause!.startMs;
        await openFromCorpus(h, audio, matchMs);
        const feed = h.wakeStt.lastStartOptions?.feed;
        expect(feed?.pcm.length).toBe(audio.pcm.length);
        // The phrase region (everything before the pause) carries speech
        // energy — real audio, not a low noise floor.
        const phraseSamples = Math.round(
            (pause!.startMs / 1000) * audio.sampleRate,
        );
        expect(rmsOf(feed!.pcm, 0, phraseSamples)).toBeGreaterThan(0.01);
        // ...and the engine is fed the pause and the command too (whole clip).
        expect(feed?.sampleRate).toBe(16000);
    });

    it("pins the command into the post-match slice", () => {
        // The redesign's input, on real audio: the slice from the pause start
        // is silence then the command — the phrase is behind the cut.
        const audio = loadRealFixture("pause-then-command");
        const pause = findPause(audio);
        expect(pause).not.toBeNull();
        const from = Math.round((pause!.startMs / 1000) * audio.sampleRate);
        const slice = audio.pcm.slice(from);
        const before = Math.round(
            ((pause!.endMs - pause!.startMs) / 1000) * audio.sampleRate,
        );
        // The leading half of the slice is the pause (quiet)...
        expect(rmsOf(slice, 0, before)).toBeLessThan(0.01);
        // ...and the tail is the command (loud).
        expect(rmsOf(slice, before, slice.length)).toBeGreaterThan(0.01);
    });

    it("the production splice replays the phrase twice on real audio", async () => {
        // The controller joins the match-time look-back with the ring drained
        // at session open (`wakeReplay`). The ring is never reset at the
        // match, so the drained window still contains the look-back's audio:
        // the seed repeats whatever preceded the match — the phrase. Modelled
        // here from the real recording (2 s ring, 200 ms mic-open gap).
        const h = await makeHarness();
        const audio = loadRealFixture("pause-then-command");
        const pause = findPause(audio);
        expect(pause).not.toBeNull();
        const matchMs = pause!.startMs;
        const gapMs = 200;
        const lookback = sliceMs(audio, matchMs - 2000, matchMs);
        const drained = sliceMs(audio, matchMs + gapMs - 2000, matchMs + gapMs);
        h.wake.drained = drained;
        h.wake.emitWake({
            confidence: 0.9,
            lookback,
            lookbackSampleRate: audio.sampleRate,
        });
        await drain();
        const fed = h.wakeStt.lastStartOptions?.feed;
        expect(fed?.pcm.length).toBe(lookback.length + drained.length);
        // The drain begins with the same audio the look-back already ended
        // on: the phrase region is fed twice.
        expect(fed!.pcm[lookback.length]).toBe(lookback[0]);
        expect(fed!.pcm[lookback.length + 100]).toBe(lookback[100]);
        const phraseSamples = Math.round(
            (pause!.startMs / 1000) * audio.sampleRate,
        );
        expect(rmsOf(fed!.pcm, 0, phraseSamples)).toBeGreaterThan(0.01);
        expect(
            rmsOf(fed!.pcm, lookback.length, lookback.length + phraseSamples),
        ).toBeGreaterThan(0.01);
    });
});

describe("local captures (#121)", () => {
    it("decodes any local capture that is present", () => {
        // A gitignored drop box: a new take is usable the moment it is
        // dropped in, and this catches one that is not decodable at all.
        // Vacuous on CI (the directory is empty there), which is why the
        // committed `real/` set carries the reproducible checks.
        for (const file of listLocalCaptures()) {
            expect(loadWav(file).pcm.length).toBeGreaterThan(0);
        }
    });
});

/**
 * RMS of a sample range — a local probe for the real-corpus assertions.
 *
 * @param pcm - The samples.
 * @param from - Start index.
 * @param to - End index (exclusive).
 * @returns The root-mean-square over the range.
 */
function rmsOf(pcm: Float32Array, from: number, to: number): number {
    const end = Math.min(pcm.length, Math.max(from, to));
    if (end <= from) {
        return 0;
    }
    let sum = 0;
    for (let i = from; i < end; i += 1) {
        sum += pcm[i]! * pcm[i]!;
    }
    return Math.sqrt(sum / (end - from));
}
