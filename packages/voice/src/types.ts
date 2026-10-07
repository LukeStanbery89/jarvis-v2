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
 * A speech-to-text engine.
 *
 * Contract:
 * - `start()` begins recognition and rejects if the provider is not idle.
 * - `stop()` ends capture and flushes; the final transcript (if any)
 *   arrives through the active callbacks' `onResult`.
 * - `cancel()` aborts and discards: it resolves when the engine has fully
 *   stopped, after which no callback for that session will fire.
 * - `state` reflects the current lifecycle for UI display.
 *
 * Implementations own microphone permission prompting and must not assume a
 * particular UI, transport, or conversation model.
 */
export interface SttProvider {
    /** Stable engine identifier, e.g. `"web-speech"` or `"whisper-wasm"`. */
    readonly id: string;
    /** Current provider lifecycle. */
    readonly state: SttState;
    /**
     * Starts a recognition session.
     *
     * @param callbacks - Results for this session only.
     * @returns Resolves once the engine is capturing.
     */
    start(callbacks: SttCallbacks): Promise<void>;
    /** Ends capture, delivering the final transcript through `onResult` if one exists. */
    stop(): Promise<void>;
    /** Aborts the session; no callback fires after the returned promise resolves. */
    cancel(): Promise<void>;
}

/**
 * What a wake-word detector saw. The look-back buffer that retains audio
 * spoken in the same breath as the wake phrase ("Hey JARVIS, turn on the
 * lights") is plumbed through here once wake-word support lands (issue #84,
 * phase 4); engines that cannot retain audio simply omit it.
 */
export interface WakeDetection {
    /** Engine-reported match strength, when the engine provides one. */
    readonly confidence?: number;
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
}

/** Per-listener callbacks handed to {@link VadProvider.start}. */
export interface VadCallbacks {
    /** Speech began — the microphone hears someone. */
    readonly onSpeechStart: () => void;
    /** Speech ended — the basis for "pause ⇒ prompt complete" timeouts. */
    readonly onSpeechEnd: () => void;
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
