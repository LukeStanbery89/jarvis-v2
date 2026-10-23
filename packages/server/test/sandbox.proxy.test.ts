/**
 * The sandbox credential broker (#141 phase 7).
 *
 * These tests use a real HTTP listener on loopback rather than a mocked
 * `fetch`: the broker's job is to be a well-behaved hop — it must forward the
 * real key, refuse everything else, and stream the upstream's answer back
 * unchanged. A mock would exercise none of that.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    createSandboxProxy,
    deriveJobToken,
    loadProxySecret,
    verifyJobToken,
    type SandboxProxy,
} from "../src/sandbox/proxy";

const SECRET = "test-secret-that-is-long-enough-1234";
const MODEL = "big-pickle";
const FALLBACK_MODEL = "deepseek-v4.1-flash";

/** One request the fake upstream received. */
interface Hit {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
    body: string;
}

/** Everything a test must shut down. */
interface Fixture {
    proxy: SandboxProxy;
    proxyUrl: string;
    hits: Hit[];
    close(): Promise<void>;
}

/** Starts a fake OpenAI-compatible upstream on an ephemeral port. */
async function fakeUpstream(
    handler?: (
        hit: Hit,
        res: import("node:http").ServerResponse,
    ) => boolean | void,
): Promise<{
    server: Server;
    url: string;
    hits: Hit[];
    close(): Promise<void>;
}> {
    const hits: Hit[] = [];
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const hit: Hit = {
            method: req.method ?? "",
            path: req.url ?? "",
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf8"),
        };
        hits.push(hit);
        if (handler?.(hit, res) === true) {
            return;
        }
        const body = JSON.stringify({ id: "completion-1", choices: [] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    const port =
        typeof address === "object" && address !== null ? address.port : 0;
    return {
        server,
        // A path prefix, like the real provider (`/inference/openai/v1`): the
        // broker must append to it, not replace it with the request path.
        url: `http://127.0.0.1:${port}/inference/openai/v1`,
        hits,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/** Builds a broker over a fake upstream and tracks it for cleanup. */
async function makeProxy(
    overrides: {
        maxRequestsPerJob?: number;
        isJobActive?: (jobId: string) => boolean;
        apiKey?: string;
        upstreamClose?: () => Promise<void>;
        upstream?: Awaited<ReturnType<typeof fakeUpstream>>;
    } = {},
): Promise<Fixture> {
    const upstream = overrides.upstream ?? (await fakeUpstream());
    const proxy = createSandboxProxy({
        bind: "127.0.0.1",
        port: 0,
        url: "http://job.test:54322/v1",
        secret: SECRET,
        upstreamBaseUrl: upstream.url,
        models: [MODEL, FALLBACK_MODEL],
        apiKey: overrides.apiKey ?? "sk-real-upstream",
        maxRequestsPerJob: overrides.maxRequestsPerJob ?? 100,
        isJobActive: overrides.isJobActive ?? (() => true),
    });
    const port = await proxy.start();
    active.push({ proxy, upstream: overrides.upstream ? null : upstream });
    return {
        proxy,
        proxyUrl: `http://127.0.0.1:${port}/v1`,
        hits: upstream.hits,
        close: async () => {
            await proxy.close();
            if (!overrides.upstream) {
                await upstream.close();
            }
        },
    };
}

/** Fixtures created by the current test, closed even when it throws. */
const active: Array<{
    proxy: SandboxProxy;
    upstream: Awaited<ReturnType<typeof fakeUpstream>> | null;
}> = [];

afterEach(async () => {
    const pending = active.splice(0);
    for (const entry of pending) {
        await entry.proxy.close().catch(() => {});
        await entry.upstream?.close().catch(() => {});
    }
});

/** A chat-completions body for the configured model. */
function chatBody(model = MODEL): string {
    return JSON.stringify({
        model,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
    });
}

/** Posts one authorized chat request to the broker. */
function chat(
    fixture: Fixture,
    token: string,
    body = chatBody(),
): Promise<Response> {
    return fetch(`${fixture.proxyUrl}/chat/completions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-opencode-session": "ses_test",
            "user-agent": "opencode/2.0.32",
        },
        body,
    });
}

describe("job tokens", () => {
    it("round-trips a job id and rejects a forgery", () => {
        const token = deriveJobToken(SECRET, "job-1");
        expect(verifyJobToken(SECRET, token)).toBe("job-1");
        expect(
            verifyJobToken("another-secret-that-is-long-enough", token),
        ).toBe(null);

        const [prefix, jobId, signature] = token.split(".");
        expect(
            verifyJobToken(SECRET, `${prefix}.${jobId}x.${signature}`),
        ).toBeNull();
        expect(
            verifyJobToken(SECRET, `${prefix}.${jobId}.${signature}x`),
        ).toBeNull();
        expect(
            verifyJobToken(SECRET, `${prefix}.job 1.${signature}`),
        ).toBeNull();
        expect(verifyJobToken(SECRET, "bearer-ish")).toBeNull();
    });

    it("gives different jobs different tokens", () => {
        expect(deriveJobToken(SECRET, "job-1")).not.toBe(
            deriveJobToken(SECRET, "job-2"),
        );
    });
});

describe("the proxy secret", () => {
    it("creates a private file on first boot and reuses it", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-proxy-secret-"));
        try {
            const file = path.join(dir, "sandbox-proxy.key");
            const first = loadProxySecret("", file);
            expect(first.length).toBeGreaterThanOrEqual(32);
            expect(statSync(file).mode & 0o777).toBe(0o600);
            expect(loadProxySecret("", file)).toBe(first);
            expect(readFileSync(file, "utf8").trim()).toBe(first);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("prefers a configured secret and refuses a short one", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jarvis-proxy-secret-"));
        try {
            const file = path.join(dir, "sandbox-proxy.key");
            writeFileSync(file, "stored-secret-that-is-long-enough-123\n");
            expect(
                loadProxySecret("configured-secret-that-is-long-1234", file),
            ).toBe("configured-secret-that-is-long-1234");
            expect(() => loadProxySecret("short", file)).toThrow(
                /32 characters/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the broker", () => {
    it("forwards the real key, never the job token", async () => {
        const fixture = await makeProxy();
        const token = deriveJobToken(SECRET, "job-1");

        const response = await chat(fixture, token);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: "completion-1" });
        const hit = fixture.hits[0];
        expect(hit?.path).toBe("/inference/openai/v1/chat/completions");
        expect(hit?.headers.authorization).toBe("Bearer sk-real-upstream");
        expect(hit?.headers["x-opencode-session"]).toBe("ses_test");
        expect(hit?.headers["user-agent"]).toBe("opencode/2.0.32");
        expect(hit?.body).toBe(chatBody());
    });

    it("refuses a missing, forged or retired token", async () => {
        const retired = new Set(["job-old"]);
        const fixture = await makeProxy({
            isJobActive: (jobId) => !retired.has(jobId),
        });

        expect((await chat(fixture, "")).status).toBe(401);
        expect((await chat(fixture, "jv1.job-1.nope")).status).toBe(401);
        expect(
            (await chat(fixture, deriveJobToken(SECRET, "job-old"))).status,
        ).toBe(401);
        expect(fixture.hits).toHaveLength(0);
    });

    it("refuses a model the job was not given", async () => {
        const fixture = await makeProxy();
        const response = await chat(
            fixture,
            deriveJobToken(SECRET, "job-1"),
            chatBody("gpt-expensive"),
        );

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
            error: { message: expect.stringContaining(MODEL) },
        });
        expect(fixture.hits).toHaveLength(0);
    });

    it("accepts every rung of the model ladder", async () => {
        const fixture = await makeProxy();
        const response = await chat(
            fixture,
            deriveJobToken(SECRET, "job-1"),
            chatBody(FALLBACK_MODEL),
        );

        expect(response.status).toBe(200);
        expect(fixture.hits).toHaveLength(1);
    });

    it("serves only its two routes", async () => {
        const fixture = await makeProxy();
        const token = deriveJobToken(SECRET, "job-1");

        expect((await fetch(`${fixture.proxyUrl}/admin`)).status).toBe(404);
        expect(
            (
                await fetch(`${fixture.proxyUrl}/chat/completions`, {
                    method: "GET",
                    headers: { authorization: `Bearer ${token}` },
                })
            ).status,
        ).toBe(405);
    });

    it("forwards the model list with the same token", async () => {
        const fixture = await makeProxy();

        const response = await fetch(`${fixture.proxyUrl}/models`, {
            headers: {
                authorization: `Bearer ${deriveJobToken(SECRET, "job-1")}`,
            },
        });

        expect(response.status).toBe(200);
        expect(fixture.hits[0]?.path).toBe("/inference/openai/v1/models");
        expect(fixture.hits[0]?.headers.authorization).toBe(
            "Bearer sk-real-upstream",
        );
    });

    it("stops a job at its request budget", async () => {
        const fixture = await makeProxy({ maxRequestsPerJob: 1 });
        const token = deriveJobToken(SECRET, "job-1");

        expect((await chat(fixture, token)).status).toBe(200);
        const refused = await chat(fixture, token);
        expect(refused.status).toBe(429);
        expect(await refused.json()).toMatchObject({
            error: { type: "insufficient_quota" },
        });
        expect(fixture.hits).toHaveLength(1);
    });

    it("answers 502 when the upstream is unreachable", async () => {
        const upstream = await fakeUpstream();
        const url = upstream.url;
        await upstream.close();
        const fixture = await makeProxy({ upstream: { ...upstream, url } });

        const response = await chat(fixture, deriveJobToken(SECRET, "job-1"));

        expect(response.status).toBe(502);
    });

    it("streams an upstream body through", async () => {
        const upstream = await fakeUpstream((_hit, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
            res.end("data: [DONE]\n\n");
            return true;
        });
        const fixture = await makeProxy({ upstream });

        const response = await chat(fixture, deriveJobToken(SECRET, "job-1"));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
            "text/event-stream",
        );
        expect(await response.text()).toContain("data: [DONE]");
    });
});
