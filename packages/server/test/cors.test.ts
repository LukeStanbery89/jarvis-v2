import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createCorsMiddleware } from "../src/http/cors";
import { createInMemoryAppDatabase } from "@lukestanbery/jarvis-auth/testing";
import type { AppConfig } from "../src/config";

/** Minimal config; CORS/trust-proxy fields are what these tests vary. */
const BASE: AppConfig = {
    appDbPath: ":memory:",
    turnTimeoutMs: 30_000,
    bootstrapToken: "s3cret-bootstrap",
};

/** CORS decision independent of the store, so no bootstrap is needed. */
const corsApp = (corsOrigins?: string[]) =>
    createApp(createInMemoryAppDatabase(), {
        ...BASE,
        corsOrigins,
    });

const DESK = "https://desk.example.com";

describe("CORS allowlist (#63)", () => {
    it("emits no CORS headers for a same-origin request", async () => {
        const res = await request(corsApp([DESK])).get("/health");
        expect(res.status).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows a configured origin, echoing it rather than a wildcard", async () => {
        const res = await request(corsApp([DESK]))
            .get("/health")
            .set("Origin", DESK);
        expect(res.headers["access-control-allow-origin"]).toBe(DESK);
        expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("denies an unconfigured origin", async () => {
        const res = await request(corsApp([DESK]))
            .get("/health")
            .set("Origin", "https://evil.example.com");
        // No header (rather than a 4xx): the browser blocks it, and the refusal
        // does not confirm whether the allowlist exists.
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        expect(res.status).toBe(200);
    });

    it("matches a configured trailing slash and mixed case", async () => {
        const res = await request(corsApp(["https://Desk.Example.com/"]))
            .get("/health")
            .set("Origin", DESK);
        expect(res.headers["access-control-allow-origin"]).toBe(DESK);
    });

    it("denies a substring/prefix of an allowed origin", async () => {
        for (const origin of [
            "https://desk.example.com.evil.test",
            "https://desk.example.co",
        ]) {
            const res = await request(corsApp([DESK]))
                .get("/health")
                .set("Origin", origin);
            expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        }
    });

    it("denies every cross-origin request when no origins are configured", async () => {
        for (const origins of [undefined, [], ["*"]]) {
            const res = await request(corsApp(origins))
                .get("/health")
                .set("Origin", DESK);
            expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        }
    });

    it("never echoes a literal wildcard, even when configured", async () => {
        // Guards the naive "if configured with *, set ACAO: *" implementation:
        // a credentialed API must never hand out a wildcard origin.
        const res = await request(corsApp(["*"]))
            .get("/health")
            .set("Origin", DESK);
        expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    });

    it("varies on Origin whether or not the origin is allowed", async () => {
        const denied = await request(corsApp([DESK]))
            .get("/health")
            .set("Origin", "https://evil.example.com");
        expect(denied.headers["vary"]).toMatch(/Origin/i);
    });

    it("leaves an existing Vary header intact", () => {
        // Express sets its own Vary on some responses; appending must not clobber it.
        const seen: string[] = [];
        const res = {
            getHeader: (name: string) =>
                name === "Vary" ? "Accept-Encoding" : undefined,
            setHeader: (name: string, value: string) => {
                if (name === "Vary") seen.push(value);
            },
        };
        createCorsMiddleware([DESK])(
            { method: "GET", headers: { origin: DESK } } as never,
            res as never,
            () => {},
        );
        expect(seen).toEqual(["Accept-Encoding, Origin"]);
    });
});

describe("CORS preflight (#63)", () => {
    it("answers OPTIONS on a POST-only API path before the contract validator", async () => {
        // The decisive ordering test: /api/auth/login declares POST only, so the
        // OpenAPI validator would reject a bare OPTIONS reaching it.
        const res = await request(corsApp([DESK]))
            .options("/api/auth/login")
            .set("Origin", DESK)
            .set("Access-Control-Request-Method", "POST")
            .set(
                "Access-Control-Request-Headers",
                "authorization,content-type",
            );
        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(DESK);
        expect(res.headers["access-control-allow-methods"]).toContain("POST");
        expect(res.headers["access-control-allow-headers"]).toContain(
            "authorization",
        );
        expect(res.headers["access-control-max-age"]).toBeDefined();
    });

    it("defaults Allow-Headers when the browser sends none", async () => {
        const res = await request(corsApp([DESK]))
            .options("/api/auth/login")
            .set("Origin", DESK);
        expect(res.headers["access-control-allow-headers"]).toContain(
            "Authorization",
        );
    });

    it("does not answer a preflight from a disallowed origin", async () => {
        const res = await request(corsApp([DESK]))
            .options("/api/auth/login")
            .set("Origin", "https://evil.example.com")
            .set("Access-Control-Request-Method", "POST");
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        expect(res.status).not.toBe(204);
    });
});

describe("trusted proxies and per-IP throttling (#63)", () => {
    const proxyCfg = (trustProxyCidrs: string[]): AppConfig => ({
        ...BASE,
        // Bootstrap is keyed purely on IP and rejects a wrong token without
        // hashing, so this exercises the throttle with no scrypt cost.
        loginRateLimit: {
            windowMs: 60_000,
            maxFailures: 1,
            lockoutMs: 60_000,
            // Bootstrap is keyed purely by IP, so its budget is the ip-kind
            // one (#66) — single-attempt per client is what these tests walk.
            maxIpFailures: 1,
        },
        trustProxyCidrs,
    });

    afterEach(() => {
        // no shared state; each test builds its own store
    });

    it("gives each proxied client its own budget", async () => {
        const store = createInMemoryAppDatabase();
        const app = createApp(store, proxyCfg(["127.0.0.0/8", "::1/128"]));

        const guess = (forwardedFor: string) =>
            request(app)
                .post("/api/bootstrap")
                .set("x-bootstrap-token", "wrong")
                .set("X-Forwarded-For", forwardedFor)
                .send({ username: "guesser", password: "hunter2pw" });

        // First client exhausts its single-attempt budget.
        expect((await guess("203.0.113.9")).status).toBe(403);
        expect((await guess("203.0.113.9")).status).toBe(429);
        // A different client behind the same proxy must not be locked out.
        expect((await guess("198.51.100.4")).status).toBe(403);
        expect((await guess("198.51.100.4")).status).toBe(429);
        store.close();
    });

    it("ignores X-Forwarded-For when no proxy is trusted", async () => {
        const store = createInMemoryAppDatabase();
        const app = createApp(store, proxyCfg([]));

        const guess = (forwardedFor: string) =>
            request(app)
                .post("/api/bootstrap")
                .set("x-bootstrap-token", "wrong")
                .set("X-Forwarded-For", forwardedFor)
                .send({ username: "guesser", password: "hunter2pw" });

        // Without trust proxy both requests are the same socket address, so the
        // second is throttled — the pre-#63 collapse this fix exists to undo.
        expect((await guess("203.0.113.9")).status).toBe(403);
        expect((await guess("198.51.100.4")).status).toBe(429);
        store.close();
    });

    it("ignores X-Forwarded-For from an untrusted peer", async () => {
        const store = createInMemoryAppDatabase();
        // supertest connects over 127.0.0.1, so a subnet that excludes it must
        // leave the header untrusted (fails closed on a typo'd config).
        const app = createApp(store, proxyCfg(["203.0.113.0/24"]));

        const guess = (forwardedFor: string) =>
            request(app)
                .post("/api/bootstrap")
                .set("x-bootstrap-token", "wrong")
                .set("X-Forwarded-For", forwardedFor)
                .send({ username: "guesser", password: "hunter2pw" });

        expect((await guess("203.0.113.9")).status).toBe(403);
        expect((await guess("198.51.100.4")).status).toBe(429);
        store.close();
    });
});
