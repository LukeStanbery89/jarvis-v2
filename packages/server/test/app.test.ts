import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, createHttpsRedirectApp } from "../src/app";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";

const store = createInMemoryAppDatabase();

afterAll(() => {
    store.close();
});

describe("app", () => {
    it("returns 'Hello World' from GET /", async () => {
        const res = await request(
            createApp(store, {
                appDbPath: ":memory:",
                turnTimeoutMs: 30_000,
                bootstrapToken: undefined,
            }),
        ).get("/");
        expect(res.status).toBe(200);
        expect(res.text).toBe("Hello World");
    });

    it("reports machine health via GET /health regardless of portal", async () => {
        const res = await request(
            createApp(store, {
                appDbPath: ":memory:",
                turnTimeoutMs: 30_000,
                bootstrapToken: undefined,
            }),
        ).get("/health");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

describe("web portal serving", () => {
    let portalDir: string;
    let portalApp: ReturnType<typeof createApp>;

    beforeAll(() => {
        portalDir = mkdtempSync(path.join(tmpdir(), "jarvis-portal-"));
        mkdirSync(path.join(portalDir, "assets"), { recursive: true });
        writeFileSync(
            path.join(portalDir, "index.html"),
            "<!doctype html><title>JARVIS Portal</title>",
        );
        writeFileSync(
            path.join(portalDir, "assets", "app.js"),
            "console.log('portal')",
        );
        portalApp = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
            portalDir,
        });
    });

    afterAll(() => {
        rmSync(portalDir, { recursive: true, force: true });
    });

    it("serves the SPA shell at /", async () => {
        const res = await request(portalApp).get("/");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Portal");
    });

    it("serves static assets from the portal dir", async () => {
        const res = await request(portalApp).get("/assets/app.js");
        expect(res.status).toBe(200);
        expect(res.text).toBe("console.log('portal')");
    });

    it("falls back to the shell for client-side routes", async () => {
        const res = await request(portalApp).get("/users/42");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Portal");
    });

    it("hardens the portal with CSP headers", async () => {
        const res = await request(portalApp).get("/");
        expect(res.headers["content-security-policy"]).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        );
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("keeps /api routed to the REST router, not the shell", async () => {
        const res = await request(portalApp).get("/api/users");
        expect(res.status).toBe(401);
        expect(res.body.error).toBeTruthy();
    });
});

describe("web chat client serving", () => {
    let webDir: string;
    let webApp: ReturnType<typeof createApp>;

    beforeAll(() => {
        webDir = mkdtempSync(path.join(tmpdir(), "jarvis-web-"));
        mkdirSync(path.join(webDir, "assets"), { recursive: true });
        writeFileSync(
            path.join(webDir, "index.html"),
            "<!doctype html><title>JARVIS Web</title>",
        );
        writeFileSync(
            path.join(webDir, "assets", "app.js"),
            "console.log('web')",
        );
        webApp = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
            webDir,
        });
    });

    afterAll(() => {
        rmSync(webDir, { recursive: true, force: true });
    });

    it("serves the web SPA shell at /web (redirecting the bare /web first)", async () => {
        const redirected = await request(webApp).get("/web");
        expect(redirected.status).toBe(301);
        expect(redirected.headers.location).toBe("/web/");

        const res = await request(webApp).get("/web/");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Web");
    });

    it("serves static assets from the web dir", async () => {
        const res = await request(webApp).get("/web/assets/app.js");
        expect(res.status).toBe(200);
        expect(res.text).toBe("console.log('web')");
    });

    it("falls back to the web shell for client-side routes under /web", async () => {
        const res = await request(webApp).get("/web/chat");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Web");
    });

    it("widens img-src to https and allows the same-origin ws socket for the web chat client", async () => {
        const web = await request(webApp).get("/web/");
        // supertest defaults Host to 127.0.0.1:<port>; the CSP derives the
        // socket origins from it.
        expect(web.headers["content-security-policy"]).toMatch(
            /img-src 'self' data: https:; connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:\/\/127\.0\.0\.1:\d+$/,
        );
    });

    it("drops the ws socket origins when the Host header is malformed", async () => {
        const res = await request(webApp)
            .get("/web/")
            .set("Host", "evil.test; script-src *");
        expect(res.headers["content-security-policy"]).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'",
        );
    });

    it("leaves /web a 404 when the web client is not built (never the portal shell)", async () => {
        // A webDir configured but missing index.html leaves /web unmounted;
        // the portal fallback must NOT swallow it (404, not the portal shell).
        const emptyDir = mkdtempSync(path.join(tmpdir(), "jarvis-web-empty-"));
        const portalDir = mkdtempSync(path.join(tmpdir(), "jarvis-portal-"));
        writeFileSync(
            path.join(portalDir, "index.html"),
            "<!doctype html><title>JARVIS Portal</title>",
        );
        const app = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
            portalDir,
            webDir: emptyDir,
        });
        const res = await request(app).get("/web/chat");
        expect(res.status).toBe(404);

        const disabled = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
            portalDir,
            webDir: undefined,
        });
        const res2 = await request(disabled).get("/web/");
        expect(res2.status).toBe(404);

        rmSync(emptyDir, { recursive: true, force: true });
        rmSync(portalDir, { recursive: true, force: true });
    });

    it("does not let the /web skip swallow unrelated paths like /webfoo", async () => {
        const portalDir = mkdtempSync(path.join(tmpdir(), "jarvis-portal-"));
        writeFileSync(
            path.join(portalDir, "index.html"),
            "<!doctype html><title>JARVIS Portal</title>",
        );
        const both = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
            portalDir,
            webDir,
        });
        const res = await request(both).get("/webfoo");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Portal");
        rmSync(portalDir, { recursive: true, force: true });
    });

    it("keeps the portal's root fallback from capturing /web when both are mounted", async () => {
        const portalDir = mkdtempSync(path.join(tmpdir(), "jarvis-portal-"));
        mkdirSync(path.join(portalDir, "assets"), { recursive: true });
        writeFileSync(
            path.join(portalDir, "index.html"),
            "<!doctype html><title>JARVIS Portal</title>",
        );

        const both = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
            portalDir,
            webDir,
        });
        const webRoute = await request(both).get("/web/chat");
        expect(webRoute.text).toContain("JARVIS Web");
        const root = await request(both).get("/");
        expect(root.text).toContain("JARVIS Portal");

        rmSync(portalDir, { recursive: true, force: true });
    });
});

describe("https redirect app", () => {
    it("redirects every request to the https origin on the TLS port", async () => {
        const res = await request(createHttpsRedirectApp(54321))
            .get("/api/sessions/abc")
            .set("Host", "jarvis.lan");
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(
            "https://jarvis.lan:54321/api/sessions/abc",
        );
    });

    it("bounces the root path using the request Host header", async () => {
        const res = await request(createHttpsRedirectApp(443)).get("/");
        expect(res.status).toBe(302);
        // supertest sends Host: 127.0.0.1 by default; the redirect honors it.
        expect(res.headers.location).toBe("https://127.0.0.1:443/");
    });
});
