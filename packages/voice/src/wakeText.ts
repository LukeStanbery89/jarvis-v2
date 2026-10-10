/**
 * Wake-word transcript hygiene (issue #84, phase 4).
 *
 * When a wake session opens with a look-back buffer, the STT engine hears
 * the wake phrase itself, so its transcript can begin with what the user
 * *said to trigger* ("hey jarvis turn on the lights") rather than the
 * command. This module owns stripping that phrase and any trailing
 * interjection off the transcript before it is displayed or submitted.
 *
 * The stripping is deliberately conservative, in two tiers. First an exact
 * match: a case-insensitive prefix match of the configured phrase plus a
 * small set of interjections ("hey jarvis, um, …"), touching nothing when
 * the phrase is absent from the start. Then a fallback for the ASR-mangled
 * phrase: the local engine often hears "Hey JARVIS" as "he jarvis" or
 * "a jarvis", and the mangled phrase would otherwise ride into the prompt.
 * The fallback strips a leading token group where every phrase word
 * positionally fuzzy-matches (edit distance ≤ 2 for 4+-char words, ≤ 1 for
 * shorter ones — "he" strips for "hey", but a word nothing like "jarvis",
 * such as "drove", never does). A transcript that is *nothing but* the
 * phrase strips to `""`, which the controller's empty-transcript guard
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
 * that follows is preserved verbatim. When the exact phrase is absent, a
 * conservative fuzzy match strips common ASR manglings of it ("he jarvis",
 * "a jarvis" for "Hey JARVIS") — see the module doc. A transcript
 * consisting of nothing but the phrase strips to `""` (the empty-transcript
 * guard then drops it).
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
    if (match !== null) {
        return stripTail(text.slice(match[0].length));
    }
    return stripMangledPhrase(text, words);
}

/**
 * Trims separator punctuation and one trailing interjection off a
 * transcript's post-phrase remainder.
 *
 * @param remainder - The text after the (exact or fuzzy) phrase match.
 * @returns The cleaned remainder, trimmed.
 */
function stripTail(remainder: string): string {
    return remainder
        .replace(SEPARATORS, "")
        .replace(
            new RegExp(`^(?:${TRAILING_INTERJECTIONS.join("|")})\\b`, "i"),
            "",
        )
        .replace(SEPARATORS, "")
        .trim();
}

/**
 * The fuzzy fallback: strips the phrase when its word positions all
 * fuzzy-match the transcript's leading tokens — the shape "Hey JARVIS"
 * takes when the local engine mishears it ("he jarvis", "a jarvis"). Every
 * phrase word must match its positional token (a token that is nothing like
 * the phrase word — "drove" against "jarvis" — refuses the strip), so
 * genuine commands are never touched.
 *
 * @param text - The raw transcript (the exact match already failed).
 * @param words - The wake phrase's words, in order.
 * @returns The cleaned remainder, or the untouched text when no fuzzy
 *   match.
 */
function stripMangledPhrase(text: string, words: string[]): string {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < words.length) {
        return text;
    }
    for (let i = 0; i < words.length; i += 1) {
        const word = words[i]!.toLowerCase();
        if (
            editDistance(tokens[i]!.toLowerCase(), word) >
            (word.length >= 4 ? 2 : 1)
        ) {
            return text;
        }
    }
    return stripTail(tokens.slice(words.length).join(" "));
}

/**
 * Levenshtein edit distance between two short tokens (used only on
 * single words, so the quadratic DP is bounded by token length).
 *
 * @param a - First token.
 * @param b - Second token.
 * @returns The minimum number of single-character insertions, deletions,
 *   and substitutions between the two.
 */
function editDistance(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        let diagonal = previous[0]!;
        previous[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const above = previous[j]!;
            previous[j] = Math.min(
                above + 1,
                previous[j - 1]! + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            diagonal = above;
        }
    }
    return previous[b.length]!;
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
