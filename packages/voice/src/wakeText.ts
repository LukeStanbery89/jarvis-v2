/**
 * Wake-word transcript hygiene (issue #84, phase 4).
 *
 * When a wake session opens with a look-back buffer, the STT engine hears
 * the wake phrase itself, so its transcript can begin with what the user
 * *said to trigger* ("hey jarvis turn on the lights") rather than the
 * command. This module owns stripping that phrase and any trailing
 * interjection off the transcript before it is displayed or submitted.
 *
 * The stripping is deliberately conservative: it only removes a
 * case-insensitive prefix match of the configured phrase plus a small set of
 * interjections ("hey jarvis, um, …"), and touches nothing when the phrase
 * is absent from the start. So a transcript from a session that never heard
 * the phrase is passed through unchanged. A transcript that is *nothing but*
 * the phrase strips to `""`, which the controller's empty-transcript guard
 * turns into a quiet no-op — waking up and saying only the phrase submits
 * no prompt.
 */

/** Leading interjections trimmed after the stripped wake phrase. */
const TRAILING_INTERJECTIONS = [
    "um",
    "uh",
    "er",
    "ah",
    "like",
    "so",
    "okay",
    "ok",
] as const;

/** Characters that may separate the wake phrase from the command. */
const SEPARATORS = /^[,.;:!?\-–—'’"“”\s]+/;

/**
 * Removes a leading wake phrase from a transcript, together with any
 * separator punctuation and a trailing interjection, for display and
 * submission in wake-word sessions.
 *
 * Matching is case-insensitive on the phrase and collapses its internal
 * whitespace ("Hey   JARVIS" strips as well as "Hey JARVIS"); the command
 * that follows is preserved verbatim. A transcript consisting of nothing but
 * the phrase strips to `""` (the empty-transcript guard then drops it).
 *
 * @param text - The raw transcript to clean.
 * @param phrase - The wake phrase, e.g. `"Hey JARVIS"`. An empty phrase
 * (disabled wake word) returns `text` unchanged, so callers can pass the
 * configured phrase without special-casing.
 * @returns The transcript with the leading phrase removed, trimmed; the
 * original text when nothing matched.
 */
export function stripWakePhrase(text: string, phrase: string): string {
    const words = phrase.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return text;
    }
    // Match the phrase at the very start, with any internal run of
    // whitespace collapsing into `\s+`, so "Hey   JARVIS" — as the engine
    // may transcribe a slow phrase — strips as well as "Hey JARVIS". The
    // match is case-insensitive; the remainder is sliced from the original
    // text, so the command keeps its case and spelling verbatim.
    const pattern = new RegExp(`^${words.map(escapeRegExp).join("\\s+")}`, "i");
    const match = pattern.exec(text);
    if (match === null) {
        return text;
    }
    return text
        .slice(match[0].length)
        .replace(SEPARATORS, "")
        .replace(
            new RegExp(`^(?:${TRAILING_INTERJECTIONS.join("|")})\\b`, "i"),
            "",
        )
        .replace(SEPARATORS, "")
        .trim();
}

/**
 * Escapes a phrase word for safe inclusion in the match regular expression.
 *
 * @param value - The raw phrase word.
 * @returns The word with regex metacharacters quoted.
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
