/**
 * Unit tests for the link-protocol allowlist: which URLs survive rendering,
 * external-vs-mailto handling, and the always-reject cases.
 */
import { describe, expect, it } from "vitest";
import { safeHref } from "./safeHref";

const PAGE = "https://jarvis.example/web/";

describe("safeHref", () => {
    it("allows http(s) and marks them external", () => {
        expect(safeHref("https://example.com/a?b=1", PAGE)).toEqual({
            href: "https://example.com/a?b=1",
            external: true,
        });
        expect(safeHref("http://example.com/", PAGE)).toMatchObject({
            external: true,
        });
    });

    it("allows mailto: without new-tab semantics", () => {
        expect(safeHref("mailto:a@b.c", PAGE)).toEqual({
            href: "mailto:a@b.c",
            external: false,
        });
    });

    it("resolves relative links against the page base", () => {
        expect(safeHref("docs/page.html", PAGE)).toEqual({
            href: "https://jarvis.example/web/docs/page.html",
            external: true,
        });
    });

    it("rejects executable and exotic schemes", () => {
        expect(safeHref("javascript:alert(1)", PAGE)).toBeNull();
        expect(safeHref("data:text/html;base64,AAAA", PAGE)).toBeNull();
        expect(safeHref("file:///etc/passwd", PAGE)).toBeNull();
        expect(safeHref("vbscript:x", PAGE)).toBeNull();
    });

    it("rejects empty and unparseable input", () => {
        expect(safeHref("", PAGE)).toBeNull();
        expect(safeHref("   ", PAGE)).toBeNull();
    });

    it("accepts scheme-less host-relative URLs against the base", () => {
        expect(safeHref("/api/health", PAGE)).toEqual({
            href: "https://jarvis.example/api/health",
            external: true,
        });
    });
});
