/**
 * Wake-word manager (issue #84, phase 4; extracted in #110).
 *
 * Owns the detector-armed state machine: arming the wake detector (and
 * pre-warming the wake engine's model alongside it), disarming it while a
 * session owns the microphone, and re-arming it once that session lands
 * `idle`:
 *
 * ```text
 * enable ──► armed (snapshot.wakeArmed); wake engine's model pre-warmed
 *   detector match ──► onMatch(detection)  (controller: cue + begin)
 *   session begins ──► disarmForSession ──► disarmed
 *   session lands idle ──► maybeReArm ──► armed again
 * ```
 *
 * The detector (and its warm model) stays armed across sessions; it is only
 * disarmed while a session owns the mic. The user's on/off intent
 * (`wakeEnabled`) and the `pendingReArm`/`wakeBusy` interlocks are privates
 * here, so the controller just forwards toggle calls and pings
 * {@link WakeManager.maybeReArm} whenever a session reaches `idle`.
 *
 * The controller callback {@link WakeManagerOptions.onMatch} plays the cue
 * and opens the session; this manager never reaches back into the
 * controller's `begin()` itself.
 */
import type { VoiceCore } from "./core";
import { toVoiceError } from "./errors";
import type { SttProvider, WakeDetection, WakeWordProvider } from "./types";

/** The default wake phrase (must match the detector's trained phrase). */
export const DEFAULT_WAKE_PHRASE = "Hey JARVIS";

/**
 * Joins the match-time look-back with the audio drained from the detector at
 * session open, in recognition order, so the replayed opening covers what the
 * user said in the same breath as the wake phrase. Either side may be absent.
 *
 * @param lookback - The look-back captured at match time, if any.
 * @param drained - The detector's post-match ring, if any.
 * @returns The joined buffer, the single present side, or `null`.
 */
export function wakeReplay(
    lookback: Float32Array | undefined,
    drained: Float32Array | null,
): Float32Array | null {
    if (lookback !== undefined && drained !== null) {
        return concatFloat32(lookback, drained);
    }
    return lookback ?? drained;
}

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
    /** Whether the user wants wake detection on (persisted by the client). */
    private wakeEnabled = false;
    /**
     * Set when the detector was disarmed for a session (or a wake just
     * opened one) and a successful return to `idle` should re-arm it. The
     * only trigger for {@link maybeReArm}; cleared by toggling.
     */
    private pendingReArm = false;
    /** Serializes the occasional re-arm so two races don't double-stop the detector. */
    private wakeBusy = false;

    /**
     * @param core - The shared context the extracted machines compose over.
     * @param options - The detector, the wake engine, and the match callback.
     */
    constructor(core: VoiceCore, options: WakeManagerOptions) {
        this.core = core;
        this.wake = options.wake;
        this.wakeStt = options.wakeStt;
        this.onMatch = options.onMatch;
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
     * Disarms an armed detector because a session is about to own the mic.
     * Runs from `begin()` for every session (wake or press), and re-arms
     * when that turn lands `idle` — so wake detection pauses while the
     * microphone is live and resumes automatically once it is free.
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
     * Re-arms the detector after a session that interrupted it, when the
     * user still wants wake detection. Fired whenever a session lands
     * `idle`; the `pendingReArm` flag (set by {@link disarmForSession} or a
     * failed wake open) makes it idempotent and stops it racing a manual
     * toggle.
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
        void this.arm();
    }

    /**
     * Drains the detector's post-match look-back ring (16 kHz mono float
     * PCM), for {@link wakeReplay} to seed the opening session. Callers must
     * drain BEFORE the detector is stopped, which discards the ring.
     *
     * @returns The ring's PCM, or `null` when unsupported or empty.
     */
    drainPostMatch(): Float32Array | null {
        return this.wake?.drainPostMatch?.() ?? null;
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
     * re-arms. Hands the match to {@link WakeManagerOptions.onMatch} and, if
     * that returned without the session opening, re-arms the pair so the
     * wake word works again without a manual toggle.
     *
     * @param detection - The detector's match, carrying the phrase's
     * confidence and the look-back audio to replay into the wake engine.
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

/**
 * Joins two PCM buffers into one.
 *
 * @param a - The leading buffer.
 * @param b - The trailing buffer.
 * @returns A new buffer containing `a` followed by `b`.
 */
function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
