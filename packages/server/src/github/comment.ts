/**
 * A reply target on a pull request (#140).
 *
 * GitHub has two kinds of comment on a PR, and they take two different reply
 * calls: an inline **review** comment threads through
 * `pulls/{n}/comments/{id}/replies`, while a **conversation** comment is a new
 * issue comment (quoted, so the thread still reads). The relay model is given
 * each comment's `reply-to` URL and hands it back; this module turns that URL
 * into the kind and id the host needs, so neither the model nor the publisher
 * has to guess from the shape of an id.
 */

/** Which endpoint a reply belongs on. */
export type CommentKind = "review" | "issue";

/** One comment a job may answer. */
export interface CommentRef {
    readonly kind: CommentKind;
    /** GitHub's database id for the comment. */
    readonly id: number;
    /** The browser URL the caller gave, when it gave one. */
    readonly url: string | null;
}

/** `#discussion_r<id>` — an inline review note. */
const REVIEW_FRAGMENT = /(?:^|#)discussion_r(\d+)(?:\b|$)/;

/** `#issuecomment-<id>` — a conversation comment. */
const ISSUE_FRAGMENT = /(?:^|#)issuecomment-(\d+)(?:\b|$)/;

/**
 * Reads a comment id after a fragment marker.
 *
 * @param value - The URL or fragment the model passed.
 * @param marker - The marker and its capture group.
 * @returns The id, or `null`.
 */
function idAfter(value: string, marker: RegExp): number | null {
    const match = marker.exec(value);
    if (match === null) {
        return null;
    }
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Parses the `reply-to` value a PR read prints.
 *
 * A full URL is expected (`…/pull/165#discussion_r4333015888` or
 * `…/pull/165#issuecomment-987`), because that is what the tool renders and
 * what the model can copy. The bare fragment is accepted too, for a caller
 * that trimmed the URL.
 *
 * @param value - The model's argument.
 * @returns The comment reference, or `null` when it names neither kind.
 */
export function parseCommentRef(value: string): CommentRef | null {
    const trimmed = value.trim();
    const review = idAfter(trimmed, REVIEW_FRAGMENT);
    if (review !== null) {
        return {
            kind: "review",
            id: review,
            url: /^https?:\/\//i.test(trimmed) ? trimmed : null,
        };
    }
    const issue = idAfter(trimmed, ISSUE_FRAGMENT);
    if (issue !== null) {
        return {
            kind: "issue",
            id: issue,
            url: /^https?:\/\//i.test(trimmed) ? trimmed : null,
        };
    }
    return null;
}

/**
 * Quotes a comment for a conversation reply.
 *
 * Inline replies thread on their own; a top-level comment has no thread, so
 * the quote is what keeps the answer attached to the thing it answers.
 *
 * @param original - The comment being answered.
 * @param reply - The job's summary.
 * @returns The reply body, quoted.
 */
export function quotedReply(original: string, reply: string): string {
    const quote = original
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    return `${quote}\n\n${reply}`;
}
