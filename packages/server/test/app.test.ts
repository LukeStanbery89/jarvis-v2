import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, createHttpsRedirectApp } from "../src/app";
import { SqliteAppDatabase } from "@lukestanbery/jarvis-auth";

const store = new SqliteAppDatabase(new Database(":memory:"));

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
        expect(res.headers["content-security-policy"]).toContain(
            "default-src 'self'",
        );
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("keeps /api routed to the REST router, not the shell", async () => {
        const res = await request(portalApp).get("/api/users");
        expect(res.status).toBe(401);
        expect(res.body.error).toBeTruthy();
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
