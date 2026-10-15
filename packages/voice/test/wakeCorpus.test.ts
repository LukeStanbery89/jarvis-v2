/**
 * Wake→command corpus baseline (issue #121).
 *
 * Drives the *real* controller over the committed fixtures and records what
 * the design does with them. The property it pins is the fix for #121: a wake
 * session's engine is fed the detector's live post-match frames and **only**
 * those — the wake phrase never arrives, and the audio is contiguous, so
 * nothing is doubled and nothing is spliced.
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
    windowRms,
} from "./support/corpus";

/** Minimal scripted STT engine; the test emits results by hand. */
class FakeStt implements SttProvider {
    readonly id: string;
    state: SttState = "idle";
    startCalls = 0;
    lastStartOptions: SttStartOptions | undefined;
    /** Every `feed()` chunk the engine received, in order (#121 routing). */
    fed: Array<{ pcm: Float32Array; sampleRate: number }> = [];
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

    feed(pcm: Float32Array, sampleRate: number): void {
        this.fed.push({ pcm, sampleRate });
    }

    emitResult(text: string): void {
        this.callbacks?.onResult?.(text);
    }

    emitError(error: VoiceError): void {
        this.callbacks?.onError?.(error);
    }
}

/** Scripted wake detector; the test fires matches and streams frames. */
class FakeWake implements WakeWordProvider {
    readonly id = "fake-wake";
    startCalls = 0;
    private callbacks: WakeCallbacks | null = null;

    async start(callbacks: WakeCallbacks): Promise<void> {
        this.startCalls += 1;
        this.callbacks = callbacks;
    }

    async stop(): Promise<void> {
        this.callbacks = null;
    }

    emitWake(detection: WakeDetection): void {
        this.callbacks?.onWake(detection);
    }

    /** One live post-match command frame, as the real detector streams it. */
    emitCommandAudio(pcm: Float32Array, sampleRate = 16000): void {
        this.callbacks?.onCommandAudio?.(pcm, sampleRate);
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
 * Builds a controller in engine-native mode (no VAD) and arms the (fake) wake
 * detector.
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

/** The engine's feed chunks as one contiguous buffer, in arrival order. */
function fedAudio(stt: FakeStt): Float32Array {
    const total = stt.fed.reduce((sum, chunk) => sum + chunk.pcm.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of stt.fed) {
        out.set(chunk.pcm, offset);
        offset += chunk.pcm.length;
    }
    return out;
}

/** One 1280-sample detector frame (80 ms at 16 kHz). */
const FRAME_SAMPLES = 1280;

/**
 * Opens a wake session from a fixture the way the provider behaves: a match
 * fires, then the detector streams the audio that follows — and only that —
 * frame by frame (#121).
 *
 * @param h - The harness.
 * @param audio - The decoded fixture.
 * @param matchMs - The time the wake phrase was detected.
 */
async function openFromCorpus(
    h: Harness,
    audio: WavAudio,
    matchMs: number,
): Promise<void> {
    const from = Math.round((matchMs / 1000) * audio.sampleRate);
    const tail = audio.pcm.slice(from);
    h.wake.emitWake({ confidence: 0.9 });
    for (let i = 0; i < tail.length; i += FRAME_SAMPLES) {
        h.wake.emitCommandAudio(
            tail.subarray(i, i + FRAME_SAMPLES),
            audio.sampleRate,
        );
        if (i === 0) {
            // Let the session open so the remaining frames take the live path.
            await drain();
        }
    }
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

describe("wake corpus — the engine hears post-match audio only (#121)", () => {
    it("never feeds the phrase to the wake engine", async () => {
        const h = await makeHarness();
        const audio = loadFixture("pause-then-command");
        const matchMs = 900;
        await openFromCorpus(h, audio, matchMs);
        // The engine runs microphone-free over the detector's frames, at the
        // detector's 16 kHz convention.
        expect(h.wakeStt.lastStartOptions).toEqual({
            source: "external",
            sampleRate: 16000,
        });
        // Everything fed is post-match and contiguous: the phrase (0..900 ms)
        // is behind the first frame, and no sample is repeated or spliced.
        const matchSample = Math.round((matchMs / 1000) * audio.sampleRate);
        const fed = fedAudio(h.wakeStt);
        expect(fed.length).toBe(audio.pcm.length - matchSample);
        expect(fed[0]).toBe(audio.pcm[matchSample]);
        expect(rmsOf(fed, 0, 400)).toBeLessThan(0.01);
    });

    it("shows why the strip is a net and not the fix", async () => {
        const h = await makeHarness();
        await openFromCorpus(h, loadFixture("pause-then-command"), 900);
        // The ASR's shape on 2026-10-14: the phrase stretched into extra
        // tokens. The positional matcher cannot repair an inserted token, so
        // if that junk ever reaches the engine it reaches the prompt — which
        // is why the audio path must not produce it (#121).
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

    it("keeps the phrase out of the command frames on real audio", async () => {
        // The defect this guards, measured on a real recording: the phrase is
        // loud speech, so any pre-match audio handed to the engine is a phrase
        // it must then be stripped out of the transcript. The frames start at
        // the match, where the recording is still silent.
        const h = await makeHarness();
        const audio = loadRealFixture("pause-then-command");
        const pause = findPause(audio);
        expect(pause).not.toBeNull();
        await openFromCorpus(h, audio, pause!.startMs);
        const fed = fedAudio(h.wakeStt);
        expect(h.wakeStt.lastStartOptions?.sampleRate).toBe(16000);
        // The phrase (everything before the pause) is not in the frames: the
        // first window is the pause's silence, not the phrase's speech.
        expect(rmsOf(fed, 0, 1600)).toBeLessThan(0.01);
        expect(fed.length).toBe(
            audio.pcm.length -
                Math.round((pause!.startMs / 1000) * audio.sampleRate),
        );
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

    it("streams post-match audio only, on real audio", async () => {
        // The confirmed production defect (#121): the session's audio used to
        // include the pre-match window (or be joined to it), so the phrase
        // reached the engine — twice. The frames now start at the match, so
        // the phrase is behind them and nothing is repeated.
        const h = await makeHarness();
        const audio = loadRealFixture("pause-then-command");
        const pause = findPause(audio);
        expect(pause).not.toBeNull();
        const matchMs = pause!.startMs;
        const matchSample = Math.round((matchMs / 1000) * audio.sampleRate);
        await openFromCorpus(h, audio, matchMs);
        const fed = fedAudio(h.wakeStt);
        expect(fed.length).toBe(audio.pcm.length - matchSample);
        expect(fed[0]).toBe(audio.pcm[matchSample]);
        // The opening of the stream is the pause, not the phrase: nothing the
        // phrase left behind can reach the engine.
        expect(rmsOf(fed, 0, 1600)).toBeLessThan(0.01);
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
