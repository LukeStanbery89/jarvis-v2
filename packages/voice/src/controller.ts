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
 * Endpointing — who decides "the user stopped talking" — lives in
 * {@link VoiceSession} (`./session`): `begin()` creates one per session and
 * delegates every engine/VAD event to it. With a `vad` armed the session owns
 * endpointing deterministically (issue #84, phase 3) — the engine runs
 * `{ continuous: true }`, the session arms an end-of-speech timer on the
 * VAD's speech-end event, flushes the engine (`stt.stop()`) when it expires,
 * and submits the accumulated transcript; a press during the same window
 * (`session.finish()`) routes through that identical pipeline. Without a
 * `vad` (unsupported runtime, e.g. Firefox) behavior is the engine's own: it
 * finalizes on its silence detection, a second press stops-and-flushes, and
 * no timer is armed. Silence is quiet: a press that never hears speech ends
 * with `stt.cancel()` (no callbacks fire) and the reducer's `noSpeech` event,
 * so the UI returns to `idle` without an error banner.
 *
 * The feature state machines live beside this file (issue #110), each over
 * the shared {@link VoiceCore} context: {@link VoiceSession} (`./session`)
 * owns the endpointing/transcript machine, {@link WakeManager} (`./wake`)
 * owns the detector-armed machine, and `BargeWatch` (`./barge`) owns the
 * barge-in watch. The controller stays their composition root: it owns the
 * public snapshot, the mic-ownership seams, and the session's lifetime.
 *
 * Wake word (phase 4) — `enableWake()` arms the detector; a phrase match
 * with the session idle opens a wake session:
 *
 * ```text
 * enableWake ─ armed (snapshot.wakeArmed); wake engine's model pre-warmed
 *   "Hey JARVIS, …" ──► WakeManager.onMatch ──► begin({fromWake:true, lookback})
 *       onWakeCue ─► (beep)          ─► wakeStt.start({continuous})
 *                                     ─► wakeStt.feed(lookback)  (phrase→command replay)
 *                                     ─► normal VAD session; transcripts stripped
 *   session lands idle ──► WakeManager.maybeReArm ──► detector re-armed
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
 * speaking ──► bargeWatch.start ──► vad.start (watch callbacks + audio tap)
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
import { initialVoiceSnapshot, reduceVoice } from "./lifecycle";
import type { VoiceSnapshot } from "./lifecycle";
import { VoiceSession } from "./session";
import { DEFAULT_WAKE_PHRASE, WakeManager, wakeReplay } from "./wake";
import type { SttProvider, VadProvider, WakeWordProvider } from "./types";

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
     * The live session (endpointing, transcript accumulation, submission) —
     * created by `begin()`, replaced when a newer session activates, and
     * cleared by `dispose()`. `null` while idle.
     */
    private session: VoiceSession | null = null;
    /** Set by `dispose()`; makes every wake/no-op path return immediately. */
    private disposed = false;
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
            void this.session?.finish();
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
        this.session?.dispose();
        this.session = null;
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
        const fromWakeSession = fromWake === true;
        const engine = fromWakeSession ? (this.wakeStt ?? this.stt) : this.stt;
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
        } else if (fromWakeSession) {
            replayPcm = wakeReplay(lookback, this.wakeManager.drainPostMatch());
        }
        this.wakeManager.disarmForSession();
        const session = new VoiceSession(this.core, {
            sessionId,
            engine,
            fromWake: fromWakeSession,
            wakePhrase: this.wakePhrase,
            submit: this.submit,
        });
        let vadArmed = false;
        if (this.vad !== null) {
            try {
                await this.vad.start(session.vadCallbacks());
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
        session.setVadOwned(vadArmed);
        // Assigned before the awaited start so a press arriving the instant
        // the engine opens can route its flush through this session.
        this.session = session;
        await session.start(
            replayPcm !== null
                ? { pcm: replayPcm, sampleRate: replayRate }
                : null,
        );
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
