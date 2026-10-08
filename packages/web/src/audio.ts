/**
 * Gap-free WebAudio playback for the spoken response (#83).
 *
 * The server delivers a voice turn's audio as `audioStart` (the sample
 * rate, via the frame stream) plus a run of decoded PCM chunks (one per
 * spoken segment) plus `audioEnd`. This player queues each chunk's
 * `AudioBufferSourceNode` back-to-back — scheduled at
 * `max(now, end of previous)` so segments never overlap or gap — and
 * exposes a tiny external store (`subscribe`/`getSnapshot`) so the UI can
 * show a speaking indicator.
 *
 * Browser rule: an AudioContext starts suspended unless created/resumed
 * from a user gesture, so callers call {@link unlock} from the mic press —
 * the gesture that begins the voice interaction; later `play()` calls are
 * then allowed to be heard. The context factory is injectable so the
 * queueing logic is testable in node without WebAudio.
 */

/** Options for {@link AudioPlayer}. */
export interface AudioPlayerOptions {
    /**
     * Context factory override for tests; defaults to constructing a real
     * `AudioContext` when the runtime has one, `null` otherwise — the
     * player then no-ops silently and the text response is unaffected.
     */
    readonly createContext?: () => AudioContext | null;
}

/**
 * The spoken-audio queue. One player per chat view; reuse across turns
 * (each turn's `audioStart` refreshes the format).
 */
export class AudioPlayer {
    private ctx: AudioContext | null = null;
    private sampleRate = 24000;
    /** Earliest time the next queued buffer may start (context clock). */
    private nextStart = 0;
    private sources: AudioBufferSourceNode[] = [];
    private readonly listeners = new Set<() => void>();
    private speaking = false;
    private readonly createContext: () => AudioContext | null;

    /**
     * @param options - The context factory override (tests).
     */
    constructor(options: AudioPlayerOptions = {}) {
        this.createContext =
            options.createContext ??
            (() =>
                typeof AudioContext === "function" ? new AudioContext() : null);
    }

    /**
     * The external-store snapshot: whether scheduled audio remains.
     * Stable between changes, as `useSyncExternalStore` requires.
     */
    getSnapshot(): boolean {
        return this.speaking;
    }

    /**
     * Subscribes to speaking-state changes.
     *
     * @param listener - Called after the boolean flips.
     * @returns Unsubscribe function.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Creates (once) and resumes the context. Call from a user gesture —
     * the mic press — so later `play()` scheduling is actually audible.
     */
    unlock(): void {
        const ctx = this.ensureContext();
        if (ctx !== null && ctx.state === "suspended") {
            void ctx.resume();
        }
    }

    /**
     * Records the spoken span's sample rate (from the `audioStart` frame).
     *
     * @param sampleRate - The PCM sample rate for this turn's chunks.
     */
    setFormat(sampleRate: number): void {
        this.sampleRate = sampleRate;
    }

    /**
     * Queues one decoded chunk: scheduled at the earliest time that is
     * both now and after everything already queued.
     *
     * @param pcm - Mono float samples (from the protocol's `s16leToPcm`).
     */
    play(pcm: Float32Array): void {
        const ctx = this.ensureContext();
        if (ctx === null || pcm.length === 0) {
            return;
        }
        const buffer = ctx.createBuffer(1, pcm.length, this.sampleRate);
        // copyToChannel wants an ArrayBuffer-backed view; copy once.
        buffer.copyToChannel(new Float32Array(pcm), 0);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const start = Math.max(ctx.currentTime, this.nextStart);
        source.start(start);
        this.nextStart = start + buffer.duration;
        this.sources.push(source);
        source.onended = () => {
            this.sources = this.sources.filter((s) => s !== source);
            if (this.sources.length === 0) {
                this.setSpeaking(false);
            }
        };
        this.setSpeaking(true);
    }

    /** Stops playback immediately, dropping everything queued. */
    stop(): void {
        for (const source of this.sources) {
            try {
                source.stop();
            } catch {
                // Already stopped or never started — nothing to do.
            }
        }
        this.sources = [];
        this.nextStart = 0;
        this.setSpeaking(false);
    }

    /**
     * Plays the wake-word cue (#84 P4): a short two-tone blip on the shared
     * context, so the armed detector's match is noticed even with the mic
     * muted. Kept off the `speaking` signal — it is a cue, not a response.
     */
    blip(): void {
        const ctx = this.ensureContext();
        if (ctx === null || ctx.state === "suspended") {
            return;
        }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.07);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.18);
    }

    /** Stops playback and closes the context (view unmount). */
    dispose(): void {
        this.stop();
        if (this.ctx !== null) {
            void this.ctx.close();
            this.ctx = null;
        }
    }

    /**
     * Creates the context lazily, once.
     *
     * @returns The context, or `null` when the runtime has none.
     */
    private ensureContext(): AudioContext | null {
        if (this.ctx === null) {
            this.ctx = this.createContext();
        }
        return this.ctx;
    }

    /**
     * Flips the speaking flag and notifies listeners when it changed.
     *
     * @param next - The new speaking state.
     */
    private setSpeaking(next: boolean): void {
        if (this.speaking !== next) {
            this.speaking = next;
            for (const listener of this.listeners) {
                listener();
            }
        }
    }
}
