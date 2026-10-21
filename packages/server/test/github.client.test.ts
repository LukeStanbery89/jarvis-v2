/**
 * The GitHub App client (#140).
 *
 * The token exchange is exercised with a real RSA key: the JWT's signature is
 * verified against the public half, which is the property that matters — GitHub
 * accepts the assertion only if the App key signed it. The REST calls are a
 * fake fetch, because the shape being tested is what we send and what we do
 * with what comes back, not GitHub's availability.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GitHubConfig } from "../src/config";
import { createGitHubClient, signAppJwt } from "../src/github/client";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CONFIG: GitHubConfig = {
    appId: "12345",
    privateKey,
    installationId: "67890",
    apiBaseUrl: "https://api.github.test",
};

/** A JSON response. */
function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** The payload of the bearer JWT a request carried. */
function jwtPayload(authorization: string | undefined): {
    header: string;
    payload: Record<string, unknown>;
    signature: string;
} {
    const token = (authorization ?? "").replace(/^Bearer\s+/i, "");
    const [header, payload, signature] = token.split(".");
    if (
        header === undefined ||
        payload === undefined ||
        signature === undefined
    ) {
        throw new Error(`not a JWT: ${token.slice(0, 12)}…`);
    }
    return {
        header,
        payload: JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        ) as Record<string, unknown>,
        signature,
    };
}

describe("the App JWT", () => {
    it("is signed by the App key and carries iss/iat/exp", () => {
        const now = Date.UTC(2026, 9, 20, 12, 0, 0);
        const jwt = signAppJwt(CONFIG.appId, privateKey, now);
        const [header, payload, signature] = jwt.split(".");
        if (
            header === undefined ||
            payload === undefined ||
            signature === undefined
        ) {
            throw new Error("not a JWT");
        }

        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${header}.${payload}`);
        expect(
            verifier.verify(publicKey, Buffer.from(signature, "base64url")),
        ).toBe(true);

        const claims = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
        ) as { iat: number; exp: number; iss: unknown };
        // GitHub requires an integer issuer: a string is rejected with
        // "'Issuer' claim ('iss') must be an Integer".
        expect(claims.iss).toBe(12345);
        expect(claims.exp - claims.iat).toBe(600);
        // GitHub rejects an iat in the future; a minute in the past is safe.
        expect(claims.iat).toBeLessThanOrEqual(Math.floor(now / 1000));
    });
});

describe("the installation token", () => {
    it("exchanges a signed JWT once and caches the result", async () => {
        const fetchImpl = vi.fn(async () =>
            json({ token: "ghs_secret", expires_at: "2026-10-20T13:00:00Z" }),
        );
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        const first = await client.installationToken();
        const second = await client.installationToken();

        expect(first.token).toBe("ghs_secret");
        expect(second).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe(
            "https://api.github.test/app/installations/67890/access_tokens",
        );
        expect(init.method).toBe("POST");
        const authorization = (init.headers as Record<string, string>)
            .authorization;
        const jwt = jwtPayload(authorization);
        expect(jwt.payload.iss).toBe(12345);
        // The installation token is what the response carried, never the JWT.
        expect(jwt.signature.length).toBeGreaterThan(0);
    });

    it("refreshes a token that is about to expire", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                json({ token: "first", expires_at: "2026-10-20T12:03:00Z" }),
            )
            .mockResolvedValueOnce(
                json({ token: "second", expires_at: "2026-10-20T13:00:00Z" }),
            );
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        expect((await client.installationToken()).token).toBe("first");
        // Three minutes left is inside the five-minute refresh margin.
        expect((await client.installationToken()).token).toBe("second");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe("repository and pull request calls", () => {
    it("reads the default branch and opens a pull request with the token", async () => {
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            if (url.endsWith("/repos/luke/app")) {
                return json({ default_branch: "trunk" });
            }
            if (url.endsWith("/repos/luke/app/pulls")) {
                expect(init.method).toBe("POST");
                expect(
                    (init.headers as Record<string, string>).authorization,
                ).toBe("Bearer ghs_secret");
                const body = JSON.parse(String(init.body)) as Record<
                    string,
                    string
                >;
                expect(body).toMatchObject({
                    title: "Add a greeting",
                    head: "jarvis/add-a-greeting-1234",
                    base: "trunk",
                });
                return json({
                    number: 42,
                    html_url: "https://github.com/luke/app/pull/42",
                });
            }
            throw new Error(`unexpected url ${url}`);
        });
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        expect(await client.defaultBranch("luke", "app")).toBe("trunk");
        const pr = await client.createPullRequest({
            owner: "luke",
            repo: "app",
            head: "jarvis/add-a-greeting-1234",
            base: "trunk",
            title: "Add a greeting",
            body: "the body",
        });
        expect(pr).toEqual({
            number: 42,
            url: "https://github.com/luke/app/pull/42",
        });
    });

    it("surfaces GitHub's message without the token", async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            if (url.endsWith("/access_tokens")) {
                return json({
                    token: "ghs_secret",
                    expires_at: "2026-10-20T13:00:00Z",
                });
            }
            return json({ message: "Validation Failed" }, 422);
        });
        const client = createGitHubClient(CONFIG, {
            fetch: fetchImpl as unknown as typeof fetch,
            now: () => Date.parse("2026-10-20T12:00:00Z"),
        });

        const failure = client.createPullRequest({
            owner: "luke",
            repo: "app",
            head: "jarvis/x",
            base: "main",
            title: "x",
            body: "x",
        });
        await expect(failure).rejects.toThrow(
            "GitHub /repos/luke/app/pulls failed: 422 Validation Failed",
        );
        await expect(failure).rejects.not.toThrow(/ghs_secret/);
    });
});
