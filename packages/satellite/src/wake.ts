/**
 * Wake-word transcript matching for the first satellite slice.
 *
 * The dedicated openWakeWord detector belongs to phase 1b. While that is being
 * ported, SoX's silence effect segments utterances and the local Whisper
 * transcript is checked for the wake phrase. Matching uses the shared
 * `stripWakePhrase` fuzzy matcher from `@lukestanbery/jarvis-voice`, so common
 * ASR manglings ("he jarvis", "a jarvis") still wake the device.
 */
import {
    DEFAULT_WAKE_PHRASE,
    stripWakePhrase,
} from "@lukestanbery/jarvis-voice";

/**
 * Returns the command after the wake phrase, or `null` when the transcript did
 * not address JARVIS. An empty string means "wake heard, but no command".
 *
 * The exact/fuzzy shared matcher handles a phrase at the start. A small regex
 * fallback catches a leading filler ("um, hey JARVIS, …") that the start-anchored
 * matcher deliberately leaves alone.
 */
export function extractWakeCommand(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return null;
    }

    const exact = stripWakePhrase(trimmed, DEFAULT_WAKE_PHRASE);
    if (exact !== trimmed) {
        return exact;
    }

    const justName = stripWakePhrase(trimmed, "JARVIS");
    if (justName !== trimmed) {
        return justName;
    }

    const match = /\b(?:hey|hi|ok|okay)?\s*(?:jarvis|jervis)\b/i.exec(trimmed);
    if (match === null) {
        return null;
    }
    return trimmed
        .slice(match.index + match[0].length)
        .replace(/^[,.;:!?\-–—'"“”\s]+/, "")
        .trim();
}
