/**
 * The broker sidecar's own wiring (#141).
 *
 * The broker and the egress proxy have their own suites; what is tested here
 * is the seam that makes them a sidecar: the environment it reads and the
 * job-state check that replaces the in-process ledger. The check is the
 * security-relevant piece — it must present the job's own token, cache
 * briefly, and fail closed on anything it cannot verify.
 */
import { describe, expect, it, vi } from "vitest";
import {
    createJobStateCheck,
    readProxyServerConfig,
} from "../src/sandbox/proxyServer";

const SECRET = "s".repeat(32);

describe("readProxyServerConfig", () => {
    it("fills the documented defaults", () => {
        const config = readProxyServerConfig({
            JARVIS_PROXY_SECRET: SECRET,
        });

        expect(config).toMatchObject({
            bind: "0.0.0.0",
            port: 54322,
            egressPort: 54323,
            egressPolicy: "public",
            egressHosts: [],
            upstreamBaseUrl: "https://opencode.ai/inference/openai/v1",
            model: "big-pickle",
            apiKey: "",
            secret: SECRET,
            statusUrl: "http://host.docker.internal:54321",
            maxRequestsPerJob: 500,
        });
    });

    it("reads an allowlist policy and its hosts", () => {
        const config = readProxyServerConfig({
            JARVIS_PROXY_SECRET: SECRET,
            JARVIS_PROXY_EGRESS_POLICY: "allowlist",
            JARVIS_PROXY_EGRESS_HOSTS: "registry.npmjs.org, .github.com",
            JARVIS_PROXY_EGRESS_PORT: "6000",
            JARVIS_PROXY_STATUS_URL: "http://jarvis:54321/",
        });

        expect(config.egressPolicy).toBe("allowlist");
        expect(config.egressHosts).toEqual([
            "registry.npmjs.org",
            ".github.com",
        ]);
        expect(config.egressPort).toBe(6000);
        expect(config.statusUrl).toBe("http://jarvis:54321/");
    });

    it("has no secret when neither the environment nor the file supplies one", () => {
        const config = readProxyServerConfig({
            JARVIS_PROXY_SECRET: "",
            JARVIS_PROXY_SECRET_PATH: "/nonexistent/jarvis-proxy.key",
        });

        // The entrypoint refuses to start rather than generating a second
        // secret the server would never have signed tokens with.
        expect(config.secret).toBeNull();
    });
});

describe("createJobStateCheck", () => {
    it("presents the job's token, caches the answer and refreshes it", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        let now = 1_000;
        const check = createJobStateCheck("http://jarvis:54321/", {
            fetch: vi.fn(async (url: string, init: RequestInit) => {
                calls.push({ url, init });
                return new Response(JSON.stringify({ active: true }), {
                    status: 200,
                });
            }) as unknown as typeof fetch,
            now: () => now,
            ttlMs: 1_000,
        });

        expect(await check("job-1", "jv1.job-1.hmac")).toBe(true);
        now = 1_500;
        expect(await check("job-1", "jv1.job-1.hmac")).toBe(true);
        expect(calls).toHaveLength(1);
        const first = calls[0];
        expect(first?.url).toBe("http://jarvis:54321/internal/job-state");
        expect(
            (first?.init.headers as Record<string, string>).authorization,
        ).toBe("Bearer jv1.job-1.hmac");

        now = 2_500;
        await check("job-1", "jv1.job-1.hmac");
        expect(calls).toHaveLength(2);
    });

    it("fails closed on a non-2xx", async () => {
        const check = createJobStateCheck("http://jarvis:54321", {
            fetch: vi.fn(
                async () => new Response("nope", { status: 500 }),
            ) as unknown as typeof fetch,
        });

        expect(await check("job-1", "token")).toBe(false);
    });

    it("fails closed when the server cannot be reached", async () => {
        const check = createJobStateCheck("http://jarvis:54321", {
            fetch: vi.fn(async () => {
                throw new Error("ECONNREFUSED");
            }) as unknown as typeof fetch,
        });

        expect(await check("job-1", "token")).toBe(false);
    });

    it("does not cache a failure", async () => {
        let calls = 0;
        const check = createJobStateCheck("http://jarvis:54321", {
            fetch: vi.fn(async () => {
                calls += 1;
                return calls === 1
                    ? new Response("nope", { status: 500 })
                    : new Response(JSON.stringify({ active: true }), {
                          status: 200,
                      });
            }) as unknown as typeof fetch,
            ttlMs: 60_000,
        });

        expect(await check("job-1", "token")).toBe(false);
        expect(await check("job-1", "token")).toBe(true);
        expect(calls).toBe(2);
    });
});
