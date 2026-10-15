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
 * with the session idle opens a wake session whose command arrives on the
 * detector's own microphone (#121):
 *
 * ```text
 * enableWake ─ armed (snapshot.wakeArmed); wake engine's model pre-warmed
 *   "Hey JARVIS, …" ──► WakeManager.onMatch ──► begin({fromWake:true})
 *       onWakeCue ─► (beep)   ─► wakeStt.start({source:"external"})
 *                             ─► wakeStt.feed(<live detector frames>)
 *                             ─► engine endpoints on silence; transcripts stripped
 *   session lands idle ──► WakeManager.maybeReArm ──► detector restarted
 * ```
 *
 * A wake session is the one session that does **not** take over the
 * microphone: the detector keeps capturing after the match, and every frame
 * from then on is the command — never the phrase — fed straight into the wake
 * engine running `{ source: "external" }` (no microphone of its own). That is
 * what makes the session's audio phrase-free and contiguous by construction,
 * and why a one-breath "Hey JARVIS what time is it" is captured whole: there
 * is no second microphone opening late and nothing to splice. Press and
 * barge sessions still disarm the detector for their duration.
 *
 * Wake sessions transcribe through the separate `wakeStt` engine — the local
 * one, since the command is the user's live speech — and their transcripts
 * have the wake phrase stripped (`stripWakePhrase`) as a safety net before
 * display or submission.
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
import { MAX_PENDING_COMMAND_SAMPLES, VoiceSession } from "./session";
import { DEFAULT_WAKE_PHRASE, WakeManager } from "./wake";
import type { SttProvider, VadProvider, WakeWordProvider } from "./types";

/**
 * The wake detector's capture rate (the openWakeWord worklet convention). A
 * wake session's engine runs microphone-free at this rate and consumes the
 * detector's frames through `feed()` (issue #121).
 */
const DETECTOR_SAMPLE_RATE = 16000;

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
     * configured (there is no primary-`stt` fallback). Must accept
     * caller-supplied audio (`feed()`) — the detector streams the command
     * after the phrase straight into it, so the engine's own microphone is
     * never opened — and should be the private/local engine (a remote service
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
     * The raw-vs-submitted transcript trace (issue #121, lesson 6). Fires at
     * submit time for sessions that transform the engine's transcript — today
     * only wake sessions, whose leading phrase is stripped — with the
     * engine's raw text and the exact prompt submitted. Kept separate from
     * {@link VoiceControllerOptions.log} because it carries real user speech:
     * a client can enable the general debug sink without ever putting a
     * transcript in its normal log. Default: a no-op.
     */
    readonly traceTranscript?: (raw: string, submitted: string) => void;
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
     * The raw-vs-submitted transcript trace (issue #121): a separate channel
     * from {@link log} because it carries user speech. Notified at submit
     * time for transcripts the session transformed (wake-phrase stripping).
     */
    private readonly traceTranscript: (raw: string, submitted: string) => void;
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
     * Detector frames captured from a match until its wake session exists
     * (#121), in order. The wake cue plays (and `begin()` awaits) between the
     * two, so without this the command's opening would be dropped; bounded by
     * {@link MAX_PENDING_COMMAND_SAMPLES}.
     */
    private pendingCommandAudio: Array<{
        pcm: Float32Array;
        sampleRate: number;
    }> = [];
    /** Sample count in {@link pendingCommandAudio}, for the bound. */
    private pendingCommandSamples = 0;
    /**
     * Whether a wake session is between its match and its creation — the
     * window in which detector frames must be held rather than dropped.
     */
    private wakeCommandOpen = false;

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
        this.traceTranscript = options.traceTranscript ?? (() => {});
        this.core = {
            snapshot: () => this.snapshot,
            reduce: (event) => this.reduce(event),
            vad: this.vad,
            schedule: (callback, ms) => this.schedule(callback, ms),
            unschedule: (handle) => this.unschedule(handle),
            log: (message, error) => this.log(message, error),
            traceTranscript: (raw, submitted) =>
                this.traceTranscript(raw, submitted),
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
            onMatch: async () => {
                // From here until the session exists, detector frames are the
                // command's opening and must be held (#121).
                this.wakeCommandOpen = true;
                try {
                    await this.onWakeCue?.();
                } catch {
                    // A cue that will not play must not stop the session from
                    // opening; the blip is cosmetic.
                }
                await this.begin({ fromWake: true });
            },
            onCommandAudio: (pcm, sampleRate) =>
                this.onCommandAudio(pcm, sampleRate),
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
     * {@link enableWake} is called again. Safe when already disarmed. It does
     * **not** cancel a session that is already running: a wake session keeps
     * the engine it owns and settles through its own bounds (its detector
     * simply stops delivering frames), and a press/barge session on the
     * primary engine is left alone. The detector is not restarted when such a
     * session ends — `maybeReArm` no-ops while disabled.
     *
     * @returns Resolves once the detector is disarmed.
     */
    async disableWake(): Promise<void> {
        await this.wakeManager.disable();
    }

    /**
     * Arms the barge-in watch (#84 P6): a VAD-only session that listens
     * while J.A.R.V.I.S.'s response streams and plays, and triggers
     * {@link VoiceControllerOptions.onBargeIn}
     * once it hears sustained speech (`BARGE_IN_SPEECH_MS`). The watch
     * owns the VAD while armed, so a recognition session cannot start under
     * it — arm it for the whole response and disarm when the turn ends (the
     * chat view keys it on the response being in flight, `responding` onward,
     * so a tool turn is covered before its first audio frame exists — #114).
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
        this.clearPendingCommandAudio();
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
     * Starts a session: opens it in the reducer, arms the VAD for press/barge
     * sessions (its success decides whether the session runs continuous
     * capture under the controller's endpointing), then arms the engine with
     * callbacks tagged to the (captured) session id, so late deliveries after
     * a re-activation are stale by construction. An armed wake detector is
     * disarmed first for press/barge sessions — so the session owns the
     * microphone and the wake phrase can't fire mid-listen — and an armed
     * barge watch is stopped first, so the VAD is free. A **wake** session is
     * the exception: the detector keeps capturing and its frames become the
     * session's audio (#121).
     *
     * @param options - `fromWake` opens the session on the wake engine, in
     * external-audio mode over the detector's live command frames, with
     * wake-phrase stripping as a safety net (#121). `feed` plays the same
     * role for a barge-in session (#84 P6): the watch's pre-trigger audio, at
     * the watch's capture rate, on the primary engine.
     */
    private async begin({
        fromWake,
        feed,
    }: {
        fromWake?: boolean;
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
            if (fromWake === true) {
                // The wake session never opened; stop holding the detector's
                // frames for it (#121).
                this.clearPendingCommandAudio();
            }
            return;
        }
        const sessionId = this.snapshot.sessionId;
        const fromWakeSession = fromWake === true;
        const engine = fromWakeSession ? (this.wakeStt ?? this.stt) : this.stt;
        // The seed for the session's engine, in recognition order: the
        // barge-in watch's ring (#84 P6) rides `start()` so it can never
        // interleave with live audio. A wake session takes its audio live
        // from the detector instead — held frames first, then every frame
        // that follows (#121) — so it never seeds here.
        let replayPcm: Float32Array | null = null;
        let replayRate = DETECTOR_SAMPLE_RATE;
        if (feed !== undefined) {
            replayPcm = feed.pcm;
            replayRate = feed.sampleRate;
        }
        if (fromWakeSession) {
            // Keep the detector capturing: its frames are the command (#121).
            this.wakeManager.beginCommand();
        } else {
            this.wakeManager.disarmForSession();
        }
        const session = new VoiceSession(this.core, {
            sessionId,
            engine,
            fromWake: fromWakeSession,
            wakePhrase: this.wakePhrase,
            submit: this.submit,
            ...(fromWakeSession
                ? { external: { sampleRate: DETECTOR_SAMPLE_RATE } }
                : {}),
        });
        let vadArmed = false;
        if (!fromWakeSession && this.vad !== null) {
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
        // the engine opens can route its flush through this session — and so
        // the detector's frames landing from now on go straight to it.
        this.session = session;
        // Hand over the frames the detector produced while this session was
        // being created (the wake cue and `begin()`'s own awaits): the
        // command's opening (#121). The session holds whatever arrives before
        // its engine is up.
        const held = this.pendingCommandAudio;
        this.pendingCommandAudio = [];
        this.pendingCommandSamples = 0;
        this.wakeCommandOpen = false;
        for (const chunk of held) {
            session.pushCommandAudio(chunk.pcm, chunk.sampleRate);
        }
        await session.start(
            replayPcm !== null
                ? { pcm: replayPcm, sampleRate: replayRate }
                : null,
        );
    }

    /**
     * The detector's live post-match audio (#121). While a wake session is
     * listening, frames go straight to it (the session holds any that arrive
     * before its engine is up). In the window between the match and the
     * session's creation — the wake cue, and `begin()`'s own awaits — there is
     * no session yet, so the frames are held (bounded) here for it to start
     * with; with no wake session opening, they are dropped, so a finished
     * turn's tail can never become the next command's opening.
     *
     * @param pcm - Mono PCM samples normalized to `[-1, 1]`.
     * @param sampleRate - The rate the detector captured `pcm` at.
     */
    private onCommandAudio(pcm: Float32Array, sampleRate: number): void {
        const session = this.session;
        if (session !== null && session.acceptsCommandAudio()) {
            session.pushCommandAudio(pcm, sampleRate);
            return;
        }
        if (!this.wakeCommandOpen) {
            return;
        }
        this.pendingCommandAudio.push({ pcm, sampleRate });
        this.pendingCommandSamples += pcm.length;
        while (
            this.pendingCommandSamples > MAX_PENDING_COMMAND_SAMPLES &&
            this.pendingCommandAudio.length > 0
        ) {
            const dropped = this.pendingCommandAudio.shift();
            if (dropped !== undefined) {
                this.pendingCommandSamples -= dropped.pcm.length;
            }
        }
    }

    /** Drops any detector frames held for a wake session that never opened. */
    private clearPendingCommandAudio(): void {
        this.pendingCommandAudio = [];
        this.pendingCommandSamples = 0;
        this.wakeCommandOpen = false;
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
