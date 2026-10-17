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

describe("wake model route (#84 P4)", () => {
    it("answers a JSON 404 when wake model serving is unconfigured", async () => {
        const app = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
        });
        const res = await request(app).get(
            "/api/wake/model/melspectrogram.onnx",
        );
        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.body).toMatchObject({
            error: expect.stringContaining("JARVIS_WAKE_PROVIDER"),
        });
    });

    it("serves the configured route past the contract validator (HEAD, no download)", async () => {
        const modelDir = mkdtempSync(path.join(tmpdir(), "jarvis-wake-app-"));
        try {
            const app = createApp(store, {
                appDbPath: ":memory:",
                turnTimeoutMs: 30_000,
                bootstrapToken: undefined,
                wake: { baseUrl: "https://example.invalid/wake", modelDir },
            });
            // HEAD answers from configuration alone — proof the route is
            // mounted and declared in the OpenAPI spec (an undeclared path
            // would be rejected by the contract validator first).
            const probe = await request(app).head(
                "/api/wake/model/hey_jarvis_v0.1.onnx",
            );
            expect(probe.status).toBe(200);
            // The allowlist is enforced inside the route, not by the shape
            // layer, so an unknown file is the route's own JSON 404.
            const unknown = await request(app).get("/api/wake/model/evil.onnx");
            expect(unknown.status).toBe(404);
            expect(unknown.body).toEqual({
                error: "unknown wake model file",
            });
        } finally {
            rmSync(modelDir, { recursive: true, force: true });
        }
    });
});

describe("admin portal serving (/admin)", () => {
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

    it("serves the SPA shell at /admin/", async () => {
        const res = await request(portalApp).get("/admin/");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Portal");
    });

    it("serves static assets from the portal dir under /admin", async () => {
        const res = await request(portalApp).get("/admin/assets/app.js");
        expect(res.status).toBe(200);
        expect(res.text).toBe("console.log('portal')");
    });

    it("falls back to the shell for client-side routes", async () => {
        const res = await request(portalApp).get("/admin/users/42");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Portal");
    });

    it("hardens the portal with the strict CSP headers", async () => {
        const res = await request(portalApp).get("/admin/");
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

    it("leaves / a greeting when the app itself is not built", async () => {
        // The portal is a destination now, not the front door: with no web
        // build, the root answers the historical greeting rather than the
        // portal's shell at the wrong address.
        const res = await request(portalApp).get("/");
        expect(res.status).toBe(200);
        expect(res.text).toBe("Hello World");
    });
});

describe("web app serving (/)", () => {
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

    it("serves the app shell at /", async () => {
        const res = await request(webApp).get("/");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Web");
    });

    it("serves static assets from the web dir at the root", async () => {
        const res = await request(webApp).get("/assets/app.js");
        expect(res.status).toBe(200);
        expect(res.text).toBe("console.log('web')");
    });

    it("falls back to the app shell for client-side routes", async () => {
        const res = await request(webApp).get("/chat");
        expect(res.status).toBe(200);
        expect(res.text).toContain("JARVIS Web");
    });

    it("redirects the old /web address to /", async () => {
        // The client's former mount (#90 phase 6a). One redirect, no second
        // mount: a bookmark lands on the app rather than on a second copy.
        const bare = await request(webApp).get("/web");
        expect(bare.status).toBe(301);
        expect(bare.headers.location).toBe("/");
        const deep = await request(webApp).get("/web/chat");
        expect(deep.status).toBe(301);
        expect(deep.headers.location).toBe("/");
    });

    it("widens img-src, permits wasm compile, allows the same-origin ws socket, and declares the worker source for the app", async () => {
        const web = await request(webApp).get("/");
        // supertest defaults Host to 127.0.0.1:<port>; the CSP derives the
        // socket origins from it.
        expect(web.headers["content-security-policy"]).toMatch(
            /script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data: https:; connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:\/\/127\.0\.0\.1:\d+$/,
        );
    });

    it("drops the ws socket origins when the Host header is malformed", async () => {
        const res = await request(webApp)
            .get("/")
            .set("Host", "evil.test; script-src *");
        expect(res.headers["content-security-policy"]).toBe(
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data: https:; connect-src 'self'",
        );
    });

    it("serves the speech engine's worker script with its own eval-permitting CSP, overriding the page's strict policy", async () => {
        // The worker entry script declares a CSP of its own; for a dedicated
        // worker that policy governs the worker scope instead of the owner's,
        // so embind's runtime invoker synthesis (`new Function`) is legal
        // inside the hashed module while the page never allows eval.
        const worker = await request(webApp).get(
            "/assets/vosk.worker-AB12cd34.js",
        );
        expect(worker.headers["content-security-policy"]).toBe(
            "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'",
        );
        // Any other asset keeps the page's strict policy.
        const page = await request(webApp).get("/assets/index-OTHER123.js");
        expect(page.headers["content-security-policy"]).toMatch(
            /script-src 'self' 'wasm-unsafe-eval';/,
        );
        expect(page.headers["content-security-policy"]).not.toContain(
            "'unsafe-eval';",
        );
    });

    it("leaves /admin a 404 when the portal is not mounted (never the app shell)", async () => {
        // The app's fallback skips /admin on purpose: an unbuilt (or disabled)
        // admin surface must be an honest 404 rather than the app wearing the
        // admin address.
        const res = await request(webApp).get("/admin/users/42");
        expect(res.status).toBe(404);
        const bare = await request(webApp).get("/admin");
        expect(bare.status).toBe(404);
    });
});

describe("both surfaces mounted", () => {
    let portalDir: string;
    let webDir: string;

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
    });

    afterAll(() => {
        rmSync(portalDir, { recursive: true, force: true });
        rmSync(webDir, { recursive: true, force: true });
    });

    it("gives each surface its own assets, and neither the other's shell", async () => {
        const both = createApp(store, {
            appDbPath: ":memory:",
            turnTimeoutMs: 30_000,
            bootstrapToken: undefined,
            portalDir,
            webDir,
        });

        const root = await request(both).get("/");
        expect(root.text).toContain("JARVIS Web");
        const admin = await request(both).get("/admin/");
        expect(admin.text).toContain("JARVIS Portal");

        // The two `assets/` directories are different mounts serving different
        // builds: a mix-up would be invisible until an asset 404'd.
        expect((await request(both).get("/assets/app.js")).text).toBe(
            "console.log('web')",
        );
        expect((await request(both).get("/admin/assets/app.js")).text).toBe(
            "console.log('portal')",
        );

        // An unmatched path belongs to the app (it is the front door), and the
        // old address still lands there.
        const unmatched = await request(both).get("/webfoo");
        expect(unmatched.text).toContain("JARVIS Web");
        const legacy = await request(both).get("/web/chat");
        expect(legacy.status).toBe(301);
        expect(legacy.headers.location).toBe("/");
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

    it("answers 400 on a malformed Host instead of throwing", async () => {
        // `new URL("http://[::1")` throws (unclosed IPv6 bracket); the
        // uncaught TypeError used to hit Express's default handler.
        const res = await request(createHttpsRedirectApp(54321))
            .get("/")
            .set("Host", "[::1");
        expect(res.status).toBe(400);
    });
});
