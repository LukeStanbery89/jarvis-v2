/**
 * Safe Markdown renderer for assistant replies.
 *
 * GFM (tables, strikethrough, task lists) via `remark-gfm`; raw HTML is
 * skipped by react-markdown's default transform — the client deliberately
 * does *not* claim the `html` capability. Links run through `safeHref`
 * (protocol allowlist) and open in a new tab only when external; images
 * render lazily and never send a referrer. react-markdown's
 * `defaultUrlTransform` already strips `javascript:`/`data:` URI schemes
 * before components run; this layer is defense in depth (and covers the
 * stripped-to-empty case).
 *
 * Custom components destructure only the props they need (rather than
 * spreading) so react-markdown's internal `node` prop never leaks into the
 * DOM.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeHref } from "./safeHref";

/** Component overrides applied to every rendered assistant reply. */
const components: Components = {
    a({ children, href }) {
        const link = href ? safeHref(href, window.location.href) : null;
        if (!link) {
            return <span>{children}</span>;
        }
        return link.external ? (
            <a href={link.href} target="_blank" rel="noopener noreferrer">
                {children}
            </a>
        ) : (
            <a href={link.href}>{children}</a>
        );
    },
    img({ src, alt, title }) {
        return typeof src === "string" ? (
            <img
                src={src}
                alt={alt ?? ""}
                title={title}
                loading="lazy"
                referrerPolicy="no-referrer"
            />
        ) : null;
    },
};

/**
 * Renders assistant markdown (GFM subset, no raw HTML) with hardened links
 * and images. Re-renders as streaming chunks grow the `text`.
 */
export function Markdown({ text }: { text: string }) {
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {text}
        </ReactMarkdown>
    );
}
