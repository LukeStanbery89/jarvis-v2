/**
 * Voice-session controller (issue #84, phases 2–3).
 *
 * Binds the pure session lifecycle (`./lifecycle`) to a real STT engine, an
 * optional VAD, and turn submission, so a client UI renders from a
 * `VoiceSnapshot` and never touches microphone semantics directly. The
 * controller is deliberately React-free and engine-free (injected
 * {@link SttProvider}, {@link VadProvider}, submit function, timer seams) so
 * the whole flow is unit-testable in the node environment with fakes. Any
 * J.A.R.V.I.S. voice client consumes it; the chat view only supplies the
 * web-specific seams (a submit that runs a turn, response-frame forwarding).
 *
 * Endpointing — who decides "the user stopped talking":
 *
 * - With a `vad` armed, the controller owns endpointing deterministically
 *   (issue #84, phase 3). The engine is started `{ continuous: true }` so it
 *   never finalizes on its own pause detection (final-segment results may
 *   still arrive and are accumulated); the controller arms an end-of-speech
 *   timer on the VAD's speech-end event, flushes the engine (`stt.stop()`)
 *   when it expires, and submits the accumulated transcript. A press during
 *   the same silence window (`finish`) routes through the same pipeline —
 *   the manual press is just another end-of-speech decision.
 * - Without a `vad` (unsupported runtime, e.g. Firefox), behavior is the
 *   engine's own: it finalizes on its silence detection, a second press
 *   stops-and-flushes, and no timer is ever armed.
 *
 * Silence handling is quiet: a press that never hears speech ends with
 * `stt.cancel()` (no callbacks fire) and the reducer's `noSpeech` event, so
 * the UI returns to `idle` without an error banner.
 *
 * Flow of one press-to-talk turn:
 *
 * ```text
 * press ──► activate ──► vad.start + stt.start ──► arm no-speech timer
 *                             │ speechStart ──► cancel timers
 *                             │ speechEnd   ──► arm end-of-speech timer
 *                             │ (expiry) endOfSpeech ──► transcribing
 *                             │             ──► stt.stop() flush
 *                             │ final ──► submit accumulated transcript
 *      no speech in time ─────┤ noSpeech ──► idle (quiet, cancel())
 *      first server frame ────┤ noteResponseFrame ──► responding
 *      turn resolves ─────────┴ responseEnded ──► idle
 *      turn rejects ────────────── rejected ────► idle (error recorded)
 * ```
 *
 * Race safety is inherited from the lifecycle reducer: recognition events
 * are tagged with the session id captured at activation, turn events are
 * tagged at dispatch, and the reducer ignores anything stale — so a late
 * engine callback, a stale VAD event, or an old turn's end can never
 * disturb a newer session.
 */
import { initialVoiceSnapshot, reduceVoice } from "./lifecycle";
import type { VoiceSnapshot } from "./lifecycle";
import type {
    SttProvider,
    VadCallbacks,
    VadProvider,
    VoiceError,
} from "./types";

/** Submits a final transcript as a chat turn (resolves when the turn settles). */
export type VoiceSubmit = (text: string) => Promise<void>;

/** Construction options for {@link VoiceController}. */
export interface VoiceControllerOptions {
    /** The STT engine driving recognition. */
    readonly stt: SttProvider;
    /** Submits the final transcript; rejection ends the voice turn as `rejected`. */
    readonly submit: VoiceSubmit;
    /**
     * The voice-activity detector driving end-of-speech and no-speech timing
     * (issue #84, phase 3). `null`/omitted keeps the engine's own
     * endpointing: it finalizes on its pause detection and a second press
     * stops-and-flushes.
     */
    readonly vad?: VadProvider | null;
    /**
     * Schedules a callback after `ms` milliseconds and returns an opaque
     * handle for {@link VoiceControllerOptions.unschedule}. Defaults to
     * `setTimeout`; injectable so tests drive timer expiry deterministically.
     */
    readonly schedule?: (callback: () => void, ms: number) => unknown;
    /**
     * Cancels a pending callback scheduled by
     * {@link VoiceControllerOptions.schedule}. Defaults to `clearTimeout`.
     */
    readonly unschedule?: (handle: unknown) => void;
}

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
 * Owns one user's voice session: mic presses, engine and VAD wiring,
 * transcript submission, and the observable {@link VoiceSnapshot} the UI
 * renders.
 */
export class VoiceController {
    private snapshot = initialVoiceSnapshot;
    private readonly listeners = new Set<() => void>();
    private readonly stt: SttProvider;
    private readonly submit: VoiceSubmit;
    private readonly vad: VadProvider | null;
    private readonly schedule: (callback: () => void, ms: number) => unknown;
    private readonly unschedule: (handle: unknown) => void;
    /**
     * Pending silence guard: armed at press (no speech ⇒ quiet idle) and
     * re-armed after end-of-speech (flush deadline). `null` when not pending.
     */
    private noSpeechTimer: unknown = null;
    /** Pending end-of-speech timer; `null` when not pending. */
    private endOfSpeechTimer: unknown = null;
    /** Whether the current session runs with the controller owning endpointing. */
    private vadSession = false;
    /**
     * Final segments accumulated during a continuous (VAD-owned) session.
     * In continuous capture the engine may deliver a final per spoken
     * segment while recognition continues; only the joined text is the
     * transcript. Empty in engine-native sessions.
     */
    private finals: string[] = [];

    /**
     * @param options - The engine, the submit seam, the optional VAD, and
     * the optional timer seams (see {@link VoiceControllerOptions}).
     */
    constructor(options: VoiceControllerOptions) {
        this.stt = options.stt;
        this.submit = options.submit;
        this.vad = options.vad ?? null;
        this.schedule =
            options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
        this.unschedule =
            options.unschedule ??
            ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    /**
     * The current snapshot (stable reference between events, as
     * `useSyncExternalStore` requires).
     */
    getSnapshot(): VoiceSnapshot {
        return this.snapshot;
    }

    /**
     * Subscribes to snapshot changes.
     *
     * @param listener - Called after every applied event.
     * @returns Unsubscribe function.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * The mic button: starts listening from `idle`, or stops-and-transcribes
     * while `listening` (in VAD sessions that is the same end-of-speech
     * pipeline the timer drives). Mid-flight states
     * (transcribing/submitting/turn) are deliberately inert until barge-in
     * (phase 6).
     */
    press(): void {
        if (this.snapshot.state === "idle") {
            void this.begin();
        } else if (this.snapshot.state === "listening") {
            void this.finish();
        }
    }

    /**
     * The chat view forwards every server frame here; only the first frame
     * of a voice turn matters (`waiting` → `responding`). All other calls —
     * text-mode turns, repeats — fall through the reducer's state guards.
     */
    noteResponseFrame(): void {
        this.reduce({
            type: "responseStarted",
            sessionId: this.snapshot.sessionId,
        });
    }

    /**
     * The chat view calls this on the turn's `audioStart` frame (#83):
     * `waiting`/`responding` → `speaking`, which the status line renders as
     * "Speaking…" until the turn's `done`. Calls for text-mode turns fall
     * through the reducer's state guards.
     */
    noteAudioStarted(): void {
        this.reduce({
            type: "audioStarted",
            sessionId: this.snapshot.sessionId,
        });
    }

    /**
     * Tears down: cancels any live recognition, stops the VAD, drops any
     * pending timers, and drops listeners.
     *
     * @returns Resolves when the engine and the detector have stopped.
     */
    async dispose(): Promise<void> {
        this.clearTimers();
        await this.stt.cancel();
        await this.stopVad();
        this.listeners.clear();
    }

    /**
     * Starts a session: opens it in the reducer, arms the VAD (its success
     * decides whether this session runs continuous capture under the
     * controller's endpointing), then arms the engine with callbacks tagged
     * to the (captured) session id, so late deliveries after a
     * re-activation are stale by construction.
     */
    private async begin(): Promise<void> {
        this.reduce({ type: "activate" });
        const sessionId = this.snapshot.sessionId;
        this.finals = [];
        let vadArmed = false;
        if (this.vad !== null) {
            try {
                await this.vad.start(this.vadCallbacks(sessionId));
                vadArmed = true;
            } catch {
                // Detector unavailable (e.g. no microphone track): fall back
                // to the engine's own endpointing for this session.
            }
        }
        this.vadSession = vadArmed;
        if (vadArmed) {
            this.armNoSpeechTimer(sessionId);
        }
        try {
            await this.stt.start(
                {
                    onPartial: (text) => this.onPartial(sessionId, text),
                    onResult: (text) => this.onTranscript(sessionId, text),
                    onError: (error) => this.onEngineError(sessionId, error),
                },
                vadArmed ? { continuous: true } : undefined,
            );
        } catch (err) {
            this.clearTimers();
            void this.stopVad();
            this.reduce({
                type: "transcriptFailed",
                sessionId,
                error: toVoiceError(err),
            });
        }
    }

    /**
     * Ends capture by user decision ("send now"): in a VAD session that is
     * the same end-of-speech pipeline the timer drives; otherwise the
     * engine-native stop-and-flush, whose final transcript (if any) arrives
     * through the callbacks.
     */
    private async finish(): Promise<void> {
        if (this.vadSession && this.snapshot.state === "listening") {
            this.onEndOfSpeechTimeout(this.snapshot.sessionId);
            return;
        }
        this.clearTimers();
        void this.stopVad();
        try {
            await this.stt.stop();
        } catch {
            // Engine failures surface through onError; nothing to do here.
        }
    }

    /**
     * Per-session VAD callbacks; every handler re-checks the session id so
     * events from a detector armed for a replaced session are ignored.
     *
     * @param sessionId - The session the detector was armed for.
     * @returns The callbacks object.
     */
    private vadCallbacks(sessionId: number): VadCallbacks {
        return {
            onSpeechStart: () => this.onSpeechStart(sessionId),
            onSpeechEnd: () => this.onSpeechEnd(sessionId),
            onError: (error) => this.onVadError(sessionId, error),
        };
    }

    /**
     * Speech began: the silence guard is moot, and a pending end-of-speech
     * timer means speech resumed inside the "pause ⇒ send" window — cancel
     * it (the user was not done talking).
     *
     * @param sessionId - The session the detector was armed for.
     */
    private onSpeechStart(sessionId: number): void {
        if (
            this.snapshot.sessionId !== sessionId ||
            this.snapshot.state !== "listening"
        ) {
            return;
        }
        this.cancelNoSpeechTimer();
        this.cancelEndOfSpeechTimer();
    }

    /**
     * Speech ended: arm the "pause ⇒ send" timer (unless one is already
     * pending) — its expiry ends the capture and flushes the engine.
     *
     * @param sessionId - The session the detector was armed for.
     */
    private onSpeechEnd(sessionId: number): void {
        if (
            this.snapshot.sessionId !== sessionId ||
            this.snapshot.state !== "listening" ||
            this.endOfSpeechTimer !== null
        ) {
            return;
        }
        this.endOfSpeechTimer = this.schedule(() => {
            this.endOfSpeechTimer = null;
            this.onEndOfSpeechTimeout(sessionId);
        }, END_OF_SPEECH_MS);
    }

    /**
     * The VAD died mid-session (e.g. its microphone track ended): end the
     * session with the error, cancelling the engine — in continuous capture
     * the engine would otherwise run on with no endpointer.
     *
     * @param sessionId - The session the detector was armed for.
     * @param error - The detector's failure.
     */
    private onVadError(sessionId: number, error: VoiceError): void {
        if (this.snapshot.sessionId !== sessionId) {
            return;
        }
        this.clearTimers();
        void this.stt.cancel();
        this.reduce({ type: "transcriptFailed", sessionId, error });
    }

    /**
     * "pause ⇒ send": enter `transcribing`, stop the VAD, and flush the
     * engine — its final segment (if any) completes the accumulated
     * transcript. Also the pipeline a manual press routes through in VAD
     * sessions.
     *
     * @param sessionId - The session being endpointed.
     */
    private onEndOfSpeechTimeout(sessionId: number): void {
        if (
            this.snapshot.sessionId !== sessionId ||
            this.snapshot.state !== "listening"
        ) {
            return;
        }
        this.reduce({ type: "endOfSpeech", sessionId });
        void this.stopVad();
        void this.stt.stop().catch(() => {
            // Engine failures surface through onError; nothing to do here.
        });
        // Flush deadline: the transcript must land within NO_SPEECH_MS or
        // the session gives up (submitting what it has, or going quiet).
        this.armNoSpeechTimer(sessionId);
    }

    /**
     * The recognition engine failed: end the session with the error.
     *
     * @param sessionId - The session the engine was armed for.
     * @param error - The engine's mapped failure.
     */
    private onEngineError(sessionId: number, error: VoiceError): void {
        this.clearTimers();
        void this.stopVad();
        this.reduce({ type: "transcriptFailed", sessionId, error });
    }

    /**
     * Interim recognition text: local UI display only (partials must never
     * be submitted). Composes the interim tail behind any final segments
     * already accumulated, so the live transcript reads as one text in
     * continuous capture. Any speech evidence also cancels the silence
     * guard — recognition seeing words beats the timer deciding there
     * were none.
     *
     * @param sessionId - The session the engine was armed for.
     * @param text - The interim segment text (already trimmed by the engine).
     */
    private onPartial(sessionId: number, text: string): void {
        this.cancelNoSpeechTimer();
        const display = [this.displayText(), text].filter(Boolean).join(" ");
        this.reduce({ type: "partial", sessionId, text: display });
    }

    /**
     * Handles a final transcript. Engine-native sessions: the final is the
     * whole transcript — record it and submit. Continuous (VAD-owned)
     * sessions: finals are segments of a continuing capture — accumulate
     * them for display while listening, and on the post-end-of-speech flush
     * submit the accumulated text.
     *
     * @param sessionId - The session the engine was armed for.
     * @param text - The final transcript (or final segment).
     */
    private onTranscript(sessionId: number, text: string): void {
        if (this.vadSession && this.snapshot.sessionId === sessionId) {
            if (this.snapshot.state === "listening") {
                if (text !== "") {
                    this.finals.push(text);
                }
                this.reduce({
                    type: "partial",
                    sessionId,
                    text: this.displayText(),
                });
                return;
            }
            if (this.snapshot.state === "transcribing") {
                if (text !== "") {
                    this.finals.push(text);
                }
                this.submitAccumulated(sessionId);
                return;
            }
            return;
        }
        this.reduce({ type: "transcript", sessionId, text });
        if (
            this.snapshot.state === "submitting" &&
            this.snapshot.transcript !== null
        ) {
            this.dispatchTurn(sessionId, this.snapshot.transcript);
        }
    }

    /**
     * Submits the accumulated continuous-capture transcript: records it
     * (moving to `waiting`), dispatches the turn under the same session id —
     * or, when nothing usable was recognized (a VAD false-trigger on
     * noise), ends the session quietly rather than stranding it in
     * `transcribing`.
     *
     * @param sessionId - The session being submitted.
     */
    private submitAccumulated(sessionId: number): void {
        this.clearTimers();
        this.reduce({
            type: "transcript",
            sessionId,
            text: this.displayText(),
        });
        if (
            this.snapshot.state === "submitting" &&
            this.snapshot.transcript !== null
        ) {
            this.dispatchTurn(sessionId, this.snapshot.transcript);
            return;
        }
        void this.stt.cancel();
        this.reduce({ type: "noSpeech", sessionId });
    }

    /**
     * The accumulated final segments as one transcript text.
     *
     * @returns The joined text, trimmed; empty when nothing was recognized.
     */
    private displayText(): string {
        return this.finals.join(" ").trim();
    }

    /**
     * Dispatches a recorded transcript as a chat turn, routing the turn's
     * end (resolved/rejected) back through the reducer under the same
     * session id.
     *
     * @param sessionId - The session being submitted.
     * @param prompt - The transcript text to submit.
     */
    private dispatchTurn(sessionId: number, prompt: string): void {
        this.reduce({ type: "submitted", sessionId });
        void this.submit(prompt)
            .then(() => {
                this.reduce({ type: "responseEnded", sessionId });
            })
            .catch((err: unknown) => {
                this.reduce({
                    type: "rejected",
                    sessionId,
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
     *
     * @param sessionId - The session the timer was armed for.
     */
    private onNoSpeechTimeout(sessionId: number): void {
        if (this.snapshot.sessionId !== sessionId) {
            return;
        }
        const state = this.snapshot.state;
        if (state !== "listening" && state !== "transcribing") {
            return;
        }
        this.clearTimers();
        if (state === "transcribing" && this.finals.length > 0) {
            this.submitAccumulated(sessionId);
            return;
        }
        void this.stt.cancel();
        void this.stopVad();
        this.reduce({ type: "noSpeech", sessionId });
    }

    /**
     * Arms the silence guard (press with no speech; after end-of-speech, the
     * flush deadline). No-op while one is already pending.
     *
     * @param sessionId - The session to guard.
     */
    private armNoSpeechTimer(sessionId: number): void {
        if (this.noSpeechTimer !== null) {
            return;
        }
        this.noSpeechTimer = this.schedule(() => {
            this.noSpeechTimer = null;
            this.onNoSpeechTimeout(sessionId);
        }, NO_SPEECH_MS);
    }

    /** Cancels the pending silence guard, if any. */
    private cancelNoSpeechTimer(): void {
        if (this.noSpeechTimer !== null) {
            this.unschedule(this.noSpeechTimer);
            this.noSpeechTimer = null;
        }
    }

    /** Cancels the pending end-of-speech timer, if any. */
    private cancelEndOfSpeechTimer(): void {
        if (this.endOfSpeechTimer !== null) {
            this.unschedule(this.endOfSpeechTimer);
            this.endOfSpeechTimer = null;
        }
    }

    /** Cancels both pending timers (session decision made). */
    private clearTimers(): void {
        this.cancelNoSpeechTimer();
        this.cancelEndOfSpeechTimer();
    }

    /**
     * Stops the VAD; safe when no detector is configured or it already
     * settled.
     */
    private async stopVad(): Promise<void> {
        if (this.vad === null) {
            return;
        }
        try {
            await this.vad.stop();
        } catch {
            // A detector that failed to stop is already dead; nothing to do.
        }
    }

    /**
     * Applies one event and notifies subscribers when it changed anything.
     *
     * @param event - The event to apply.
     */
    private reduce(event: Parameters<typeof reduceVoice>[1]): void {
        const next = reduceVoice(this.snapshot, event);
        if (next !== this.snapshot) {
            this.snapshot = next;
            for (const listener of this.listeners) {
                listener();
            }
        }
    }
}

/**
 * Normalizes an unknown `start()` rejection into a {@link VoiceError}
 * (provider throws are already `VoiceError`-shaped; anything else becomes
 * an engine error).
 *
 * @param err - The thrown value.
 * @returns A voice error.
 */
function toVoiceError(err: unknown): VoiceError {
    if (typeof err === "object" && err !== null) {
        const candidate = err as { code?: unknown; message?: unknown };
        if (
            typeof candidate.code === "string" &&
            typeof candidate.message === "string"
        ) {
            return {
                code: candidate.code as VoiceError["code"],
                message: candidate.message,
            };
        }
    }
    return {
        code: "engine",
        message: err instanceof Error ? err.message : "voice input failed",
    };
}
