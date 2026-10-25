/**
 * GitHub issue references (#140/#140).
 *
 * The relay model is given an issue URL by the user (or by `getGitHubIssue`)
 * and must hand that reference to `startCodingJob`. GitHub has one canonical
 * URL for an issue and two convenient short forms, so this module is the one
 * place that turns any of them into the number the service reads and the
 * `owner/name` a URL names. It also reads a *message* for one unambiguous
 * issue link, which is the fallback that keeps a shared issue attached even
 * when the relay summarizes it instead of passing `issue`.
 *
 * Kept pure and dependency-free: `coding.ts` uses the single-reference parser,
 * `agent.ts` uses the message reader, and tests can pin both without a model
 * or a network.
 */

/** One issue, by number and — when a URL named it — its repository. */
export interface IssueRef {
    /** The issue number GitHub uses in its API. */
    readonly number: number;
    /** `owner/name`, when the reference was a URL. */
    readonly repo?: string;
}

/** A bare number (`157`) or a hash-prefixed one (`#157`). */
const BARE = /^#?(\d+)$/;

/** A full GitHub issue URL, with optional trailing path/query/fragment. */
const ISSUE_URL =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

/** An issue URL anywhere in a message (the shared-issue case). */
const ISSUE_URL_IN_TEXT =
    /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#][^\s]*)?/gi;

/** A pull-request URL anywhere in a message. */
const PULL_URL_IN_TEXT = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;

/**
 * Reads one issue reference.
 *
 * @param value - The model's `issue` argument: a number, `#157`, or a URL.
 * @returns The reference, or `null` when it names no issue.
 */
export function parseIssueRef(value: string | number): IssueRef | null {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0
            ? { number: value }
            : null;
    }
    const text = value.trim();
    const bare = BARE.exec(text);
    if (bare !== null) {
        const number = Number(bare[1]);
        return Number.isSafeInteger(number) && number > 0 ? { number } : null;
    }
    const url = ISSUE_URL.exec(text);
    if (url === null) {
        return null;
    }
    const [, owner, name, rawNumber] = url;
    const number = Number(rawNumber);
    if (
        owner === undefined ||
        name === undefined ||
        !Number.isSafeInteger(number) ||
        number <= 0
    ) {
        return null;
    }
    return { number, repo: `${owner}/${name}` };
}

/**
 * Finds the one issue a message shares.
 *
 * Deliberately strict: a message naming two different issues is ambiguous and
 * returns `null` (the model must pass `issue` explicitly), and a message that
 * also links a pull request returns `null` (that is a follow-up, not an issue
 * implementation). Repeating the same issue URL is still one reference.
 *
 * @param prompt - The user's message for this turn.
 * @returns The single issue reference, or `null`.
 */
export function issueRefFromPrompt(prompt: string): IssueRef | null {
    if (PULL_URL_IN_TEXT.test(prompt)) {
        return null;
    }
    const refs = new Map<string, IssueRef>();
    for (const match of prompt.matchAll(ISSUE_URL_IN_TEXT)) {
        const [, owner, name, rawNumber] = match;
        const number = Number(rawNumber);
        if (
            owner === undefined ||
            name === undefined ||
            !Number.isSafeInteger(number) ||
            number <= 0
        ) {
            continue;
        }
        const repo = `${owner}/${name}`;
        refs.set(`${repo}#${number}`, { number, repo });
    }
    if (refs.size !== 1) {
        return null;
    }
    return refs.values().next().value ?? null;
}
