/**
 * Raw-vs-submitted transcript tracing for the voice stack (#121, lesson 6).
 *
 * The wake→command failure was perceivable but not measurable: "the
 * transcription got worse" with no way to see what the recognizer actually
 * heard versus what was sent. This sink closes that gap, and it is
 * deliberately a *separate* switch from {@link debugLog} — it prints real
 * user speech, so turning on ordinary voice debugging must never start
 * dumping transcripts into the console.
 *
 * Enabled by `?voice-trace=1` (survives a cleared-storage habit) or
 * `localStorage["jarvis.voiceTrace"] = "1"` (survives reloads). Never on by
 * default.
 */

/** localStorage key for the transcript-trace preference. */
export const VOICE_TRACE_KEY = "jarvis.voiceTrace";

/** URL query parameter that turns tracing on for one page load. */
export const VOICE_TRACE_PARAM = "voice-trace";

/**
 * Whether transcript tracing is on: the storage flag, or the URL parameter.
 *
 * @param storage - Storage to read (injected for tests).
 * @param search - The location search string (injected for tests).
 * @returns True when tracing is enabled.
 */
export function voiceTraceEnabled(
    storage: Pick<Storage, "getItem"> = localStorage,
    search: string = window.location.search,
): boolean {
    try {
        if (storage.getItem(VOICE_TRACE_KEY) === "1") {
            return true;
        }
    } catch {
        // Storage unavailable (privacy mode): fall through to the URL.
    }
    try {
        return new URLSearchParams(search).get(VOICE_TRACE_PARAM) === "1";
    } catch {
        return false;
    }
}

/**
 * Renders one trace line. JSON-quoting both sides keeps an empty string and
 * trailing whitespace visible, which is the whole point of the trace.
 *
 * @param raw - The recognizer's unmodified transcript.
 * @param submitted - The prompt actually sent.
 * @returns The formatted line body.
 */
export function formatVoiceTrace(raw: string, submitted: string): string {
    return `raw=${JSON.stringify(raw)} submitted=${JSON.stringify(submitted)}`;
}

/**
 * Emits one raw-vs-submitted trace line when tracing is enabled; a no-op
 * otherwise. Wired to the voice controller's `traceTranscript` seam.
 *
 * @param raw - The recognizer's unmodified transcript.
 * @param submitted - The prompt actually sent.
 */
export function voiceTrace(raw: string, submitted: string): void {
    if (!voiceTraceEnabled()) {
        return;
    }
    console.log(`[jarvis:voice:trace] ${formatVoiceTrace(raw, submitted)}`);
}
