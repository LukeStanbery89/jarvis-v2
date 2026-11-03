/**
 * Wake-word transcript matching for the first satellite slice.
 *
 * The dedicated openWakeWord detector belongs to phase 1b. While that is being
 * ported, SoX's silence effect segments utterances and the local Whisper
 * transcript is checked for the wake phrase. Matching uses the shared
 * `stripWakePhrase` fuzzy matcher from `@lukestanbery/jarvis-voice`, so common
 * ASR manglings ("he jarvis", "a jarvis") still wake the device.
 *
 * `resolveWakeUtterance` also owns the follow-up rules: a transcript without
 * the wake phrase is a command only while a follow-up window is open, and a
 * second wake-only phrase re-arms the wait rather than being discarded.
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

/**
 * Extracts a command when openWakeWord already proved the phrase was spoken.
 *
 * Whisper sometimes mangles the short wake phrase into a different leading
 * clause ("You drove us, tell me…"). The detector is the authority on whether
 * the phrase happened, so when exact matching fails, a short comma-terminated
 * leading clause is treated as the misheard wake phrase.
 *
 * @param text - The full local transcript.
 * @returns The command, `""` for a wake-only utterance, or `null` when no
 *   command can be recovered.
 */
export function extractCommandAfterWake(text: string): string | null {
    const exact = extractWakeCommand(text);
    if (exact !== null) {
        return exact;
    }
    const comma = text.indexOf(",");
    if (comma <= 0) {
        return null;
    }
    const prefix = text.slice(0, comma).trim();
    const command = text.slice(comma + 1).trim();
    if (command.length === 0) {
        return null;
    }
    const words = prefix.match(/[a-z0-9']+/gi) ?? [];
    if (words.length === 0 || words.length > 4) {
        return null;
    }
    return command;
}

/** What the wake loop should do with one transcript. */
export type WakeDecision =
    | { readonly kind: "ignore" }
    | { readonly kind: "wait" }
    | { readonly kind: "command"; readonly command: string };

/**
 * Decides whether an utterance starts a turn.
 *
 * Normal mode requires the wake phrase. A follow-up window is open after a
 * wake-only utterance or after a completed reply; there, a transcript without
 * the wake phrase is already a command, and a second wake-only phrase simply
 * re-arms the wake wait. This is pure so the follow-up state machine is tested
 * without a microphone.
 */
export function resolveWakeUtterance(
    text: string,
    followUpActive: boolean,
): WakeDecision {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return { kind: "ignore" };
    }

    const wake = extractWakeCommand(trimmed);
    if (followUpActive) {
        if (wake === "") {
            return { kind: "wait" };
        }
        return { kind: "command", command: wake ?? trimmed };
    }

    if (wake === null) {
        return { kind: "ignore" };
    }
    if (wake === "") {
        return { kind: "wait" };
    }
    return { kind: "command", command: wake };
}

/**
 * True for a spoken stop/cancel command that should end the current turn
 * without producing a reply.
 *
 * The match is applied after the wake phrase is stripped, so both "stop" and
 * "Hey JARVIS, stop" qualify. Punctuation and a trailing "please" are ignored.
 */
export function isStopCommand(text: string): boolean {
    const normalized = text
        .trim()
        .toLowerCase()
        .replace(/[.!?,;:]+$/g, "")
        .replace(/\s+please$/, "")
        .trim();
    return /^(?:stop|stop it|stop talking|shut up|be quiet|quiet|cancel|never mind|nevermind)$/.test(
        normalized,
    );
}

/**
 * Recognizes a transcript that is one token repeated over and over.
 *
 * The satellite has no echo cancellation; a barge-in false trigger can seed
 * Whisper with a few hundred milliseconds of the reply, which sometimes comes
 * back as “EH EH EH …”. Such a transcript is never a real prompt and must not
 * be sent to the model.
 */
export function looksLikeRepeatedNoise(text: string): boolean {
    const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    if (words.length < 3) {
        return false;
    }
    const first = words[0];
    return words.every((word) => word === first);
}
