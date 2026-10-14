/**
 * Voice-session controller (issue #84, phases 2–4).
 *
 * Binds the pure session lifecycle (`./lifecycle`) to a real STT engine, an
 * optional VAD, an optional wake-word detector, and turn submission, so a
 * client UI renders from a `VoiceSnapshot` and never touches microphone
 * semantics directly. The controller is deliberately React-free and
 * engine-free (injected {@link SttProvider}, {@link VadProvider},
 * {@link WakeWordProvider}, submit function, timer seams) so the whole flow
 * is unit-testable in the node environment with fakes. Any J.A.R.V.I.S.
 * voice client consumes it; the chat view only supplies the web-specific
 * seams (a submit that runs a turn, response-frame forwarding).
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
 * Wake word (phase 4) — `enableWake()` arms the detector; a phrase match
 * with the session idle opens a wake session:
 *
 * ```text
 * enableWake ─ armed (snapshot.wakeArmed); wake engine's model pre-warmed
 *   "Hey JARVIS, …" ──► handleWake ──► begin({fromWake:true, lookback})
 *       onWakeCue ─► (beep)          ─► wakeStt.start({continuous})
 *                                     ─► wakeStt.feed(lookback)  (phrase→command replay)
 *                                     ─► normal VAD session; transcripts stripped
 *   session lands idle ──► maybeReArm ──► detector re-armed, stays ready
 * ```
 *
 * The detector is disarmed for every session (it would otherwise keep a
 * second microphone live and could fire on the phrase mid-turn) and re-armed
 * when the session lands `idle`. Wake sessions transcribe through the
 * separate `wakeStt` engine — the local one, since it receives the entire
 * wake-during context — and their transcripts have the wake phrase stripped
 * (`stripWakePhrase`) before display or submission.
 *
 * Barge-in (phase 6) — `startBargeWatch()` arms a VAD-only watch while
 * J.A.R.V.I.S. speaks; sustained speech triggers {@link VoiceControllerOptions.onBargeIn}
 * once and opens a recognition session seeded with the ringed look-back:
 *
 * ```text
 * speaking ──► startBargeWatch ──► vad.start (watch callbacks + audio tap)
 *     user talks ──► ring pre-trigger audio (BARGE_IN_LOOKBACK_MS)
 *     sustained speech (BARGE_IN_SPEECH_MS) ──► BargeWatch trigger
 *         ──► onBargeIn (client stops playback, cancels the turn)
 *         ──► begin({feed: lookback}) ──► listening; old turn stale by id
 * ```
 *
 * The watch is opportunistic: no VAD, a busy VAD (a session owns it), or a
 * dying mic track all leave it silently off — a turn that plays fine is
 * never disturbed by a failed interruption.
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
import { BargeWatch } from "./barge";
import type { BargeInDetection } from "./barge";
import type { VoiceCore } from "./core";
import { toVoiceError } from "./errors";
import { initialVoiceSnapshot, reduceVoice } from "./lifecycle";
import type { VoiceSnapshot } from "./lifecycle";
import { DEFAULT_WAKE_PHRASE, WakeManager, wakeReplay } from "./wake";
import { stripWakePhrase } from "./wakeText";
import type {
    SttProvider,
    SttStartOptions,
    VadCallbacks,
    VadProvider,
    VoiceError,
    WakeWordProvider,
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
     * The wake-word detector (issue #84, phase 4). When present (and
     * `wakeStt` is given), `enableWake()` arms it; a match opens a wake
     * session and the detector re-arms when that turn settles. `null`/
     * omitted disables wake-word support entirely.
     */
    readonly wake?: WakeWordProvider | null;
    /**
     * The STT engine used for wake-word sessions. **Required for wake-word
     * support**: `enableWake()` no-ops unless both `wake` and `wakeStt` are
     * present, so omitting it disables wake sessions even with a detector
     * configured (there is no primary-`stt` fallback). Should accept
     * caller-supplied audio (`feed()`) so the context spoken around the wake
     * phrase ("Hey JARVIS, turn on the lights") is transcribed — a
     * wake-word detector opens a session with its look-back buffer, not a
     * fresh page — and should be the private/local engine (a remote service
     * would send every wake-eavesdropped second to the cloud).
     */
    readonly wakeStt?: SttProvider | null;
    /**
     * Debug sink for the controller's otherwise-silent decision points:
     * the VAD failing to arm (the session then degrades to the engine's
     * own endpointing — the difference between automatic submit and
     * press-to-stop), the barge-in watch failing to arm, and a failed wake
     * pre-warm. The package deliberately has no logging dependency (the
     * caller owns diagnostics); pass a console- or logger-backed function
     * to make degradation visible. Default: a no-op.
     */
    readonly log?: (message: string, error?: unknown) => void;
    /**
     * The phrase removed from wake-session transcripts — `stripWakePhrase`
     * turns "Hey JARVIS, turn on the lights" into "turn on the lights".
     * Defaults to `"Hey JARVIS"`; it must match what the wake detector
     * listens for. Pass `""` to leave transcripts untouched.
     */
    readonly wakePhrase?: string;
    /**
     * A cue to play when the wake phrase matches (a blip or chime the user
     * can hear while the listening session opens). Runs before the turn
     * begins; a thrown/rejected cue does not stop the session from opening.
     */
    readonly onWakeCue?: () => void | Promise<void>;
    /**
     * The barge-in trigger (#84 P6): fires once, when the barge watch hears
     * sustained speech while J.A.R.V.I.S. speaks. The client stops local
     * playback and cancels the in-flight turn (the server ends it with
     * `done`); the controller then opens a recognition session seeded with
     * the look-back window. A thrown/rejected callback does not stop the
     * session from opening.
     */
    readonly onBargeIn?: (detection: BargeInDetection) => void | Promise<void>;
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
    private readonly wakeStt: SttProvider | null;
    private readonly wakePhrase: string;
    private readonly onWakeCue: (() => void | Promise<void>) | undefined;
    private readonly schedule: (callback: () => void, ms: number) => unknown;
    private readonly unschedule: (handle: unknown) => void;
    /** The injectable debug sink; a no-op unless the caller supplies one. */
    private readonly log: (message: string, error?: unknown) => void;
    /**
     * The engine driving the active session: the primary `stt` for press
     * turns, the wake engine (`wakeStt`) for wake-word turns. `null` while
     * idle; only consulted from session-live paths.
     */
    private sessionStt: SttProvider | null = null;
    /** Whether the active session was opened by the wake word. */
    private sessionFromWake = false;
    /** Set by `dispose()`; makes every wake/no-op path return immediately. */
    private disposed = false;
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
     * The shared context the extracted feature machines compose over
     * (issue #110); built in the constructor once the fields above exist.
     */
    private readonly core: VoiceCore;
    /**
     * The barge-in watch (#84 P6) — a VAD-only session that lives exactly as
     * long as J.A.R.V.I.S. is speaking; its VAD use and a recognition
     * session's are mutually exclusive.
     */
    private readonly bargeWatch: BargeWatch;
    /**
     * The wake-word manager (#84 P4) — owns the detector-armed state machine
     * and its interlocks; the controller forwards toggles and opens the
     * session on a match.
     */
    private readonly wakeManager: WakeManager;

    /**
     * @param options - The engine, the submit seam, the optional VAD, and
     * the optional timer seams (see {@link VoiceControllerOptions}).
     */
    constructor(options: VoiceControllerOptions) {
        this.stt = options.stt;
        this.submit = options.submit;
        this.vad = options.vad ?? null;
        this.wakeStt = options.wakeStt ?? null;
        this.wakePhrase = options.wakePhrase ?? DEFAULT_WAKE_PHRASE;
        this.onWakeCue = options.onWakeCue;
        this.schedule =
            options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
        this.unschedule =
            options.unschedule ??
            ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.log = options.log ?? (() => {});
        this.core = {
            snapshot: () => this.snapshot,
            reduce: (event) => this.reduce(event),
            vad: this.vad,
            schedule: (callback, ms) => this.schedule(callback, ms),
            unschedule: (handle) => this.unschedule(handle),
            log: (message, error) => this.log(message, error),
            isDisposed: () => this.disposed,
            stopVad: () => this.stopVad(),
        };
        this.bargeWatch = new BargeWatch(this.core, {
            ...(options.onBargeIn !== undefined
                ? { onBargeIn: options.onBargeIn }
                : {}),
            onDetected: (feed) => void this.begin(feed ? { feed } : {}),
        });
        this.wakeManager = new WakeManager(this.core, {
            wake: options.wake ?? null,
            wakeStt: options.wakeStt ?? null,
            onMatch: async (detection) => {
                try {
                    await this.onWakeCue?.();
                } catch {
                    // A cue that will not play must not stop the session from
                    // opening; the blip is cosmetic.
                }
                await this.begin({
                    fromWake: true,
                    lookback: detection.lookback,
                    ...(detection.lookbackSampleRate !== undefined
                        ? { lookbackSampleRate: detection.lookbackSampleRate }
                        : {}),
                });
            },
        });
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
     * (transcribing/submitting/turn) are deliberately inert — interrupting
     * a turn is the barge-in watch's and the client's stop control's job.
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
     * Arms the wake-word detector: the controller starts listening for the
     * wake phrase and will open sessions on matches. The detector (and the
     * wake engine's model warm-up) stays armed across sessions — it is only
     * disarmed while a session owns the mic, then re-armed.
     *
     * Safe to call when already armed (no-op). Requires both a `wake`
     * provider and a `wakeStt` engine from construction; otherwise this is
     * a silent no-op and the snapshot never reports `wakeArmed`.
     *
     * @returns Resolves once the detector is armed (or is already so, or
     * wake support is unavailable).
     */
    async enableWake(): Promise<void> {
        await this.wakeManager.enable();
    }

    /**
     * Disarms the wake-word detector and leaves it off until
     * {@link enableWake} is called again. Safe when already disarmed;
     * cancels a wake-session engine if one is mid-session (the primary
     * engine's session is left alone).
     *
     * @returns Resolves once the detector is disarmed.
     */
    async disableWake(): Promise<void> {
        await this.wakeManager.disable();
    }

    /**
     * Arms the barge-in watch (#84 P6): a VAD-only session that listens
     * while J.A.R.V.I.S. speaks and triggers {@link VoiceControllerOptions.onBargeIn}
     * once it hears sustained speech (`BARGE_IN_SPEECH_MS`). The watch
     * owns the VAD while armed, so a recognition session cannot start under
     * it — arm it only for the span of playback, and disarm after (the chat
     * view keys both on its `speaking` state).
     *
     * Silent no-op when there is no VAD, the controller is disposed, or the
     * watch is already armed; when the VAD is busy (a recognition session is
     * live) the arming fails quietly — barge-in is opportunistic.
     *
     * @returns Resolves once the watch is armed (or silently skipped).
     */
    async startBargeWatch(): Promise<void> {
        await this.bargeWatch.start();
    }

    /**
     * Disarms the barge-in watch: cancels a pending trigger, releases the
     * VAD, and drops the look-back ring. Idempotent; never touches a
     * recognition session's VAD (the watch only stops what it armed).
     *
     * @returns Resolves once the watch is disarmed.
     */
    async stopBargeWatch(): Promise<void> {
        await this.bargeWatch.stop();
    }

    /**
     * Tears down: cancels any live recognition, releases both engines'
     * session-spanning resources (a WASM model worker, when an engine holds
     * one), stops the VAD and the wake detector, drops any pending timers,
     * and drops listeners.
     *
     * @returns Resolves when the engines and detectors have stopped.
     */
    async dispose(): Promise<void> {
        this.disposed = true;
        // Supersede a barge start still awaiting `vad.start()` so its late
        // completion releases the VAD instead of arming a dead controller
        // (#104, race 3).
        this.bargeWatch.dispose();
        this.clearTimers();
        await this.stt.cancel();
        await this.stt.dispose?.();
        const wakeStt = this.wakeStt;
        if (wakeStt !== null && wakeStt !== this.stt) {
            await wakeStt.cancel();
            await wakeStt.dispose?.();
        }
        await this.stopVad();
        await this.wakeManager.dispose();
        this.listeners.clear();
    }

    /**
     * Starts a session: opens it in the reducer, arms the VAD (its success
     * decides whether this session runs continuous capture under the
     * controller's endpointing), then arms the engine with callbacks tagged
     * to the (captured) session id, so late deliveries after a
     * re-activation are stale by construction. An armed wake detector is
     * disarmed first, so the session owns the microphone and the wake phrase
     * can't fire mid-listen — and an armed barge watch is stopped first, so
     * the VAD is free.
     *
     * @param options - `fromWake` opens the session on the wake engine with
     * wake-phrase stripping; `lookback`/`lookbackSampleRate` (mono PCM
     * captured by the detector, defaulting to the 16 kHz convention) are
     * replayed into it the moment capture is live, so the command spoken in
     * the same breath as the wake phrase is transcribed. `feed` plays the
     * same role for a barge-in session (#84 P6): the watch's pre-trigger
     * audio, at the watch's capture rate, on the primary engine.
     */
    private async begin({
        fromWake,
        lookback,
        lookbackSampleRate,
        feed,
    }: {
        fromWake?: boolean;
        lookback?: Float32Array;
        lookbackSampleRate?: number;
        feed?: { pcm: Float32Array; sampleRate: number };
    } = {}): Promise<void> {
        if (this.bargeWatch.active) {
            await this.bargeWatch.stop();
        } else {
            const stopping = this.bargeWatch.stopping();
            if (stopping !== null) {
                // The watch's VAD release is still settling (a barge just
                // fired): wait it out so the session's track is never torn
                // down by the watch's late cleanup.
                await stopping;
            }
        }
        // The reducer ignores `activate` while a session is already
        // mid-flight (listening/transcribing/submitting). If it did, this
        // `begin()` is a stale second open — a press in the wake cue's
        // window, or a barge watch firing into a live session — and opening
        // another session under the same id would clobber the live one
        // (#104, race 2). Bail without touching any engine.
        const beforeActivation = this.snapshot.sessionId;
        this.reduce({ type: "activate" });
        if (this.snapshot.sessionId === beforeActivation) {
            return;
        }
        const sessionId = this.snapshot.sessionId;
        this.finals = [];
        this.heardSpeech = false;
        this.deferredSpeechEnd = false;
        this.sessionFromWake = fromWake === true;
        this.sessionStt = this.sessionFromWake
            ? (this.wakeStt ?? this.stt)
            : this.stt;
        // The replayed pre-session audio, in recognition order. Explicit
        // `feed` (the barge-in handoff) wins; a wake session drains the
        // detector's look-back ring — BEFORE `stop()` discards it — so the
        // replay covers the match-time ring **plus** whatever the user said
        // while this session's own microphone was still opening, which a
        // match-time snapshot loses ("the lookback misses my first word").
        // A press never replays (a stale ring would inject phantom audio).
        let replayPcm: Float32Array | null = null;
        let replayRate = lookbackSampleRate ?? 16000;
        if (feed !== undefined) {
            replayPcm = feed.pcm;
            replayRate = feed.sampleRate;
        } else if (fromWake === true) {
            replayPcm = wakeReplay(lookback, this.wakeManager.drainPostMatch());
        }
        this.wakeManager.disarmForSession();
        let vadArmed = false;
        if (this.vad !== null) {
            try {
                await this.vad.start(this.vadCallbacks(sessionId));
                vadArmed = true;
            } catch (err) {
                // Detector unavailable (e.g. no microphone track): fall back
                // to the engine's own endpointing for this session. This is
                // the difference between automatic submit and
                // press-to-stop, so it must be observable.
                this.log(
                    `session ${sessionId}: VAD unavailable; using the engine's own endpointing`,
                    err,
                );
            }
        }
        this.vadSession = vadArmed;
        const stt = this.sessionStt;
        const startOptions: SttStartOptions = {
            ...(vadArmed ? { continuous: true } : {}),
            ...(replayPcm !== null
                ? { feed: { pcm: replayPcm, sampleRate: replayRate } }
                : {}),
        };
        try {
            await stt.start(
                {
                    onPartial: (text) => this.onPartial(sessionId, text),
                    onResult: (text) => this.onTranscript(sessionId, text),
                    onError: (error) => this.onEngineError(sessionId, error),
                },
                startOptions.continuous === true ||
                    startOptions.feed !== undefined
                    ? startOptions
                    : undefined,
            );
            this.log(
                `session ${sessionId}: listening (${vadArmed ? "vad-owned endpointing" : "engine-native endpointing"}${
                    startOptions.feed !== undefined
                        ? ", replayed look-back"
                        : ""
                })`,
            );
            // Arm endpointing only now that the engine is actually
            // capturing: a cold engine (Vosk loading its ~40 MB model) must
            // not have its no-speech deadline tick during the load, or the
            // first-ever press dies mid-download (#104, race 1). If speech
            // already happened while the engine was starting, honor it
            // instead of arming a "silence" guard.
            if (
                vadArmed &&
                this.snapshot.sessionId === sessionId &&
                this.snapshot.state === "listening"
            ) {
                if (this.deferredSpeechEnd) {
                    this.armEndOfSpeechTimer(sessionId);
                } else if (!this.heardSpeech) {
                    this.armNoSpeechTimer(sessionId);
                }
            }
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
        this.log(`session ${this.snapshot.sessionId}: manual stop requested`);
        if (this.vadSession && this.snapshot.state === "listening") {
            this.onEndOfSpeechTimeout(this.snapshot.sessionId);
            return;
        }
        this.clearTimers();
        void this.stopVad();
        try {
            await this.activeStt().stop();
        } catch {
            // Engine failures surface through onError; nothing to do here.
        }
    }

    /**
     * The engine driving the active session: `wakeStt` for wake-word turns,
     * the primary `stt` for presses. Only meaningful while a session is
     * live (idle paths never consult it — `dispose` stops both engines
     * explicitly).
     *
     * @returns The active session's engine.
     */
    private activeStt(): SttProvider {
        return this.sessionStt ?? this.stt;
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
        this.log(`session ${sessionId}: speech start`);
        this.heardSpeech = true;
        this.deferredSpeechEnd = false;
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
        this.heardSpeech = true;
        if (this.activeStt().state === "starting") {
            // The engine is still opening (cold model load): an end-of-speech
            // armed now would expire before the engine can capture the tail
            // of the utterance. Record the intent and let `begin`'s
            // post-start block arm the timer once capture is live (#104,
            // race 1).
            this.deferredSpeechEnd = true;
            return;
        }
        this.armEndOfSpeechTimer(sessionId);
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
        void this.activeStt().cancel();
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
    private async onEndOfSpeechTimeout(sessionId: number): Promise<void> {
        if (
            this.snapshot.sessionId !== sessionId ||
            this.snapshot.state !== "listening"
        ) {
            return;
        }
        if (this.activeStt().state === "starting") {
            // A timer that predates the engine going live (cold start): defer
            // the flush to `begin`'s post-start block, which arms the
            // end-of-speech timer once capture is actually running (#104,
            // race 1).
            this.deferredSpeechEnd = true;
            return;
        }
        this.reduce({ type: "endOfSpeech", sessionId });
        this.log(`session ${sessionId}: pause window elapsed; flushing engine`);
        void this.stopVad();
        // The flush deadline stays armed as the safety net for a wedged
        // engine — but the normal path does not wait for it.
        this.armNoSpeechTimer(sessionId);
        try {
            // Awaiting the flush means the transcript decision happens the
            // moment the engine settles (vosk: ≤ flushWaitMs; Web Speech:
            // its own `onend`) — a final result submits through
            // `onTranscript` while we wait. Previously this was
            // fire-and-forget: an engine flush that produced no final
            // (continuous mode suppresses the no-speech error) parked the
            // user on the full deadline before the partials were submitted,
            // which read as "it doesn't submit until I say something else".
            await this.activeStt().stop();
        } catch {
            // Engine failures surface through onError.
        }
        if (
            this.snapshot.sessionId !== sessionId ||
            // A fresh read through the getter — the top guard's narrowing
            // (state === "listening") is stale across the flush await.
            this.getSnapshot().state !== "transcribing"
        ) {
            // The flush's own final already submitted (or the session
            // failed) — nothing left to decide.
            return;
        }
        if (this.finals.length > 0) {
            this.submitAccumulated(sessionId);
            return;
        }
        // The flush settled with nothing recognized at all: end the
        // session quietly instead of parking it until the deadline.
        this.clearTimers();
        void this.activeStt().cancel();
        void this.stopVad();
        this.reduce({ type: "noSpeech", sessionId });
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
        if (this.snapshot.sessionId === sessionId) {
            this.heardSpeech = true;
            this.deferredSpeechEnd = false;
        }
        this.cancelNoSpeechTimer();
        const cleaned = this.sessionFromWake
            ? stripWakePhrase(text, this.wakePhrase)
            : text;
        const display = [this.displayText(), cleaned].filter(Boolean).join(" ");
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
        if (this.snapshot.sessionId === sessionId) {
            this.heardSpeech = true;
            this.deferredSpeechEnd = false;
        }
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
        // Engine-native sessions: the final is the whole transcript. In a
        // wake session it includes the wake phrase, which must be stripped
        // before it reaches display or submission.
        const cleaned = this.sessionFromWake
            ? stripWakePhrase(text, this.wakePhrase)
            : text;
        this.reduce({ type: "transcript", sessionId, text: cleaned });
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
        void this.activeStt().cancel();
        this.reduce({ type: "noSpeech", sessionId });
    }

    /**
     * The accumulated final segments as one transcript text. In a wake
     * session the segments begin with the wake phrase and are stripped for
     * display and submission alike.
     *
     * @returns The joined text, trimmed; empty when nothing was recognized.
     */
    private displayText(): string {
        const text = this.finals.join(" ").trim();
        return this.sessionFromWake
            ? stripWakePhrase(text, this.wakePhrase)
            : text;
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
            this.log(
                `session ${sessionId}: flush deadline with partial transcript; submitting what was heard`,
            );
            this.submitAccumulated(sessionId);
            return;
        }
        this.log(`session ${sessionId}: no speech detected; going quiet`);
        void this.activeStt().cancel();
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

    /**
     * Arms the "pause ⇒ send" timer. No-op while one is already pending.
     *
     * @param sessionId - The session being endpointed.
     */
    private armEndOfSpeechTimer(sessionId: number): void {
        if (this.endOfSpeechTimer !== null) {
            return;
        }
        this.log(
            `session ${sessionId}: speech end; pausing ${END_OF_SPEECH_MS}ms before sending`,
        );
        this.endOfSpeechTimer = this.schedule(() => {
            this.endOfSpeechTimer = null;
            this.onEndOfSpeechTimeout(sessionId);
        }, END_OF_SPEECH_MS);
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
            // A session landing on `idle` (after a turn, a quiet no-op, a
            // failure) is a moment to bring wake detection back online.
            this.wakeManager.maybeReArm();
        }
    }
}
