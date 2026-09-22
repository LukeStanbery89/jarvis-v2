import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createApp, createHttpsRedirectApp } from "../src/app";
import { SqliteAppStore } from "../src/auth";

const store = new SqliteAppStore(new Database(":memory:"));

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
