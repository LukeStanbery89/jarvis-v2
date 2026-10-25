/**
 * The installable app's static contract (#189).
 *
 * These checks are deliberately about the files the browser reads rather than
 * about a render: an installability failure is usually one missing manifest
 * field or one icon the manifest names but the build never copied, and neither
 * shows up in a component test. The service-worker assertions pin the surfaces
 * it must never cache — live data and the separate admin app — because a
 * cache-first answer for `/api` or `/admin` is the failure mode that looks
 * fine until the network is slow or the portal changes.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldRegisterServiceWorker } from "./pwa";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Reads a file from `packages/web/public`. */
function publicFile(name: string): string {
    return path.join(WEB_ROOT, "public", name);
}

/** Reads a PNG's intrinsic dimensions from its IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
    const bytes = readFileSync(file);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
    };
}

interface ManifestIcon {
    src: string;
    sizes: string;
    type: string;
    purpose?: string;
}

interface Manifest {
    id: string;
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: ManifestIcon[];
}

const manifest = JSON.parse(
    readFileSync(publicFile("manifest.webmanifest"), "utf8"),
) as Manifest;

describe("web app manifest", () => {
    it("is a standalone, root-scoped app", () => {
        expect(manifest.id).toBe("/");
        expect(manifest.name).toBe("J.A.R.V.I.S.");
        expect(manifest.short_name).toBe("JARVIS");
        expect(manifest.start_url).toBe("/");
        expect(manifest.scope).toBe("/");
        expect(manifest.display).toBe("standalone");
        expect(manifest.background_color).toBe("#000000");
        expect(manifest.theme_color).toBe("#000000");
    });

    it("names the 192/512 icons every install surface requires", () => {
        const sizes = manifest.icons.map((icon) => icon.sizes);
        expect(sizes).toContain("192x192");
        expect(sizes).toContain("512x512");
        expect(
            manifest.icons.some(
                (icon) =>
                    icon.sizes === "512x512" &&
                    icon.purpose?.split(/\s+/).includes("maskable"),
            ),
        ).toBe(true);
    });

    it("ships every icon it names, at the size it claims", () => {
        for (const icon of manifest.icons) {
            expect(icon.src.startsWith("/")).toBe(true);
            const file = path.join(WEB_ROOT, "public", icon.src.slice(1));
            expect(existsSync(file), `${icon.src} is missing`).toBe(true);
            if (icon.type === "image/png" && icon.sizes !== "any") {
                const [width, height] = icon.sizes.split("x").map(Number);
                expect(pngSize(file)).toEqual({ width, height });
            }
        }
        expect(pngSize(publicFile("icons/apple-touch-icon.png"))).toEqual({
            width: 180,
            height: 180,
        });
    });

    it("is linked from the document, with the iOS fallbacks", () => {
        const html = readFileSync(path.join(WEB_ROOT, "index.html"), "utf8");
        expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
        expect(html).toContain('rel="apple-touch-icon"');
        expect(html).toContain('name="theme-color"');
        expect(html).toContain('name="apple-mobile-web-app-capable"');
        expect(html).toContain('name="mobile-web-app-capable"');
    });
});

describe("service worker", () => {
    const source = readFileSync(publicFile("sw.js"), "utf8");

    it("carries a build placeholder the production build replaces", () => {
        expect(source).toContain('const VERSION = "__JARVIS_BUILD__";');
    });

    it("handles fetches but leaves live surfaces and the admin app alone", () => {
        expect(source).toContain('addEventListener("fetch"');
        expect(source).toContain("api(?:\\/|$)");
        expect(source).toContain("admin(?:\\/|$)");
        expect(source).toContain("health(?:\\/|$)");
        expect(source).toContain("ws(?:\\/|$)");
        expect(source).toContain("sw\\.js$");
    });

    it("precaches the shell and its icons", () => {
        expect(source).toContain('"/"');
        expect(source).toContain('"/manifest.webmanifest"');
        expect(source).toContain('"/icons/icon-192.png"');
        expect(source).toContain('"/icons/icon-512.png"');
    });
});

describe("service worker registration", () => {
    it("registers only in a supported, secure production page", () => {
        expect(
            shouldRegisterServiceWorker({
                production: true,
                supported: true,
                secure: true,
            }),
        ).toBe(true);
        expect(
            shouldRegisterServiceWorker({
                production: false,
                supported: true,
                secure: true,
            }),
        ).toBe(false);
        expect(
            shouldRegisterServiceWorker({
                production: true,
                supported: false,
                secure: true,
            }),
        ).toBe(false);
        expect(
            shouldRegisterServiceWorker({
                production: true,
                supported: true,
                secure: false,
            }),
        ).toBe(false);
    });
});
