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

/** How often a ringing timer repeats its chime, in milliseconds. */
export const RING_INTERVAL_MS = 3000;

/**
 * How much alarm audio is queued ahead on the context clock, in milliseconds.
 *
 * A background tab's `setInterval` is throttled — Chrome clamps it to once a
 * minute after five minutes hidden — so a chime-per-tick alarm would go quiet
 * exactly when the tab is in the background, which is the normal place a timer
 * finds you. Web Audio scheduling is not throttled: queue minutes of pattern
 * in advance and top it up; a fully throttled top-up still lands well inside
 * the window it queued, so the alarm never gaps.
 */
const RING_LOOKAHEAD_MS = 120_000;

/** How often the queued alarm is topped back up. */
const RING_TOPUP_MS = 30_000;

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
    /** The top-up timer for a ringing alarm, or `null` when nothing rings. */
    private ringTimer: ReturnType<typeof setInterval> | null = null;
    /** Context-clock instant the alarm has been queued through, in seconds. */
    private ringScheduledUntil = 0;
    /** Queued tones, so Stop silences the look-ahead as well as the loop. */
    private ringTones: OscillatorNode[] = [];
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
     * The external-store snapshot: whether audio is scheduled *and* the
     * context can actually play it.
     *
     * The state half is not cosmetic. A suspended (or Safari-interrupted)
     * context freezes its clock, so a scheduled source never reaches its end
     * and `onended` never fires — the "scheduled" flag alone would then latch
     * true forever. The chat view keys the barge-in watch on this value
     * (#114), so a stuck `true` would leave the watch armed indefinitely and
     * let ambient speech open a session.
     */
    getSnapshot(): boolean {
        return this.speaking && this.ctx?.state === "running";
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
            // The snapshot flips as soon as the context runs; announce it, so
            // a store keyed on it (the barge-in watch's window, #114) sees the
            // audio it was told about.
            void ctx.resume().then(() => {
                this.notify();
                // A timer can fire before the first gesture; the overlay waits,
                // and the alarm starts the moment the browser lets sound out.
                if (this.ringTimer !== null) {
                    this.scheduleRing();
                }
            });
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

    /**
     * Starts the timer ring (#90 phase 4): a three-tone alarm, queued minutes
     * ahead on the audio clock and topped up until {@link stopRing}.
     *
     * Deliberately not the wake cue ({@link blip}) — that one is a nudge, this
     * one has to be impossible to ignore — and deliberately **off** the
     * `speaking` signal, so a ringing timer does not look like the assistant
     * talking (the barge-in watch keys on that, #114).
     *
     * Deliberately not one chime per `setInterval` either: hidden tabs throttle
     * timers, and a timer is most likely to fire while the tab is hidden. The
     * pattern is scheduled in advance and re-armed, so the throttled path only
     * affects the top-up, never the sound.
     *
     * A suspended context is silent, not a failure: {@link unlock} (from any
     * first gesture) schedules the alarm where the user left it.
     *
     * Idempotent: a second timer taking over the overlay keeps the loop it
     * already has rather than restarting the pattern.
     */
    startRing(): void {
        if (this.ringTimer !== null) {
            return;
        }
        this.ringScheduledUntil = 0;
        this.scheduleRing();
        this.ringTimer = setInterval(() => this.scheduleRing(), RING_TOPUP_MS);
        // Node timers would otherwise hold a test process open; browsers have
        // no `unref`, so this is structural rather than a typed API.
        (this.ringTimer as { unref?: () => void }).unref?.();
    }

    /** Stops the ring, including every tone already queued ahead. */
    stopRing(): void {
        if (this.ringTimer !== null) {
            clearInterval(this.ringTimer);
            this.ringTimer = null;
        }
        for (const tone of this.ringTones) {
            try {
                tone.stop();
            } catch {
                // Already ended: stopping it again is a no-op, never an error.
            }
        }
        this.ringTones = [];
        this.ringScheduledUntil = 0;
    }

    /**
     * Queues the alarm pattern from where it left off to the look-ahead
     * horizon. Called on start and on every top-up tick.
     */
    private scheduleRing(): void {
        const ctx = this.ensureContext();
        if (ctx === null || ctx.state === "suspended") {
            return;
        }
        const from = Math.max(ctx.currentTime, this.ringScheduledUntil);
        const until = ctx.currentTime + RING_LOOKAHEAD_MS / 1000;
        let at = from;
        while (at < until) {
            this.chimeAt(at);
            at += RING_INTERVAL_MS / 1000;
        }
        this.ringScheduledUntil = at;
    }

    /**
     * One alarm pattern starting at `start` on the context clock:
     * `880 → 660 → 990 Hz`, short, with a decay so it reads as a chime rather
     * than a tone.
     */
    private chimeAt(start: number): void {
        const ctx = this.ensureContext();
        if (ctx === null) {
            return;
        }
        [880, 660, 990].forEach((frequency, index) => {
            const at = start + index * 0.18;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "triangle";
            osc.frequency.setValueAtTime(frequency, at);
            gain.gain.setValueAtTime(0.22, at);
            gain.gain.exponentialRampToValueAtTime(0.001, at + 0.16);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(at);
            osc.stop(at + 0.17);
            this.ringTones.push(osc);
            osc.onended = () => {
                const queued = this.ringTones.indexOf(osc);
                if (queued !== -1) {
                    this.ringTones.splice(queued, 1);
                }
            };
        });
    }

    /** Stops playback and closes the context (view unmount). */
    dispose(): void {
        this.stopRing();
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
            this.notify();
        }
    }

    /** Notifies every store subscriber of a snapshot change. */
    private notify(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
