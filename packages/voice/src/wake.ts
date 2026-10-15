/**
 * Wake-word manager (issue #84, phase 4; extracted in #110; single-mic
 * capture in #121).
 *
 * Owns the detector-armed state machine: arming the wake detector (and
 * pre-warming the wake engine's model alongside it), keeping it live through a
 * wake session so the command arrives on the detector's own microphone, and
 * restarting it once that session lands `idle`:
 *
 * ```text
 * enable ──► armed (snapshot.wakeArmed); wake engine's model pre-warmed
 *   detector match ──► onMatch(detection)  (controller: cue + begin)
 *   session begins ──► beginCommand ──► disarmed, detector STILL capturing
 *                       │   (the command streams to the session through
 *                       │    onCommandAudio — same mic, no handoff, #121)
 *   session lands idle ──► maybeReArm ──► stop + arm again
 * ```
 *
 * A wake session deliberately does **not** stop the detector (that is
 * {@link WakeManager.beginCommand} versus {@link WakeManager.disarmForSession},
 * which press and barge sessions use): the frames that follow the match *are*
 * the command, and the session's engine runs microphone-free over them. Only
 * when the session is over is the microphone released, so the detector is
 * restarted — not merely re-armed — by {@link WakeManager.maybeReArm}.
 *
 * The user's on/off intent (`wakeEnabled`) and the
 * `pendingReArm`/`wakeBusy` interlocks are privates here, so the controller
 * just forwards toggle calls and pings {@link WakeManager.maybeReArm} whenever
 * a session reaches `idle`.
 *
 * The controller callback {@link WakeManagerOptions.onMatch} plays the cue
 * and opens the session, and {@link WakeManagerOptions.onCommandAudio} forwards
 * the detector's live command frames to it; this manager never reaches back
 * into the controller's `begin()` itself.
 */
import type { VoiceCore } from "./core";
import { toVoiceError } from "./errors";
import type { SttProvider, WakeDetection, WakeWordProvider } from "./types";

/** The default wake phrase (must match the detector's trained phrase). */
export const DEFAULT_WAKE_PHRASE = "Hey JARVIS";

/** Construction options for {@link WakeManager}. */
export interface WakeManagerOptions {
    /** The wake-word detector; `null` disables wake-word support entirely. */
    readonly wake: WakeWordProvider | null;
    /**
     * The STT engine used for wake sessions; `null` disables wake sessions
     * even with a detector present. Pre-warmed alongside arming.
     */
    readonly wakeStt: SttProvider | null;
    /**
     * A detector match: the controller plays the wake cue and opens the
     * session (returning when it has opened, or immediately when the session
     * failed to open). The manager re-arms afterwards if the controller is
     * back to `idle`.
     */
    readonly onMatch: (detection: WakeDetection) => void | Promise<void>;
    /**
     * The detector's live post-match audio (#121): every 16 kHz frame from the
     * match onward, forwarded straight through so the wake session's engine
     * hears the command on the detector's own microphone. The controller
     * decides what to do with a frame that arrives before the session exists.
     * Default: dropped.
     */
    readonly onCommandAudio?: (pcm: Float32Array, sampleRate: number) => void;
}

/**
 * Owns the detector-armed state machine and its interlocks (issue #110).
 */
export class WakeManager {
    private readonly core: VoiceCore;
    private readonly wake: WakeWordProvider | null;
    private readonly wakeStt: SttProvider | null;
    private readonly onMatch: (
        detection: WakeDetection,
    ) => void | Promise<void>;
    private readonly onCommandAudio:
        ((pcm: Float32Array, sampleRate: number) => void) | undefined;
    /** Whether the user wants wake detection on (persisted by the client). */
    private wakeEnabled = false;
    /**
     * Set when the detector was paused for a session (or a wake just
     * opened one) and a successful return to `idle` should restart it. The
     * only trigger for {@link maybeReArm}; cleared by toggling.
     */
    private pendingReArm = false;
    /** Serializes the occasional re-arm so two races don't double-stop the detector. */
    private wakeBusy = false;

    /**
     * @param core - The shared context the extracted machines compose over.
     * @param options - The detector, the wake engine, and the match/audio
     * callbacks.
     */
    constructor(core: VoiceCore, options: WakeManagerOptions) {
        this.core = core;
        this.wake = options.wake;
        this.wakeStt = options.wakeStt;
        this.onMatch = options.onMatch;
        this.onCommandAudio = options.onCommandAudio;
    }

    /**
     * Arms the wake-word detector. Safe to call when already armed. While a
     * session owns the microphone this only records the intent and defers to
     * {@link maybeReArm} (#104, race 6).
     *
     * @returns Resolves once the detector is armed (or arming was deferred
     * or wake support is unavailable).
     */
    async enable(): Promise<void> {
        this.wakeEnabled = true;
        this.pendingReArm = false;
        if (this.core.snapshot().state !== "idle") {
            // A session owns the microphone; arming the detector now would
            // open a second one alongside it (#104, race 6). Defer to
            // `maybeReArm`, which arms the moment the session lands `idle`.
            this.pendingReArm = true;
            return;
        }
        await this.arm();
    }

    /**
     * Disarms the wake-word detector and leaves it off until
     * {@link enable} is called again. Safe when already disarmed.
     *
     * @returns Resolves once the detector is disarmed.
     */
    async disable(): Promise<void> {
        this.wakeEnabled = false;
        this.pendingReArm = false;
        await this.disarm();
    }

    /**
     * Pauses the detector because a **press or barge** session is about to own
     * the microphone: it is stopped — one mic owner at a time — and re-armed
     * when that turn lands `idle`. Runs from `begin()` for every non-wake
     * session.
     */
    disarmForSession(): void {
        if (this.wake === null || !this.core.snapshot().wakeArmed) {
            return;
        }
        this.pendingReArm = this.wakeEnabled;
        void this.wake.stop().catch(() => {
            // A detector that failed to stop is already dead.
        });
        this.core.reduce({ type: "wakeDisarmed" });
    }

    /**
     * Marks the start of a **wake** session (#121). The detector is *not*
     * stopped: it keeps capturing on its own microphone so the whole command —
     * not just the sliver captured before the session's engine was ready —
     * reaches the session through {@link WakeManagerOptions.onCommandAudio}.
     * Prediction is already paused (the detector fires once per arm), so the
     * snapshot flips to disarmed while the microphone stays open; the
     * microphone is released at the turn's end, when {@link maybeReArm}
     * restarts the detector.
     */
    beginCommand(): void {
        if (this.wake === null) {
            return;
        }
        this.pendingReArm = this.wakeEnabled;
        if (this.core.snapshot().wakeArmed) {
            this.core.reduce({ type: "wakeDisarmed" });
        }
    }

    /**
     * Restarts the detector after a session that interrupted or paused it,
     * when the user still wants wake detection. Fired whenever a session lands
     * `idle`; the `pendingReArm` flag (set by {@link disarmForSession},
     * {@link beginCommand}, or a failed wake open) makes it idempotent and
     * stops it racing a manual toggle.
     */
    maybeReArm(): void {
        if (
            !this.wakeEnabled ||
            !this.pendingReArm ||
            this.core.isDisposed() ||
            this.wake === null ||
            this.wakeStt === null
        ) {
            return;
        }
        if (
            this.core.snapshot().wakeArmed ||
            this.core.snapshot().state !== "idle"
        ) {
            return;
        }
        void this.restart();
    }

    /**
     * Tears down: disarms the detector. Idempotent.
     *
     * @returns Resolves once the detector is disarmed.
     */
    async dispose(): Promise<void> {
        this.wakeEnabled = false;
        this.pendingReArm = false;
        await this.disarm();
    }

    /**
     * Stops the detector and arms it again. A wake session leaves the detector
     * capturing for the whole command (#121), so at this point it is usually
     * still live — calling `start()` directly would reject as "already
     * active". The stop also releases the microphone the finished session no
     * longer needs.
     */
    private async restart(): Promise<void> {
        const wake = this.wake;
        if (wake === null || this.wakeBusy) {
            return;
        }
        this.wakeBusy = true;
        try {
            await wake.stop().catch(() => {
                // A detector that failed to stop is already dead.
            });
        } finally {
            this.wakeBusy = false;
        }
        await this.arm();
    }

    /**
     * Arms the detector (and, alongside it, pre-warms the wake engine's
     * model so the first wake session has nothing to stall on). No-ops while
     * armed, while arming, or when wake support is unavailable.
     */
    private async arm(): Promise<void> {
        if (
            this.wake === null ||
            this.wakeStt === null ||
            this.core.isDisposed() ||
            this.core.snapshot().wakeArmed ||
            this.wakeBusy
        ) {
            return;
        }
        this.wakeBusy = true;
        try {
            await this.wake.start({
                onWake: (detection) => void this.handleMatch(detection),
                onCommandAudio: (pcm, sampleRate) =>
                    this.onCommandAudio?.(pcm, sampleRate),
                onError: (error) =>
                    this.core.reduce({ type: "wakeFailed", error }),
            });
            const wakeStt = this.wakeStt;
            void wakeStt.prepare?.().catch((err) => {
                // The first wake session's own start() owns any failure —
                // but a failed pre-warm means the first wake session stalls
                // on a model download with no other trace.
                this.core.log("wake engine pre-warm failed", err);
            });
            this.core.reduce({ type: "wakeArmed" });
        } catch (err) {
            this.core.reduce({
                type: "wakeFailed",
                error: toVoiceError(err),
            });
        } finally {
            this.wakeBusy = false;
        }
    }

    /**
     * Disarms the detector, dropping any in-flight callbacks, and marks the
     * snapshot accordingly (safe when already disarmed).
     */
    private async disarm(): Promise<void> {
        if (this.wake === null) {
            return;
        }
        try {
            await this.wake.stop();
        } catch {
            // A detector that failed to stop is already dead.
        }
        if (this.core.snapshot().wakeArmed) {
            this.core.reduce({ type: "wakeDisarmed" });
        }
    }

    /**
     * A detector match. Ignored unless idle — a wake that lands mid-turn is
     * dropped; the detector stays armed until the turn settles, then
     * restarts. Hands the match to {@link WakeManagerOptions.onMatch} and, if
     * that returned without the session opening, restarts the pair so the
     * wake word works again without a manual toggle.
     *
     * @param detection - The detector's match, carrying the phrase's
     * confidence; the command audio that follows arrives through
     * {@link WakeManagerOptions.onCommandAudio}.
     */
    private async handleMatch(detection: WakeDetection): Promise<void> {
        if (
            this.wake === null ||
            this.wakeStt === null ||
            this.core.isDisposed()
        ) {
            return;
        }
        if (this.core.snapshot().state !== "idle") {
            return;
        }
        await this.onMatch(detection);
        if (this.core.snapshot().state === "idle") {
            // The session failed to open (its reducer said no); re-arm the
            // pair so the wake word works again without a manual toggle.
            this.pendingReArm = true;
            this.maybeReArm();
        }
    }
}
