/**
 * Markdown-to-plain-text fallback for notification bodies.
 *
 * A notification body is model output and is stored once as Markdown: the web
 * list and toast render it, while the OS Notification API and the Web Push
 * service worker can only show text. This module is the shared plain-text
 * rendering those surfaces use, so the server's push payload and the page's
 * own popup cannot disagree about what the notification says.
 *
 * It is deliberately a small, dependency-free subset rather than a Markdown
 * parser. The notification body is short and bounded, and the fallback only
 * has to remove the syntax the OS would otherwise display literally: fences,
 * headings, blockquote/list markers, emphasis and link/image wrappers. Links
 * keep their label (falling back to the URL when the label is empty), because a
 * sentence reading "the story" is more useful in a one-line popup than a raw
 * URL; images keep their alt text.
 *
 * @param markdown - The stored notification body.
 * @returns Plain text suitable for `Notification`/`showNotification`; empty
 *   when the input had no readable text.
 */
export function plainText(markdown: string): string {
    let text = markdown.replace(/\r\n?/g, "\n");

    // Fenced code: drop the fence lines (and an info string), keeping the code
    // itself readable. The closing fence is optional for a truncated body.
    text = text.replace(/^[ \t]*```[^\n]*\n?/gm, "");

    // Images before links: the leading `!` would otherwise be left behind.
    text = text.replace(
        /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (_match, alt: string, url: string) =>
            alt.trim().length > 0 ? alt : url,
    );
    text = text.replace(
        /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (_match, label: string, url: string) =>
            label.trim().length > 0 ? label : url,
    );

    // Inline code and autolinks.
    text = text.replace(/`+([^`]+)`+/g, "$1");
    text = text.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, "$1");

    // Raw HTML is not rendered by the Markdown surface either; keep the text
    // between tags, drop the tags and comments.
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/?[a-z][^>]*>/gi, "");

    // The Markdown renderer turns entities back into characters; an OS card
    // must not show the source spelling.
    text = text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");

    // Block syntax at the start of a line.
    text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
    text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
    text = text.replace(
        /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\][ \t]+/gm,
        "$1",
    );
    text = text.replace(/^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/gm, "$1• ");
    text = text.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");

    // Emphasis markers. Single `*`/`_` are removed only at word boundaries so
    // an identifier such as `snake_case` survives.
    text = text.replace(/(\*\*\*|\*\*|___|__|~~)/g, "");
    text = text.replace(/(^|[^\w])\*(?=\S)/g, "$1");
    text = text.replace(/(\S)\*(?=[^\w]|$)/g, "$1");
    text = text.replace(/(^|[^\w])_(?=\S)/g, "$1");
    text = text.replace(/(\S)_(?=[^\w]|$)/g, "$1");

    // Backslash escapes kept by the Markdown parser.
    text = text.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1");

    // Collapse runs that would look like broken spacing in a one-line OS card,
    // while keeping paragraph/list line breaks.
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/ *\n */g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
}
