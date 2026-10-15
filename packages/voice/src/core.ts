/**
 * The minimal context the extracted feature machines (`BargeWatch`,
 * `WakeManager`) compose over (issue #110).
 *
 * The controller builds one of these in its constructor and hands it to each
 * machine, so a machine never reaches back into the controller: the mic-owner
 * interlocks that used to be shared privates (`bargeStopping`, `pendingReArm`)
 * become explicit machine-owned state, and the only controller surface a
 * machine touches is this interface.
 */
import type { VoiceEvent, VoiceSnapshot } from "./lifecycle";
import type { VadProvider } from "./types";

/**
 * The seam a feature machine is given. `snapshot`/`reduce` are the lifecycle
 * accessor pair; `vad` is the shared detector (sessions and the barge watch
 * are mutually exclusive owners); `stopVad` releases it; `isDisposed` lets a
 * machine abort a late async completion; `log` is the controller's injectable
 * debug sink.
 */
export interface VoiceCore {
    /** The current snapshot (stable reference between events). */
    snapshot(): VoiceSnapshot;
    /** Apply one lifecycle event, notifying subscribers on change. */
    reduce(event: VoiceEvent): void;
    /** The shared VAD, or `null` when the runtime has none. */
    readonly vad: VadProvider | null;
    /** Schedules a timer through the controller's injectable seam. */
    schedule(callback: () => void, ms: number): unknown;
    /** Cancels a timer scheduled by {@link schedule}. */
    unschedule(handle: unknown): void;
    /** The controller's debug sink (a no-op unless the caller supplied one). */
    log(message: string, error?: unknown): void;
    /**
     * The submit-time trace for a session whose transcript was transformed
     * (wake sessions strip the phrase): the recognition engine's raw text and
     * the exact prompt submitted. A deliberate second channel beside `log` so
     * a client can keep ordinary debug lines free of transcript text — real
     * user speech — while still making "what was heard" vs "what was sent"
     * diagnosable (issue #121, lesson 6). A no-op unless the caller supplied
     * one.
     */
    traceTranscript(raw: string, submitted: string): void;
    /** Whether the controller has been disposed. */
    isDisposed(): boolean;
    /** Stops the shared VAD; safe when none is configured or already stopped. */
    stopVad(): Promise<void>;
}
