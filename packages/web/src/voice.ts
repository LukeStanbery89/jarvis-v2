/**
 * Voice-input controller for the chat view (issue #84, phase 2).
 *
 * Binds the pure session lifecycle from `@lukestanbery/jarvis-voice` to a
 * real STT engine and to turn submission, so `views/Chat.tsx` renders from
 * a `VoiceSnapshot` and never touches microphone semantics directly. The
 * controller is deliberately React-free and engine-free (an injected
 * {@link SttProvider}, a injected submit function) so the whole flow is
 * unit-testable in the node environment with fakes.
 *
 * Flow of one press-to-talk turn:
 *
 * ```text
 * press ──► activate ──► stt.start
 *                             │ partials ──► local UI only
 *                             │ final ──► transcript ──► submitting
 *                             │              submitted ──► waiting
 *                             │              submit() (mode:"voice" prompt)
 *      first server frame ────┤ noteResponseFrame ──► responding
 *      turn resolves ─────────┴ responseEnded ──► idle
 *      turn rejects ────────────── rejected ────► idle (error recorded)
 * ```
 *
 * Race safety is inherited from the lifecycle reducer: recognition events
 * are tagged with the session id captured at activation, turn events are
 * tagged at dispatch, and the reducer ignores anything stale — so a late
 * engine callback or an old turn's end can never disturb a newer session.
 */
import {
    initialVoiceSnapshot,
    reduceVoice,
    type SttProvider,
    type VoiceError,
    type VoiceSnapshot,
} from "@lukestanbery/jarvis-voice";

/** Submits a final transcript as a chat turn (resolves on `done`). */
export type VoiceSubmit = (text: string) => Promise<void>;

/** Construction options for {@link VoiceController}. */
export interface VoiceControllerOptions {
    /** The STT engine driving recognition. */
    readonly stt: SttProvider;
    /** Submits the final transcript; rejection ends the voice turn as `rejected`. */
    readonly submit: VoiceSubmit;
}

/**
 * Owns one user's voice session: mic presses, engine wiring, transcript
 * submission, and the observable {@link VoiceSnapshot} the UI renders.
 */
export class VoiceController {
    private snapshot = initialVoiceSnapshot;
    private readonly listeners = new Set<() => void>();
    private readonly stt: SttProvider;
    private readonly submit: VoiceSubmit;

    /**
     * @param options - The engine and the submit seam (see
     * {@link VoiceControllerOptions}).
     */
    constructor(options: VoiceControllerOptions) {
        this.stt = options.stt;
        this.submit = options.submit;
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
     * while `listening`. Mid-flight states (transcribing/submitting/turn)
     * are deliberately inert until barge-in (phase 6).
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
     * Tears down: cancels any live recognition and drops listeners.
     *
     * @returns Resolves when the engine has stopped.
     */
    async dispose(): Promise<void> {
        await this.stt.cancel();
        this.listeners.clear();
    }

    /**
     * Starts a session: opens it in the reducer, then arms the engine with
     * callbacks tagged to the (captured) session id, so late deliveries
     * after a re-activation are stale by construction.
     */
    private async begin(): Promise<void> {
        this.reduce({ type: "activate" });
        const sessionId = this.snapshot.sessionId;
        try {
            await this.stt.start({
                onPartial: (text) => {
                    this.reduce({ type: "partial", sessionId, text });
                },
                onResult: (text) => {
                    this.onTranscript(sessionId, text);
                },
                onError: (error) => {
                    this.reduce({ type: "transcriptFailed", sessionId, error });
                },
            });
        } catch (err) {
            this.reduce({
                type: "transcriptFailed",
                sessionId,
                error: toVoiceError(err),
            });
        }
    }

    /** Stops capture; the engine flushes its final transcript if one exists. */
    private async finish(): Promise<void> {
        try {
            await this.stt.stop();
        } catch {
            // Engine failures surface through onError; nothing to do here.
        }
    }

    /**
     * Handles a final transcript: records it, moves to `waiting`, and
     * submits — routing the turn's end (resolved/rejected) back through the
     * reducer under the same session id. Empty transcripts never submit
     * (the reducer keeps the session in place).
     *
     * @param sessionId - The session the engine was armed for.
     * @param text - The final transcript.
     */
    private onTranscript(sessionId: number, text: string): void {
        this.reduce({ type: "transcript", sessionId, text });
        if (
            this.snapshot.state !== "submitting" ||
            this.snapshot.transcript === null
        ) {
            return;
        }
        const prompt = this.snapshot.transcript;
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
