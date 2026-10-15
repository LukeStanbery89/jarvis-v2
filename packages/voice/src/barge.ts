/**
 * Barge-in watch (issue #84, phase 6; extracted in #110).
 *
 * A VAD-only session that listens while J.A.R.V.I.S. speaks and, on
 * sustained speech, hands the client a look-back window and asks the
 * controller to open a recognition session seeded with it:
 *
 * ```text
 * start ──► vad.start (watch callbacks + audio tap)
 *   user talks ──► ring pre-trigger audio (BARGE_IN_LOOKBACK_MS)
 *   sustained speech (BARGE_IN_SPEECH_MS) ──► fire
 *       ──► onBargeIn (client stops playback, cancels the turn)
 *       ──► onDetected(feed) ──► controller.begin({feed})
 * ```
 *
 * The watch is opportunistic: no VAD, a busy VAD (a session owns it), or a
 * dying mic track all leave it silently off — a turn that plays fine is
 * never disturbed by a failed interruption. Start/stop are serialized by a
 * generation token so a stop arriving while `vad.start()` is still in flight
 * releases the VAD instead of orphaning it (#104, race 3).
 */
import type { VoiceCore } from "./core";
import type { VadCallbacks } from "./types";

/**
 * What a barge-in trigger hands the client (#84 P6). The look-back window
 * (mono PCM at {@link BargeInDetection.lookbackSampleRate}) is the audio the
 * watch ringed before the sustained-speech trigger fired — replayed into the
 * recognition session that opens, so the interruption's opening words
 * survive the handoff. Absent when the watch's VAD had no audio tap.
 */
export interface BargeInDetection {
    /** The pre-trigger audio, for `SttProvider.feed` replay. */
    readonly lookback?: Float32Array;
    /** The look-back's sample rate; absent with the look-back. */
    readonly lookbackSampleRate?: number;
}

/**
 * Sustained speech (watch VAD reports the mic continuously loud) before the
 * barge-in trigger fires (#84 P6). Short enough to feel instant, long
 * enough that residual speaker echo — imperfectly cancelled by the
 * browser's AEC — cannot sustain a false trigger.
 */
export const BARGE_IN_SPEECH_MS = 300;

/**
 * How much pre-trigger audio the barge-in watch rings (at the watch's
 * capture rate) and replays into the recognition session it opens.
 */
export const BARGE_IN_LOOKBACK_MS = 2000;

/** Construction options for {@link BargeWatch}. */
export interface BargeWatchOptions {
    /**
     * The trigger handed to the client: fires once on sustained speech so the
     * client can stop playback and cancel the in-flight turn. A thrown or
     * rejected callback is logged and does not stop the session from opening.
     */
    readonly onBargeIn?: (detection: BargeInDetection) => void | Promise<void>;
    /**
     * Opens the recognition session seeded with the watch's look-back audio
     * (absent when the VAD had no audio tap). Always invoked once per
     * trigger, after {@link onBargeIn}.
     */
    readonly onDetected: (feed?: {
        pcm: Float32Array;
        sampleRate: number;
    }) => void;
}

/**
 * Owns the barge-in watch: its VAD sampling, its look-back ring, its
 * sustained-speech timer, and the start/stop interlock the recognition
 * session's `begin()` waits on.
 *
 * Arms and disarms are logged through `core.log` (with the lifecycle state at
 * arm time), so a client can see *when* the watch came up relative to playback
 * — the question behind #114, where the watch used to arm only once audio had
 * started and an utterance said into the silence before it was never heard.
 */
export class BargeWatch {
    private watchActive = false;
    private speechTimer: unknown = null;
    /** The look-back ring: recent analysis frames, oldest first. */
    private chunks: Float32Array[] = [];
    /** The sample rate of the ringed frames (the watch context's rate). */
    private sampleRate = 48000;
    /**
     * The in-flight VAD release of a just-disarmed watch. A recognition
     * session opening concurrently (the barge's own open) awaits it before
     * `vad.start()`, so the new session's track can never be torn down by the
     * watch's late cleanup.
     */
    private stoppingPromise: Promise<void> | null = null;
    /**
     * Generation token serializing start/stop: bumped by every `stop()`
     * (and `dispose()`), checked after the `vad.start()` await so a stop
     * arriving mid-arm releases the VAD instead of orphaning it (#104, race
     * 3). Mirrors `openWakeWord.ts`'s `initSeq`.
     */
    private seq = 0;

    /**
     * @param core - The shared context (vad, scheduler, log, stopVad).
     * @param options - The client trigger and the controller's open seam.
     */
    constructor(
        private readonly core: VoiceCore,
        private readonly options: BargeWatchOptions,
    ) {}

    /** Whether the watch currently owns the VAD. */
    get active(): boolean {
        return this.watchActive;
    }

    /**
     * The in-flight VAD release of a just-disarmed watch, or `null` when none
     * is settling. `begin()` awaits it so the watch's late cleanup cannot tear
     * down the session's track.
     */
    stopping(): Promise<void> | null {
        return this.stoppingPromise;
    }

    /**
     * Arms the watch (#84 P6): starts a VAD-only session whose callbacks
     * drive the sustained-speech trigger and whose audio tap feeds the
     * look-back ring. Silent no-op when there is no VAD, the core is
     * disposed, the watch is already armed, or no `onBargeIn` was supplied;
     * when the VAD is busy (a recognition session is live) the arming fails
     * quietly.
     *
     * @returns Resolves once the watch is armed (or silently skipped).
     */
    async start(): Promise<void> {
        if (
            this.core.vad === null ||
            this.core.isDisposed() ||
            this.watchActive ||
            this.options.onBargeIn === undefined
        ) {
            return;
        }
        const seq = ++this.seq;
        this.chunks = [];
        try {
            await this.core.vad.start(this.callbacks());
        } catch (err) {
            // VAD busy with a session, or the runtime lost the mic: the
            // watch stays off; playback and the turn are unaffected. A
            // silent barge-in is exactly the kind of failure a user
            // reports as "barge-in doesn't work" — leave a trace.
            this.core.log("barge-in watch failed to arm; staying off", err);
            return;
        }
        if (seq !== this.seq || this.core.isDisposed()) {
            // A stop() (or dispose) superseded this start while the VAD was
            // arming (#104, race 3): release what we just armed, so no one
            // is left holding a VAD the next session needs. Funnel the
            // release through `stopping()` so a concurrent `begin()` still
            // waits it out.
            await this.releaseVad();
            return;
        }
        this.watchActive = true;
        this.core.log(
            `barge-in watch armed (state=${this.core.snapshot().state})`,
        );
    }

    /**
     * Disarms the watch: cancels a pending trigger, releases the VAD, and
     * drops the look-back ring. Idempotent; never touches a recognition
     * session's VAD (the watch only stops what it armed).
     *
     * @returns Resolves once the watch is disarmed.
     */
    async stop(): Promise<void> {
        // Supersede any in-flight `start()` (and any other stop), so a start
        // still awaiting `vad.start()` releases what it armed instead of
        // marking the watch active (#104, race 3).
        this.seq++;
        this.cancelSpeechTimer();
        this.chunks = [];
        if (!this.watchActive) {
            return;
        }
        this.watchActive = false;
        this.core.log("barge-in watch disarmed");
        await this.releaseVad();
    }

    /**
     * Drops the watch without releasing the VAD (the controller's `dispose`
     * stops the VAD itself). Supersedes an in-flight start so its late
     * completion does not re-arm a dead controller.
     */
    dispose(): void {
        this.seq++;
        this.cancelSpeechTimer();
        this.chunks = [];
        this.watchActive = false;
        this.stoppingPromise = null;
    }

    /**
     * Releases the VAD and tracks the release on `stopping()`, so a
     * `begin()` racing the teardown waits it out rather than letting the late
     * release tear down the session's track.
     *
     * @returns Resolves once the VAD has stopped.
     */
    private releaseVad(): Promise<void> {
        const stopping = this.core.stopVad();
        this.stoppingPromise = stopping;
        void stopping.finally(() => {
            if (this.stoppingPromise === stopping) {
                this.stoppingPromise = null;
            }
        });
        return stopping;
    }

    /**
     * The watch's VAD callbacks: speech events drive the sustained-speech
     * trigger, and the optional audio tap feeds the look-back ring. The watch
     * has no session id — its lifetime is `watchActive`, and `stop()` clears
     * the provider's callbacks wholesale.
     *
     * @returns The callbacks object.
     */
    private callbacks(): VadCallbacks {
        return {
            onSpeechStart: () => this.onSpeechStart(),
            onSpeechEnd: () => this.onSpeechEnd(),
            onAudio: (pcm, sampleRate) => this.onAudio(pcm, sampleRate),
            onError: () => {
                // The watch died (mic track ended): disarm quietly —
                // barge-in is opportunistic and must never surface an error
                // over a turn that is playing fine.
                void this.stop();
            },
        };
    }

    /** Watch VAD heard speech: arm the sustained-speech deadline. */
    private onSpeechStart(): void {
        if (!this.watchActive || this.speechTimer !== null) {
            return;
        }
        this.speechTimer = this.core.schedule(() => {
            this.speechTimer = null;
            this.fire();
        }, BARGE_IN_SPEECH_MS);
    }

    /** Watch VAD heard the speech stop: the trigger window closed. */
    private onSpeechEnd(): void {
        this.cancelSpeechTimer();
    }

    /**
     * Watch audio tap: ring the frame into the look-back window, pruning from
     * the oldest side once the window exceeds {@link BARGE_IN_LOOKBACK_MS}.
     *
     * @param pcm - One analysis frame (mono float samples).
     * @param sampleRate - The frame's capture rate.
     */
    private onAudio(pcm: Float32Array, sampleRate: number): void {
        if (!this.watchActive) {
            return;
        }
        this.sampleRate = sampleRate;
        this.chunks.push(pcm);
        let totalMs = 0;
        for (const chunk of this.chunks) {
            totalMs += (chunk.length / sampleRate) * 1000;
        }
        // Prune from the oldest side while the remainder still covers the
        // window (never drop the last chunk — it is the audio being heard
        // right now).
        while (
            this.chunks.length > 1 &&
            totalMs - (this.chunks[0]!.length / sampleRate) * 1000 >
                BARGE_IN_LOOKBACK_MS
        ) {
            const dropped = this.chunks.shift()!;
            totalMs -= (dropped.length / sampleRate) * 1000;
        }
    }

    /**
     * The trigger fired: hand the client the look-back window (it stops
     * playback and cancels the in-flight turn), disarm the watch, and ask the
     * controller to open a recognition session replaying the interrupted
     * opening. The old turn's events are stale by session id the moment the
     * new session opens — the lifecycle's race discipline.
     */
    private fire(): void {
        if (!this.watchActive) {
            return;
        }
        this.core.log(
            `barge-in fired (${this.chunks.length} look-back chunk(s))`,
        );
        const chunks = this.chunks;
        const rate = this.sampleRate;
        void this.stop();
        const lookback = joinChunks(chunks);
        const detection: BargeInDetection =
            lookback !== undefined
                ? { lookback, lookbackSampleRate: rate }
                : {};
        try {
            // The callback may be async; a rejected promise would otherwise
            // be unhandled and, worse, silently drop the barge-in handoff
            // (#104, race 5). Log it and let the session open regardless.
            void Promise.resolve(this.options.onBargeIn?.(detection)).catch(
                (err) => this.core.log("barge-in callback rejected", err),
            );
        } catch (err) {
            // A throwing callback must not stop the session from opening.
            this.core.log("barge-in callback threw", err);
        }
        this.options.onDetected(
            lookback !== undefined
                ? { pcm: lookback, sampleRate: rate }
                : undefined,
        );
    }

    /** Cancels the pending sustained-speech timer, if any. */
    private cancelSpeechTimer(): void {
        if (this.speechTimer !== null) {
            this.core.unschedule(this.speechTimer);
            this.speechTimer = null;
        }
    }
}

/**
 * Joins the ringed look-back chunks into one contiguous buffer, in capture
 * order.
 *
 * @param chunks - The ring, oldest first.
 * @returns The joined buffer, or `undefined` when the ring is empty.
 */
function joinChunks(chunks: Float32Array[]): Float32Array | undefined {
    if (chunks.length === 0) {
        return undefined;
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
    }
    return joined;
}
