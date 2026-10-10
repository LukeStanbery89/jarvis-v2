/**
 * Provider-facing types for client-side voice input.
 *
 * Three interfaces make the engines swappable: {@link SttProvider} answers
 * "what did they say", {@link WakeWordProvider} answers "are they addressing
 * J.A.R.V.I.S.", and {@link VadProvider} answers "is someone speaking".
 * Callers are client packages — `packages/web` today, a future satellite
 * later — which feed the results into the session lifecycle state machine in
 * `./lifecycle` (tracked by issue #84, phase 1).
 *
 * Nothing here knows about conversations, sockets, or protocol frames: a
 * provider speaks microphone semantics only, so replacing an engine (Web
 * Speech first, a local WASM model next) never touches client protocol code.
 */

/**
 * Machine-readable failure classes for microphone, wake-word, and STT
 * components. These are always surfaced as client-local UI states — they are
 * never sent to the server and never use the protocol's reserved `error`
 * frames (LLM-unreachable / turn-timeout / bad-prompt).
 */
export type VoiceErrorCode =
    /** The user (or the browser) denied microphone access. */
    | "permission-denied"
    /** The runtime has no speech engine (e.g. Firefox with no WASM fallback). */
    | "unsupported"
    /** Recognition finished without producing any speech. */
    | "no-speech"
    /** The engine failed to initialize or crashed mid-recognition. */
    | "engine"
    /** The operation was cancelled; not a failure the user should see. */
    | "aborted"
    /** The server refused the submitted prompt (busy, turn timeout, …). */
    | "rejected"
    /** Anything unclassifiable above. */
    | "internal";

/**
 * A provider-level failure, carrying both a {@link VoiceErrorCode} for
 * branching and a human-readable message for logs/UI.
 */
export interface VoiceError {
    readonly code: VoiceErrorCode;
    readonly message: string;
}

/**
 * Lifecycle of a single {@link SttProvider} between `start()` and
 * `stop()`/`cancel()`. Exposed so UIs can show engine state independently
 * of the session lifecycle state machine.
 */
export type SttState = "idle" | "starting" | "running" | "stopping";

/**
 * Per-session callbacks handed to {@link SttProvider.start}.
 *
 * Callbacks are passed per `start()` rather than at construction so one
 * provider instance can serve sequential sessions without stale closures,
 * and so a session's callbacks can be dropped wholesale on cancellation.
 *
 * Results arrive as they are recognized: `onPartial` with interim text (UI
 * feedback only — partials must never be submitted as user messages) and
 * `onResult` with the final transcript. `onResult` may fire before or after
 * `stop()` resolves depending on the engine; it will not fire at all after
 * `cancel()` resolves.
 */
export interface SttCallbacks {
    /** Interim, possibly-incomplete recognition text for live UI display. */
    readonly onPartial?: (text: string) => void;
    /** The final transcript for this session; the only value to submit. */
    readonly onResult?: (text: string) => void;
    /** Recognition failed; the session ends without a transcript. */
    readonly onError?: (error: VoiceError) => void;
}

/**
 * Per-start options a client may hand the engine alongside the callbacks.
 *
 * These exist so the *caller* decides capture behavior per session — most
 * importantly endpointing: when the caller owns it (VAD-driven, issue #84
 * phase 3), the engine must be told not to finalize on its own pause
 * detection, or the two endpointing authorities race.
 */
export interface SttStartOptions {
    /**
     * Continuous capture: the engine must not finalize on its own silence
     * detection — the caller owns endpointing and ends the session via
     * `stop()` (flush) or `cancel()` (discard). Defaults to the engine's
     * own behavior (finalizes on its pause detection) when omitted.
     */
    readonly continuous?: boolean;
    /**
     * Caller audio to recognize before live capture begins: the wake
     * detector's look-back ring (the phrase plus the command's opening) or
     * the barge-in watch's interrupted opening. Riding `start()` — instead
     * of a post-start `feed()` call — guarantees the order: the engine's
     * own microphone is not delivering until `start()` resolves, so the
     * replay can never interleave out of order with already-live chunks
     * (out-of-order audio garbles a streaming decoder). Engines that
     * cannot take caller audio ignore it and start at the live mic.
     */
    readonly feed?: {
        readonly pcm: Float32Array;
        readonly sampleRate: number;
    };
}

/**
 * A speech-to-text engine.
 *
 * Contract:
 * - `start()` begins recognition and rejects if the provider is not idle.
 * - `stop()` ends capture and flushes; the final transcript (if any)
 *   arrives through the active callbacks' `onResult`.
 * - `cancel()` aborts and discards: it resolves when the engine has fully
 *   stopped, after which no callback for that session will fire.
 * - `state` reflects the current lifecycle for UI display.
 * - With `start(callbacks, { continuous: true })` the engine must not
 *   finalize on its own pause detection: final-segment results may still
 *   arrive while capture continues, and only the caller's `stop()`/`cancel()`
 *   ends the session.
 * - Engines holding resources beyond a session (a WASM model worker, cached
 *   weights) may implement the optional `dispose()`: called once by a client
 *   when the engine will never be used again, it releases everything. The
 *   Web Speech engine has nothing beyond a session, so it omits it.
 * - An optional `prepare()` pre-loads the engine-wide resources (model
 *   weights, worker) ahead of the next `start()`, so the first session after
 *   a wake word opens without the download/load stall. It never rejects the
 *   caller — a failure surfaces at the next `start()` instead.
 * - An optional `feed(pcm, sampleRate)` hands the engine raw mono PCM audio
 *   *without* opening the microphone (wake-word providers do exactly that).
 *   Implementations that capture from their own held mic reject or ignore
 *   it; those that take caller-supplied audio (the WASM engine backing wake
 *   sessions) accept it while `running`. It is the seam that replays the
 *   look-back buffer captured by a wake-word detector ("Hey JARVIS, turn on
 *   the lights") into a session that opened without hearing the phrase
 *   itself (issue #84, phase 4).
 *
 * Implementations own microphone permission prompting and must not assume a
 * particular UI, transport, or conversation model.
 */
export interface SttProvider {
    /** Stable engine identifier, e.g. `"web-speech"`, `"vosk-wasm"`. */
    readonly id: string;
    /** Current provider lifecycle. */
    readonly state: SttState;
    /**
     * Starts a recognition session.
     *
     * @param callbacks - Results for this session only.
     * @param options - Per-session capture options (see
     * {@link SttStartOptions}); engines ignore what they cannot honor.
     * @returns Resolves once the engine is capturing.
     */
    start(callbacks: SttCallbacks, options?: SttStartOptions): Promise<void>;
    /** Ends capture, delivering the final transcript through `onResult` if one exists. */
    stop(): Promise<void>;
    /** Aborts the session; no callback fires after the returned promise resolves. */
    cancel(): Promise<void>;
    /**
     * Releases engine-wide resources (a loaded WASM model, its worker), not
     * just the active session. Optional: engines that hold nothing beyond a
     * session omit it. After `dispose()` the provider accepts new sessions
     * (reloading what it needs) or may reject — implementations document
     * which.
     */
    dispose?(): Promise<void>;
    /**
     * Pre-loads engine-wide resources (model weights, worker) so the next
     * `start()` opens without a load stall — the controller calls this right
     * after a wake word arms, so the first wake-session is instant. Optional:
     * engines with nothing to pre-load, or whose load is cheap (Web Speech),
     * omit it.
     *
     * @returns Resolves when the engine is warmed. Implementations must not
     * reject the caller on failure — a failed warm-up surfaces as a regular
     * `start()` rejection instead.
     */
    prepare?(): Promise<void>;
    /**
     * Feeds caller-supplied mono PCM audio into an active session, instead of
     * opening the microphone. Optional, and only meaningful while `running`:
     * the WASM engine backing wake-word sessions implements it so a wake
     * session can begin by replaying the detector's look-back buffer (the
     * command spoken in the same breath as the wake phrase), then continue
     * on live mic frames. Engines that owe their own mic (Web Speech) omit it.
     *
     * @param pcm - Interleaved mono PCM samples, normalized to `[-1, 1]`.
     * @param sampleRate - The sample rate the PCM was captured at.
     * Implementations resample internally if needed (vosk does).
     */
    feed?(pcm: Float32Array, sampleRate: number): void;
}

/**
 * What a wake-word detector saw. The look-back buffer that retains audio
 * spoken in the same breath as the wake phrase ("Hey JARVIS, turn on the
 * lights") is carried here so a wake session can replay it into the STT
 * engine via {@link SttProvider.feed}; a detector that cannot retain audio
 * simply omits it. When present it is mono PCM at 16 kHz normalized to
 * `[-1, 1]` (the openWakeWord mic's framing convention, issue #84, phase 4).
 */
export interface WakeDetection {
    /** Engine-reported match strength, when the engine provides one. */
    readonly confidence?: number;
    /**
     * The 16 kHz mono audio that preceded the wake phrase, for replay into
     * the STT engine that opens the session. Optional; engines that cannot
     * retain it omit it, and the session simply starts at the wake phrase.
     */
    readonly lookback?: Float32Array;
}

/** Per-listener callbacks handed to {@link WakeWordProvider.start}. */
export interface WakeCallbacks {
    /** The wake phrase matched; the client should begin a voice session. */
    readonly onWake: (detection: WakeDetection) => void;
    /** The detector failed (e.g. unsupported on this hardware). */
    readonly onError?: (error: VoiceError) => void;
}

/**
 * A wake-word engine — "is the user addressing J.A.R.V.I.S.?"
 *
 * Runs independently of any conversation: `start()` arms detection and it
 * stays armed across sessions until `stop()`. The client decides what a wake
 * event means (open a listening session, play a cue); the engine only
 * reports matches.
 */
export interface WakeWordProvider {
    /** Stable engine identifier, e.g. `"porcupine"` or `"transcript-match"`. */
    readonly id: string;
    /**
     * Arms detection.
     *
     * @param callbacks - Where matches are delivered.
     * @returns Resolves once the engine is listening for the wake phrase.
     */
    start(callbacks: WakeCallbacks): Promise<void>;
    /** Disarms detection; no callback fires after the returned promise resolves. */
    stop(): Promise<void>;
    /**
     * Hands back the detector's current look-back ring — the last ~2 seconds
     * of 16 kHz mono float PCM, ending **now**, not at match time (the ring
     * keeps capturing until `stop()`, so the window includes whatever the
     * user said after the phrase while the session's own microphone was
     * still opening). A wake session replays this through
     * {@link SttStartOptions.feed} so the opening words survive the handoff.
     * Callers drain BEFORE `stop()`, which discards the ring.
     *
     * Optional: detectors without a ring (or with nothing recorded) omit it
     * or return `null`. The 16 kHz rate is the look-back convention.
     */
    drainPostMatch?(): Float32Array | null;
}

/** Per-listener callbacks handed to {@link VadProvider.start}. */
export interface VadCallbacks {
    /** Speech began — the microphone hears someone. */
    readonly onSpeechStart: () => void;
    /** Speech ended — the basis for "pause ⇒ prompt complete" timeouts. */
    readonly onSpeechEnd: () => void;
    /**
     * The raw mic frames the detector just analyzed (optional tap). Engines
     * that only answer the yes/no question omit it. Each delivery is the
     * detector's analysis buffer (a private copy) in mono float samples at
     * the given rate — the seam a barge-in watch taps into a look-back ring
     * so the interrupted utterance's opening words survive the handoff to a
     * recognition session (#84 P6).
     */
    readonly onAudio?: (pcm: Float32Array, sampleRate: number) => void;
    /** The detector failed (e.g. no microphone track available). */
    readonly onError?: (error: VoiceError) => void;
}

/**
 * A voice-activity detector — "is someone speaking?"
 *
 * VAD is deliberately separate from STT and the wake word: it answers a
 * yes/no question with low latency and is what barge-in watches while
 * J.A.R.V.I.S. is speaking. End-of-speech and no-speech timeouts are built
 * from its events by the client, not by the detector.
 */
export interface VadProvider {
    /** Stable engine identifier, e.g. `"browser-aec"` or `"silero-wasm"`. */
    readonly id: string;
    /**
     * Starts emitting speech-start/speech-end events.
     *
     * @param callbacks - Where events are delivered.
     * @returns Resolves once the detector is monitoring the microphone.
     */
    start(callbacks: VadCallbacks): Promise<void>;
    /** Stops detection; no callback fires after the returned promise resolves. */
    stop(): Promise<void>;
}
