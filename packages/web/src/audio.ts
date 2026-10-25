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

/**
 * The analysis window the particle field reads (#146 phase E), in samples.
 *
 * 256 is about 5 ms at the protocol's 24 kHz — one animation frame's worth of
 * speech, which is the resolution the field moves at. A larger window lags the
 * syllables; a smaller one is noisy.
 */
const ANALYSER_FFT_SIZE = 256;

/**
 * How far the measured RMS is scaled up before clamping to 0..1.
 *
 * A spoken response is mastered well below full scale (a voice peaks around
 * 0.2, and its RMS through a sentence sits near 0.08), so a raw RMS would
 * barely move the breathe. Six puts ordinary speech just under the middle of
 * the range and a shout at the top, which is the point the field's own
 * `ENERGY_AMPLITUDE` is sized against.
 */
const ENERGY_GAIN = 6;

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
    /**
     * The alarm's own output bus (#177 follow-up: Stop must be immediate).
     *
     * Every chime is mixed through one gain, and Stop disconnects that gain
     * from the destination. Stopping the oscillators alone can leave a tone
     * audible on browsers that have already handed a scheduled source to the
     * hardware; detaching the bus silences everything connected to it, queued
     * or already sounding. A fresh bus is created on the next ring so a stale
     * tone can never be unmuted by the next alarm.
     */
    private ringOutput: GainNode | null = null;
    private readonly listeners = new Set<() => void>();
    private speaking = false;
    /**
     * The tap speech is routed through (#146 phase E), or `null` where the
     * context has no analyser (an old context, or a test fake).
     */
    private analyser: AnalyserNode | null = null;
    /**
     * The window {@link energy} fills, allocated once with the analyser.
     *
     * Backed by a plain `ArrayBuffer` because `getFloatTimeDomainData` does
     * not accept a `SharedArrayBuffer`-backed view.
     */
    private samples: Float32Array<ArrayBuffer> | null = null;
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
     * The loudness of the response being spoken, 0..1 (#146 phase E).
     *
     * The root mean square of the last {@link ANALYSER_FFT_SIZE} samples,
     * scaled by {@link ENERGY_GAIN} and clamped. Called once per animation
     * frame by the particle field, so it must allocate nothing: it fills the
     * window allocated with the analyser. Zero the moment nothing is speaking,
     * so the disc settles with the last word instead of holding the peak.
     *
     * @returns Loudness in [0, 1]; 0 with no context, no tap, or no speech.
     */
    energy(): number {
        const analyser = this.analyser;
        const samples = this.samples;
        if (analyser === null || samples === null || !this.speaking) {
            return 0;
        }
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let index = 0; index < samples.length; index += 1) {
            sum += samples[index] * samples[index];
        }
        const rms = Math.sqrt(sum / samples.length);
        return Math.min(1, rms * ENERGY_GAIN);
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
        // Through the tap when there is one, so the field can hear the voice
        // (#146 phase E). The alarm and the wake cue stay direct: the field
        // answers the assistant, not every sound the app makes.
        source.connect(this.analyser ?? ctx.destination);
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
        this.ensureRingOutput();
        // Arm the loop before the first schedule, so `scheduleRing` can treat
        // a null timer as "stopped" and a queued top-up cannot revive a ring
        // the user just dismissed.
        this.ringTimer = setInterval(() => this.scheduleRing(), RING_TOPUP_MS);
        this.scheduleRing();
        // Node timers would otherwise hold a test process open; browsers have
        // no `unref`, so this is structural rather than a typed API.
        (this.ringTimer as { unref?: () => void }).unref?.();
    }

    /**
     * Stops the ring, including every tone already queued ahead.
     *
     * Muting the whole output bus is the load-bearing half: it silences a
     * chime the hardware has already begun, even if stopping its oscillator
     * does not. The bus is then disconnected so the next ring starts clean.
     */
    stopRing(): void {
        if (this.ringTimer !== null) {
            clearInterval(this.ringTimer);
            this.ringTimer = null;
        }
        const ctx = this.ctx;
        if (this.ringOutput !== null) {
            if (ctx !== null) {
                this.ringOutput.gain.setValueAtTime(0, ctx.currentTime);
            }
            this.ringOutput.disconnect();
            this.ringOutput = null;
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
     * The gain every chime is mixed through, created on demand and connected
     * to the speakers.
     *
     * @returns The alarm bus, or `null` when the runtime has no context.
     */
    private ensureRingOutput(): GainNode | null {
        const ctx = this.ensureContext();
        if (ctx === null) {
            return null;
        }
        if (this.ringOutput === null) {
            const output = ctx.createGain();
            output.gain.setValueAtTime(1, ctx.currentTime);
            output.connect(ctx.destination);
            this.ringOutput = output;
        }
        return this.ringOutput;
    }

    /**
     * Queues the alarm pattern from where it left off to the look-ahead
     * horizon. Called on start and on every top-up tick.
     */
    private scheduleRing(): void {
        if (this.ringTimer === null) {
            return;
        }
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
        const output = this.ensureRingOutput();
        if (output === null) {
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
            gain.connect(output);
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
        this.analyser = null;
        this.samples = null;
    }

    /**
     * Creates the context lazily, once.
     *
     * @returns The context, or `null` when the runtime has none.
     */
    private ensureContext(): AudioContext | null {
        if (this.ctx === null) {
            this.ctx = this.createContext();
            if (this.ctx !== null) {
                this.analyser = this.createTap(this.ctx);
            }
        }
        return this.ctx;
    }

    /**
     * Builds the analysis tap speech is routed through (#146 phase E), and the
     * window {@link energy} fills.
     *
     * Optional on purpose: `createAnalyser` is a WebAudio standard, but a test
     * fake need not implement it, and a context without one simply has no tap —
     * the field stays still and nothing else changes.
     *
     * @param ctx - The freshly created context.
     * @returns The analyser, already connected to the destination, or `null`.
     */
    private createTap(ctx: AudioContext): AnalyserNode | null {
        if (typeof ctx.createAnalyser !== "function") {
            return null;
        }
        const analyser = ctx.createAnalyser();
        analyser.fftSize = ANALYSER_FFT_SIZE;
        // The field does its own smoothing per frame; the analyser's own would
        // lag it twice over.
        analyser.smoothingTimeConstant = 0;
        analyser.connect(ctx.destination);
        this.samples = new Float32Array(analyser.fftSize);
        return analyser;
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
