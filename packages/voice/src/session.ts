/**
 * Per-session endpointing + transcript accumulation (issue #84, phase 3;
 * extracted in #110).
 *
 * One {@link VoiceSession} owns everything that lives for exactly one
 * recognition session: the engine callbacks, the VAD callbacks, the
 * "pause ⇒ send" and "press with silence" timers, the accumulated final
 * segments, and the transcript's submission. The {@link VoiceController}
 * creates one in `begin()`, starts it, and forgets it — the reducer's
 * session id guards make a replaced session's late deliveries inert.
 *
 * Endpointing (who decides "the user stopped talking"):
 *
 * - With a VAD, this object owns it deterministically: the engine runs
 *   `{ continuous: true }` so it never finalizes on its own pause detection,
 *   `onSpeechEnd` arms {@link END_OF_SPEECH_MS}, and the expiry flushes the
 *   engine and submits the accumulated transcript. A manual press routes
 *   through the same pipeline.
 * - In a **wake** session (`external`, #121) the engine runs without a
 *   microphone over the detector's live command frames
 *   ({@link VoiceSession.pushCommandAudio}) and endpoints on its own silence
 *   detection: the first non-empty final is the whole command. A leading
 *   pause is harmless — an empty final is ignored — but because there is no
 *   VAD to bound the wait, the session also arms {@link NO_SPEECH_MS} (woke
 *   up and said nothing ⇒ quiet idle) and {@link MAX_COMMAND_MS} (a command
 *   that never pauses ⇒ flush what was heard).
 * - Otherwise the engine's own endpointing is used: the final is the
 *   whole transcript, a second press stops-and-flushes, and no timer is
 *   armed. Silence is quiet — {@link NO_SPEECH_MS} ends the session with
 *   `cancel()` and the reducer's `noSpeech`, no error banner.
 */
import type { VoiceCore } from "./core";
import { toVoiceError } from "./errors";
import type {
    SttCallbacks,
    SttProvider,
    SttStartOptions,
    VadCallbacks,
    VoiceError,
} from "./types";
import { stripWakePhrase } from "./wakeText";
import type { VoiceSubmit } from "./controller";

/**
 * Silence after detected speech before the turn is considered complete
 * ("pause ⇒ send"). Also bounds the engine's post-end-of-speech final
 * flush. Kept well under the browser engines' built-in no-speech error
 * (~8 s in Chrome) so the controller's decisions win the race.
 */
export const END_OF_SPEECH_MS = 800;

/**
 * Silence after a press with no detected speech before the session returns
 * to `idle` without an error ("press with silence ⇒ nothing, back to IDLE").
 */
export const NO_SPEECH_MS = 4000;

/**
 * Hard bound on a wake session's command (#121). A wake session has no VAD,
 * so it relies on the engine's own silence detection to end the utterance;
 * this caps a command that never pauses (a monologue, or noise the engine
 * keeps decoding) by flushing whatever was heard. Comfortably longer than a
 * spoken command, so the normal path is always the engine's final.
 */
export const MAX_COMMAND_MS = 15000;

/**
 * How much command audio a wake session holds before its engine takes it
 * (#121). Bounded at ten seconds — the same order as the detector's own
 * backlog cap (`MAX_BACKLOG_FRAMES` in the openWakeWord provider, which can
 * hand over that much plus the cut's search window in one match), so the
 * bound never truncates an opening the detector recovered; in practice the
 * engine is up in milliseconds and only a frame or two is ever held. The
 * oldest frames are dropped past the cap. Exported so the controller's
 * pre-session buffer (the wake cue window) uses the same bound.
 */
export const MAX_PENDING_COMMAND_SAMPLES = 10 * 16000;

/** Construction options for {@link VoiceSession}. */
export interface VoiceSessionOptions {
    /** The reducer session id every event is tagged with. */
    readonly sessionId: number;
    /** The engine this session transcribes through (primary or wake). */
    readonly engine: SttProvider;
    /** Whether the session opened on the wake word (strips the phrase). */
    readonly fromWake: boolean;
    /** The wake phrase removed from a wake session's transcripts. */
    readonly wakePhrase: string;
    /** Submits the final transcript as a chat turn. */
    readonly submit: VoiceSubmit;
    /**
     * Set for a **wake** session (#121): the engine runs microphone-free
     * (`source: "external"`) over the detector's live command frames, fed
     * through {@link VoiceSession.pushCommandAudio} at this sample rate.
     * Endpointing is the engine's own silence detection, guarded by
     * {@link NO_SPEECH_MS} and {@link MAX_COMMAND_MS}.
     */
    readonly external?: { readonly sampleRate: number };
}

/**
 * Owns one recognition session's endpointing, transcript accumulation, and
 * submission (issue #110).
 */
export class VoiceSession {
    private readonly core: VoiceCore;
    private readonly submit: VoiceSubmit;
    private readonly engine: SttProvider;
    private readonly sessionId: number;
    private readonly fromWake: boolean;
    private readonly wakePhrase: string;
    /**
     * The wake-session external-audio mode (#121), or `null` for every other
     * session. Non-null means the engine has no microphone and every sample
     * arrives through {@link VoiceSession.pushCommandAudio}.
     */
    private readonly external: { readonly sampleRate: number } | null;
    /** Whether the controller owns endpointing (the VAD armed for it). */
    private vadOwned = false;
    /**
     * Command frames that arrived while the engine was still opening (a wake
     * session, #121), in order. Poured into the engine the moment capture goes
     * live, so the command's opening is never lost; bounded by
     * {@link MAX_PENDING_COMMAND_SAMPLES}.
     */
    private pendingAudio: Array<{ pcm: Float32Array; sampleRate: number }> = [];
    /** Sample count in {@link pendingAudio}, for the bound. */
    private pendingAudioSamples = 0;
    /**
     * Final segments accumulated during a continuous (VAD-owned) session.
     * In continuous capture the engine may deliver a final per spoken
     * segment while recognition continues; only the joined text is the
     * transcript. Empty in engine-native sessions.
     */
    private finals: string[] = [];
    /**
     * Whether any speech evidence (a VAD speech-start, a partial, or a
     * final) has arrived this session. Distinguishes "press with silence"
     * from "the user spoke" when arming the silence guard after the engine
     * starts (issue #104, race 1).
     */
    private heardSpeech = false;
    /**
     * VAD speech-end observed while the engine was still starting (a cold
     * engine loading its model — #104 race 1): the end-of-speech timer
     * cannot be armed until capture is live, so the decision is deferred
     * and the timer armed when `stt.start()` resolves.
     */
    private deferredSpeechEnd = false;
    /**
     * Pending silence guard: armed at press (no speech ⇒ quiet idle) and
     * re-armed after end-of-speech (flush deadline). `null` when not pending.
     */
    private noSpeechTimer: unknown = null;
    /** Pending end-of-speech timer; `null` when not pending. */
    private endOfSpeechTimer: unknown = null;
    /** Pending wake-command bound (#121); `null` when not pending. */
    private commandTimer: unknown = null;

    /**
     * @param core - The shared context (reducer, timers, VAD, log).
     * @param options - The session id, engine, wake flag, external-audio
     * mode, and submit seam.
     */
    constructor(core: VoiceCore, options: VoiceSessionOptions) {
        this.core = core;
        this.submit = options.submit;
        this.engine = options.engine;
        this.sessionId = options.sessionId;
        this.fromWake = options.fromWake;
        this.wakePhrase = options.wakePhrase;
        this.external = options.external ?? null;
    }

    /** The reducer session id this session owns. */
    get id(): number {
        return this.sessionId;
    }

    /** Marks whether the controller owns endpointing (the VAD armed). */
    setVadOwned(value: boolean): void {
        this.vadOwned = value;
    }

    /**
     * Whether this session is a live wake session that consumes the detector's
     * command frames (#121). The controller routes frames with it: push while
     * true, hold while the session is still opening, drop otherwise.
     *
     * @returns True when this is the live listening external session.
     */
    acceptsCommandAudio(): boolean {
        return (
            this.external !== null &&
            this.core.snapshot().sessionId === this.sessionId &&
            this.core.snapshot().state === "listening"
        );
    }

    /**
     * Feeds one frame of the detector's post-match command audio (#121). While
     * the engine is still opening the frame is held (bounded) and poured in
     * order once capture is live, so the command's opening survives the model
     * load; after that it goes straight to the engine. Frames arriving once
     * the session stopped listening are dropped, so a finished turn's tail can
     * never leak into the next command.
     *
     * @param pcm - Mono PCM samples normalized to `[-1, 1]`.
     * @param sampleRate - The rate the detector captured `pcm` at.
     */
    pushCommandAudio(pcm: Float32Array, sampleRate: number): void {
        if (!this.acceptsCommandAudio()) {
            return;
        }
        if (this.engine.state === "running") {
            this.engine.feed?.(pcm, sampleRate);
            return;
        }
        this.pendingAudio.push({ pcm, sampleRate });
        this.pendingAudioSamples += pcm.length;
        while (
            this.pendingAudioSamples > MAX_PENDING_COMMAND_SAMPLES &&
            this.pendingAudio.length > 0
        ) {
            const dropped = this.pendingAudio.shift();
            if (dropped !== undefined) {
                this.pendingAudioSamples -= dropped.pcm.length;
            }
        }
    }

    /**
     * Starts the engine and, now that capture is live, arms the endpointing
     * decision (issue #104, race 1 — a cold engine must not have its
     * deadlines tick during the model load).
     *
     * @param replay - Pre-session audio to feed the engine (a barge-in watch's
     * ring), or `null`. Wake sessions feed their audio live through
     * {@link VoiceSession.pushCommandAudio} instead.
     * @returns Resolves once the engine is capturing (or failed).
     */
    async start(
        replay: { pcm: Float32Array; sampleRate: number } | null,
    ): Promise<void> {
        const startOptions: SttStartOptions = {
            ...(this.vadOwned ? { continuous: true } : {}),
            ...(this.external !== null
                ? {
                      source: "external" as const,
                      sampleRate: this.external.sampleRate,
                  }
                : {}),
            ...(replay !== null ? { feed: replay } : {}),
        };
        const needsOptions =
            startOptions.continuous === true ||
            startOptions.feed !== undefined ||
            startOptions.source !== undefined;
        try {
            await this.engine.start(
                this.engineCallbacks(),
                needsOptions ? startOptions : undefined,
            );
            // Pour the command frames held while the engine opened (#121), in
            // order and before any later frame.
            if (this.external !== null && this.pendingAudio.length > 0) {
                const held = this.pendingAudio;
                this.pendingAudio = [];
                this.pendingAudioSamples = 0;
                for (const chunk of held) {
                    this.engine.feed?.(chunk.pcm, chunk.sampleRate);
                }
            }
            const mode = this.vadOwned
                ? "vad-owned endpointing"
                : this.external !== null
                  ? "detector-fed command audio"
                  : "engine-native endpointing";
            this.core.log(
                `session ${this.sessionId}: listening (${mode}${
                    replay !== null ? ", replayed look-back" : ""
                })`,
            );
            // Arm endpointing only now that the engine is actually
            // capturing: a cold engine (Vosk loading its ~40 MB model) must
            // not have its no-speech deadline tick during the load, or the
            // first-ever press dies mid-download (#104, race 1). If speech
            // already happened while the engine was starting, honor it
            // instead of arming a "silence" guard.
            if (
                this.core.snapshot().sessionId === this.sessionId &&
                this.core.snapshot().state === "listening"
            ) {
                if (this.vadOwned) {
                    if (this.deferredSpeechEnd) {
                        this.armEndOfSpeechTimer();
                    } else if (!this.heardSpeech) {
                        this.armNoSpeechTimer();
                    }
                } else if (this.external !== null) {
                    // A wake session has no VAD to bound either wait: the
                    // silence guard covers "woke up and said nothing", the
                    // command bound a command that never pauses (#121).
                    this.armNoSpeechTimer();
                    this.armCommandTimer();
                }
            }
        } catch (err) {
            this.clearTimers();
            void this.core.stopVad();
            this.core.reduce({
                type: "transcriptFailed",
                sessionId: this.sessionId,
                error: toVoiceError(err),
            });
        }
    }

    /**
     * Ends capture by user decision ("send now"): in a VAD session that is
     * the same end-of-speech pipeline the timer drives; otherwise the
     * engine-native stop-and-flush, whose final transcript (if any) arrives
     * through the callbacks.
     *
     * @param reason - Log label for why capture ended.
     * @returns Resolves once the stop/flush has settled.
     */
    async finish(reason = "manual stop requested"): Promise<void> {
        this.core.log(`session ${this.sessionId}: ${reason}`);
        if (this.vadOwned && this.core.snapshot().state === "listening") {
            await this.onEndOfSpeechTimeout();
            return;
        }
        this.clearTimers();
        void this.core.stopVad();
        try {
            await this.engine.stop();
        } catch {
            // Engine failures surface through onError; nothing to do here.
        }
    }

    /** Cancels the session's pending timers and held audio (teardown). */
    dispose(): void {
        this.clearTimers();
        this.pendingAudio = [];
        this.pendingAudioSamples = 0;
    }

    /**
     * Per-session VAD callbacks; every handler re-checks the session id so
     * events from a detector armed for a replaced session are ignored.
     *
     * @returns The callbacks object.
     */
    vadCallbacks(): VadCallbacks {
        return {
            onSpeechStart: () => this.onSpeechStart(),
            onSpeechEnd: () => this.onSpeechEnd(),
            onError: (error) => this.onVadError(error),
        };
    }

    /**
     * The engine's per-session callbacks, tagged to this session's id so a
     * late delivery after re-activation is stale by construction.
     *
     * @returns The callbacks object.
     */
    private engineCallbacks(): SttCallbacks {
        return {
            onPartial: (text) => this.onPartial(text),
            onResult: (text) => this.onTranscript(text),
            onError: (error) => this.onEngineError(error),
        };
    }

    /**
     * Speech began: the silence guard is moot, and a pending end-of-speech
     * timer means speech resumed inside the "pause ⇒ send" window — cancel
     * it (the user was not done talking).
     */
    private onSpeechStart(): void {
        if (
            this.core.snapshot().sessionId !== this.sessionId ||
            this.core.snapshot().state !== "listening"
        ) {
            return;
        }
        this.core.log(`session ${this.sessionId}: speech start`);
        this.heardSpeech = true;
        this.deferredSpeechEnd = false;
        this.cancelNoSpeechTimer();
        this.cancelEndOfSpeechTimer();
    }

    /**
     * Speech ended: arm the "pause ⇒ send" timer (unless one is already
     * pending) — its expiry ends the capture and flushes the engine.
     */
    private onSpeechEnd(): void {
        if (
            this.core.snapshot().sessionId !== this.sessionId ||
            this.core.snapshot().state !== "listening" ||
            this.endOfSpeechTimer !== null
        ) {
            return;
        }
        this.heardSpeech = true;
        if (this.engine.state === "starting") {
            // The engine is still opening (cold model load): an end-of-speech
            // armed now would expire before the engine can capture the tail
            // of the utterance. Record the intent and let `start`'s
            // post-start block arm the timer once capture is live (#104,
            // race 1).
            this.deferredSpeechEnd = true;
            return;
        }
        this.armEndOfSpeechTimer();
    }

    /**
     * The VAD died mid-session (e.g. its microphone track ended): end the
     * session with the error, cancelling the engine — in continuous capture
     * the engine would otherwise run on with no endpointer.
     *
     * @param error - The detector's failure.
     */
    private onVadError(error: VoiceError): void {
        if (this.core.snapshot().sessionId !== this.sessionId) {
            return;
        }
        this.clearTimers();
        void this.engine.cancel();
        this.core.reduce({
            type: "transcriptFailed",
            sessionId: this.sessionId,
            error,
        });
    }

    /**
     * "pause ⇒ send": enter `transcribing`, stop the VAD, and flush the
     * engine — its final segment (if any) completes the accumulated
     * transcript. Also the pipeline a manual press routes through in VAD
     * sessions.
     *
     * @returns Resolves once the flush decision has settled.
     */
    private async onEndOfSpeechTimeout(): Promise<void> {
        if (
            this.core.snapshot().sessionId !== this.sessionId ||
            this.core.snapshot().state !== "listening"
        ) {
            return;
        }
        if (this.engine.state === "starting") {
            // A timer that predates the engine going live (cold start): defer
            // the flush to `start`'s post-start block, which arms the
            // end-of-speech timer once capture is actually running (#104,
            // race 1).
            this.deferredSpeechEnd = true;
            return;
        }
        this.core.reduce({ type: "endOfSpeech", sessionId: this.sessionId });
        this.core.log(
            `session ${this.sessionId}: pause window elapsed; flushing engine`,
        );
        void this.core.stopVad();
        // The flush deadline stays armed as the safety net for a wedged
        // engine — but the normal path does not wait for it.
        this.armNoSpeechTimer();
        try {
            // Awaiting the flush means the transcript decision happens the
            // moment the engine settles (vosk: ≤ flushWaitMs; Web Speech:
            // its own `onend`) — a final result submits through
            // `onTranscript` while we wait. Previously this was
            // fire-and-forget: an engine flush that produced no final
            // (continuous mode suppresses the no-speech error) parked the
            // user on the full deadline before the partials were submitted,
            // which read as "it doesn't submit until I say something else".
            await this.engine.stop();
        } catch {
            // Engine failures surface through onError.
        }
        if (
            this.core.snapshot().sessionId !== this.sessionId ||
            // A fresh read through the getter — the top guard's narrowing
            // (state === "listening") is stale across the flush await.
            this.core.snapshot().state !== "transcribing"
        ) {
            // The flush's own final already submitted (or the session
            // failed) — nothing left to decide.
            return;
        }
        if (this.finals.length > 0) {
            this.submitAccumulated();
            return;
        }
        // The flush settled with nothing recognized at all: end the
        // session quietly instead of parking it until the deadline.
        this.clearTimers();
        void this.engine.cancel();
        void this.core.stopVad();
        this.core.reduce({ type: "noSpeech", sessionId: this.sessionId });
    }

    /**
     * The recognition engine failed: end the session with the error.
     *
     * @param error - The engine's mapped failure.
     */
    private onEngineError(error: VoiceError): void {
        this.clearTimers();
        void this.core.stopVad();
        this.core.reduce({
            type: "transcriptFailed",
            sessionId: this.sessionId,
            error,
        });
    }

    /**
     * Interim recognition text: local UI display only (partials must never
     * be submitted). Composes the interim tail behind any final segments
     * already accumulated, so the live transcript reads as one text in
     * continuous capture. Any speech evidence also cancels the silence
     * guard — recognition seeing words beats the timer deciding there
     * were none.
     *
     * @param text - The interim segment text (already trimmed by the engine).
     */
    private onPartial(text: string): void {
        if (this.core.snapshot().sessionId === this.sessionId) {
            this.heardSpeech = true;
            this.deferredSpeechEnd = false;
        }
        this.cancelNoSpeechTimer();
        const cleaned = this.fromWake
            ? stripWakePhrase(text, this.wakePhrase)
            : text;
        const display = [this.displayText(), cleaned].filter(Boolean).join(" ");
        this.core.reduce({
            type: "partial",
            sessionId: this.sessionId,
            text: display,
        });
    }

    /**
     * Handles a final transcript. Engine-native sessions: the final is the
     * whole transcript — record it and submit. Continuous (VAD-owned)
     * sessions: finals are segments of a continuing capture — accumulate
     * them for display while listening, and on the post-end-of-speech flush
     * submit the accumulated text.
     *
     * @param text - The final transcript (or final segment).
     */
    private onTranscript(text: string): void {
        if (this.core.snapshot().sessionId === this.sessionId) {
            this.heardSpeech = true;
            this.deferredSpeechEnd = false;
        }
        if (
            this.vadOwned &&
            this.core.snapshot().sessionId === this.sessionId
        ) {
            if (this.core.snapshot().state === "listening") {
                if (text !== "") {
                    this.finals.push(text);
                }
                this.core.reduce({
                    type: "partial",
                    sessionId: this.sessionId,
                    text: this.displayText(),
                });
                return;
            }
            if (this.core.snapshot().state === "transcribing") {
                if (text !== "") {
                    this.finals.push(text);
                }
                this.submitAccumulated();
                return;
            }
            return;
        }
        // Engine-native sessions: the final is the whole transcript. In a
        // wake session it includes the wake phrase, which must be stripped
        // before it reaches display or submission.
        const cleaned = this.fromWake
            ? stripWakePhrase(text, this.wakePhrase)
            : text;
        this.core.reduce({
            type: "transcript",
            sessionId: this.sessionId,
            text: cleaned,
        });
        const next = this.core.snapshot();
        if (next.state === "submitting" && next.transcript !== null) {
            // A usable final ends the session's endpointing (an ignored empty
            // one leaves the guards armed).
            this.clearTimers();
            if (this.fromWake) {
                // #121, lesson 6: what was heard vs what is sent.
                this.core.traceTranscript(text, next.transcript);
            }
            this.dispatchTurn(next.transcript);
        }
    }

    /**
     * Submits the accumulated continuous-capture transcript: records it
     * (moving to `waiting`), dispatches the turn under the same session id —
     * or, when nothing usable was recognized (a VAD false-trigger on
     * noise), ends the session quietly rather than stranding it in
     * `transcribing`.
     */
    private submitAccumulated(): void {
        this.clearTimers();
        this.core.reduce({
            type: "transcript",
            sessionId: this.sessionId,
            text: this.displayText(),
        });
        const next = this.core.snapshot();
        if (next.state === "submitting" && next.transcript !== null) {
            if (this.fromWake) {
                // #121, lesson 6: what was heard vs what is sent.
                this.core.traceTranscript(this.rawText(), next.transcript);
            }
            this.dispatchTurn(next.transcript);
            return;
        }
        void this.engine.cancel();
        this.core.reduce({ type: "noSpeech", sessionId: this.sessionId });
    }

    /**
     * The accumulated final segments as one unmodified transcript text — the
     * engine's own words, before any wake-phrase stripping. The raw half of
     * the submit trace (#121, lesson 6).
     *
     * @returns The joined text, trimmed; empty when nothing was recognized.
     */
    private rawText(): string {
        return this.finals.join(" ").trim();
    }

    /**
     * The accumulated final segments as one transcript text. In a wake
     * session the segments begin with the wake phrase and are stripped for
     * display and submission alike.
     *
     * @returns The joined text, trimmed; empty when nothing was recognized.
     */
    private displayText(): string {
        const text = this.rawText();
        return this.fromWake ? stripWakePhrase(text, this.wakePhrase) : text;
    }

    /**
     * Dispatches a recorded transcript as a chat turn, routing the turn's
     * end (resolved/rejected) back through the reducer under the same
     * session id.
     *
     * @param prompt - The transcript text to submit.
     */
    private dispatchTurn(prompt: string): void {
        this.core.reduce({ type: "submitted", sessionId: this.sessionId });
        void this.submit(prompt)
            .then(() => {
                this.core.reduce({
                    type: "responseEnded",
                    sessionId: this.sessionId,
                });
            })
            .catch((err: unknown) => {
                this.core.reduce({
                    type: "rejected",
                    sessionId: this.sessionId,
                    error: {
                        code: "rejected",
                        message:
                            err instanceof Error
                                ? err.message
                                : "the request failed",
                    },
                });
            });
    }

    /**
     * The silence deadline fired: with nothing recognized (press with
     * silence, or a flush that produced nothing usable) end the session
     * quietly — abort the engine (no callbacks fire) and return to `idle`
     * via the reducer's `noSpeech`, which records no error. If captured
     * speech exists but the flush never delivered a final segment, submit
     * what was recognized instead.
     */
    private onNoSpeechTimeout(): void {
        if (this.core.snapshot().sessionId !== this.sessionId) {
            return;
        }
        const state = this.core.snapshot().state;
        if (state !== "listening" && state !== "transcribing") {
            return;
        }
        this.clearTimers();
        if (state === "transcribing" && this.finals.length > 0) {
            this.core.log(
                `session ${this.sessionId}: flush deadline with partial transcript; submitting what was heard`,
            );
            this.submitAccumulated();
            return;
        }
        this.core.log(
            `session ${this.sessionId}: no speech detected; going quiet`,
        );
        void this.engine.cancel();
        void this.core.stopVad();
        this.core.reduce({ type: "noSpeech", sessionId: this.sessionId });
    }

    /**
     * Arms the silence guard (press with no speech; after end-of-speech, the
     * flush deadline). No-op while one is already pending.
     */
    private armNoSpeechTimer(): void {
        if (this.noSpeechTimer !== null) {
            return;
        }
        this.noSpeechTimer = this.core.schedule(() => {
            this.noSpeechTimer = null;
            this.onNoSpeechTimeout();
        }, NO_SPEECH_MS);
    }

    /** Cancels the pending silence guard, if any. */
    private cancelNoSpeechTimer(): void {
        if (this.noSpeechTimer !== null) {
            this.core.unschedule(this.noSpeechTimer);
            this.noSpeechTimer = null;
        }
    }

    /**
     * Arms the "pause ⇒ send" timer. No-op while one is already pending.
     */
    private armEndOfSpeechTimer(): void {
        if (this.endOfSpeechTimer !== null) {
            return;
        }
        this.core.log(
            `session ${this.sessionId}: speech end; pausing ${END_OF_SPEECH_MS}ms before sending`,
        );
        this.endOfSpeechTimer = this.core.schedule(() => {
            this.endOfSpeechTimer = null;
            void this.onEndOfSpeechTimeout();
        }, END_OF_SPEECH_MS);
    }

    /** Cancels the pending end-of-speech timer, if any. */
    private cancelEndOfSpeechTimer(): void {
        if (this.endOfSpeechTimer !== null) {
            this.core.unschedule(this.endOfSpeechTimer);
            this.endOfSpeechTimer = null;
        }
    }

    /**
     * Arms the wake-command bound (#121). No-op while one is already pending.
     */
    private armCommandTimer(): void {
        if (this.commandTimer !== null) {
            return;
        }
        this.commandTimer = this.core.schedule(() => {
            this.commandTimer = null;
            void this.onCommandTimeout();
        }, MAX_COMMAND_MS);
    }

    /**
     * The command bound fired (#121): the session has been listening for
     * {@link MAX_COMMAND_MS} without the engine ending the utterance. Stop
     * capture and flush — the engine's final (if any) submits through
     * {@link VoiceSession.onTranscript}; a flush with nothing left ends the
     * session through the engine's own no-speech path.
     */
    private async onCommandTimeout(): Promise<void> {
        if (!this.acceptsCommandAudio()) {
            return;
        }
        await this.finish("command window elapsed; flushing engine");
    }

    /** Cancels the pending command bound, if any. */
    private cancelCommandTimer(): void {
        if (this.commandTimer !== null) {
            this.core.unschedule(this.commandTimer);
            this.commandTimer = null;
        }
    }

    /** Cancels all pending timers (session decision made). */
    private clearTimers(): void {
        this.cancelNoSpeechTimer();
        this.cancelEndOfSpeechTimer();
        this.cancelCommandTimer();
    }
}
