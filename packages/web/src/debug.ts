/**
 * Client-side debug logging, gated by a localStorage flag.
 *
 * The web package deliberately has no logger (the repo's logger is
 * Node-only); the one console call it shipped (the TTFA metric) is visible
 * only with devtools open, which is the right posture for a browser SPA.
 * But the voice stack has real silent-degradation modes (VAD unavailable →
 * press-to-stop endpointing, barge watch not arming, an engine cancelled
 * mid-start), and "the feature silently does nothing" is undebuggable
 * without a trace.
 *
 * The gate is either `localStorage["jarvis.debug"] === "1"` or a `debug=1`
 * URL query parameter — the localStorage flag survives reloads, and the
 * query parameter survives the "clear site data" habit that wipes storage
 * between tests (`http://localhost:5173/web/?debug=1`). Both read per call,
 * so a live session picks the flag up without a rebuild. Lines go through
 * `console.log`, not `console.debug`: Chrome's devtools filter hides
 * `console.debug` unless "Verbose" is enabled, which made gated traces
 * look like "nothing in the console".
 *
 * Never log tokens, prompts, or transcripts through here — credentials and
 * user payloads stay out of the console on every path.
 */

/**
 * Emits one debug line when the flag is on; a no-op otherwise.
 *
 * @param scope - Short namespace for the line, e.g. `"voice"`, `"ws"`.
 * @param message - The diagnostic line (no level prefixes).
 * @param error - Optional error object/cause appended when present.
 */
export function debugLog(
    scope: string,
    message: string,
    error?: unknown,
): void {
    if (!debugEnabled()) {
        return;
    }
    if (error !== undefined) {
        console.log(`[jarvis:${scope}] ${message}`, error);
    } else {
        console.log(`[jarvis:${scope}] ${message}`);
    }
}

/** Whether the debug gate is on (storage flag or `debug=1` URL param). */
function debugEnabled(): boolean {
    try {
        if (localStorage.getItem("jarvis.debug") === "1") {
            return true;
        }
    } catch {
        // Storage unavailable (privacy mode): fall through to the URL.
    }
    try {
        return new URLSearchParams(window.location.search).get("debug") === "1";
    } catch {
        return false;
    }
}
