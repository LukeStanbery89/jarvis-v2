/**
 * Link-protocol allowlist for model-generated markdown.
 *
 * The agent's output is untrusted input: `href` values are checked against a
 * protocol allowlist before rendering, so a model (or a prompt injection)
 * cannot emit `javascript:`/`data:` URLs the browser would execute. Returns
 * `null` for anything disallowed (or empty/unparseable) — callers then render
 * the link text as plain text instead of a link.
 *
 * react-markdown's `defaultUrlTransform` already strips dangerous URL schemes
 * before components run; this layer is defense in depth and also covers the
 * stripped-to-empty case.
 */

/** Protocols a rendered link may point at. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** A vetted link target: safe to render, plus how it should open. */
export interface SafeLink {
    /** The resolved, absolute URL. */
    href: string;
    /** True for http(s) links — the ones that open in a new tab. */
    external: boolean;
}

/**
 * Vets one URL for rendering.
 *
 * Relative URLs resolve against `base` (the page origin in the browser, an
 * explicit base in node tests). Returns `null` when the URL is empty, cannot
 * parse, or names a protocol outside the allowlist.
 */
export function safeHref(url: string, base?: string): SafeLink | null {
    if (url.trim() === "") {
        return null;
    }
    try {
        const parsed = new URL(url, base);
        if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
            return null;
        }
        return {
            href: parsed.href,
            external: parsed.protocol !== "mailto:",
        };
    } catch {
        return null;
    }
}
