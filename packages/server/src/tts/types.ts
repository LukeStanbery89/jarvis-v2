/**
 * The server-side TTS engine seam (issue #83, phase 1).
 *
 * One responsibility: turn a snippet of speakable text into PCM audio,
 * cancellable. Deliberately minimal — the response segmenter and audio
 * orchestrator (later #83 phases) sit ON TOP of this seam, and the wire
 * protocol lives entirely elsewhere. A provider never sees sessions,
 * sockets, or conversation history.
 *
 * The asymmetry with `@lukestanbery/jarvis-voice` is the design: STT is
 * client-side (clients own their microphones), TTS is server-side (the
 * server owns the one consistent J.A.R.V.I.S. voice; clients only play
 * audio).
 */

/**
 * One synthesis result: mono float PCM plus its sample rate. The PCM is the
 * provider's own buffer — consumers must not mutate it, and the orchestrator
 * copies chunks onto the wire.
 */
export interface SynthesizedSpeech {
    /** Float32 samples in [-1, 1], mono. */
    readonly pcm: Float32Array;
    /** Sample rate of {@link SynthesizedSpeech.pcm}, in Hz (Kokoro: 24000). */
    readonly sampleRate: number;
}

/** Options for one {@link TtsProvider.synthesize} call. */
export interface SynthesizeOptions {
    /**
     * Cooperative cancellation: checked before and after the engine runs.
     * A synthesis already in flight cannot be interrupted inside the engine
     * (Kokoro has no abort hook) — the caller still gets a rejection and
     * drops the finished audio unused.
     */
    readonly signal?: AbortSignal;
}

/**
 * A text-to-speech engine. Implementations are synchronous-callable and
 * internally stateful (model weights, voice selection); they must be safe
 * to call while a previous synthesis is still in flight — the orchestrator
 * serializes segments through one worker, but nothing here enforces it.
 */
export interface TtsProvider {
    /** Stable engine identifier, e.g. `"kokoro"`. */
    readonly id: string;
    /**
     * Synthesizes one snippet of speakable text.
     *
     * @param text - The text to speak (whitespace-trimmed by the caller is
     * not required; providers trim before refusing empty input).
     * @param options - Cancellation and per-call options.
     * @returns The synthesized speech.
     * @throws When the text is empty, the signal is aborted, or the engine
     * fails to load or generate.
     */
    synthesize(
        text: string,
        options?: SynthesizeOptions,
    ): Promise<SynthesizedSpeech>;
}
