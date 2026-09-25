/**
 * Unit tests for the typed API client (`src/api.ts`).
 *
 * The portal's only user-facing logic that's worth testing headlessly is the
 * fetch wrapper: CSRF header wiring, dead-session redirects, and error mapping.
 * `fetch` is global in Node 18+, so no jsdom is needed — `global.fetch` is
 * stubbed per test and restored after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ApiError,
    api,
    getCsrfToken,
    setCsrfToken,
    setUnauthorizedHandler,
} from "./api";

/** Stubs `window.fetch`-shaped global fetch with a canned response. */
function mockJsonFetch(status: number, body: unknown): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Promise.resolve({
                ok: status >= 200 && status < 300,
                status,
                json: async () => body,
            } as Response),
        ),
    );
}

function mockEmptyFetch(status: number): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Promise.resolve({
                ok: status >= 200 && status < 300,
                status,
                json: async () => ({}),
            } as Response),
        ),
    );
}

function lastFetchCall(): { method: string; url: string; init: RequestInit } {
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [url, init] = calls[calls.length - 1];
    return {
        method: (init?.method ?? "GET") as string,
        url: String(url),
        init: init ?? {},
    };
}

describe("api client", () => {
    beforeEach(() => {
        setCsrfToken(null);
        setUnauthorizedHandler(null);
    });

    afterEach(() => {
        setCsrfToken(null);
        setUnauthorizedHandler(null);
        vi.unstubAllGlobals();
    });

    it("adds the x-csrf-token header to state-changing calls when a nonce is held", async () => {
        setCsrfToken("nonce-123");
        mockJsonFetch(200, { ok: 1 });
        await api.setPrefs(undefined, { theme: "dark" });
        const { method, init } = lastFetchCall();
        expect(method).toBe("PUT");
        expect(init.headers).toMatchObject({ "x-csrf-token": "nonce-123" });
    });

    it("omits the CSRF header on GETs and when no nonce is held", async () => {
        mockJsonFetch(200, { user: "x" });
        await api.getSession();
        const first = lastFetchCall();
        expect(first.method).toBe("GET");
        expect(first.init.headers ?? {}).not.toHaveProperty("x-csrf-token");

        mockJsonFetch(200, {});
        await api.clearPrefs(); // DELETE but nonce is null
        const second = lastFetchCall();
        expect(second.method).toBe("DELETE");
        expect(second.init.headers ?? {}).not.toHaveProperty("x-csrf-token");
    });

    it("serializes JSON bodies and keeps credentials same-origin", async () => {
        mockJsonFetch(201, { user: { username: "luke" } });
        await api.login("luke", "hunter2pw");
        const { init } = lastFetchCall();
        expect(init.headers).toMatchObject({
            "content-type": "application/json",
        });
        expect(init.body).toBe(
            JSON.stringify({ username: "luke", password: "hunter2pw" }),
        );
        expect(init.credentials).toBe("same-origin");
    });

    it("fires the unauthorized handler on a 401 unless skipped", async () => {
        let bounced = 0;
        setUnauthorizedHandler(() => {
            bounced += 1;
        });
        mockJsonFetch(401, { error: "invalid device token or session" });
        await expect(api.me()).rejects.toBeInstanceOf(ApiError);
        expect(bounced).toBe(1);

        // login skipAuthRedirect: no bounce
        mockJsonFetch(401, { error: "invalid username or password" });
        await expect(api.login("luke", "wrong")).rejects.toBeInstanceOf(
            ApiError,
        );
        expect(bounced).toBe(1);
    });

    it("maps { error } messages into ApiError, with statusText fallback", async () => {
        mockJsonFetch(400, { error: "password must be at least 8 characters" });
        await expect(
            api.createUser("a", "short", "user"),
        ).rejects.toMatchObject({
            message: "password must be at least 8 characters",
            status: 400,
        });

        // Non-JSON error body → statusText fallback
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Promise.resolve({
                    ok: false,
                    status: 500,
                    statusText: "Internal Server Error",
                    json: async () => {
                        throw new Error("not json");
                    },
                } as unknown as Response),
            ),
        );
        await expect(api.listUsers()).rejects.toMatchObject({
            message: "Internal Server Error",
            status: 500,
        });
    });

    it("returns the parsed body for 2xx and undefined for 204", async () => {
        mockJsonFetch(200, { user: { username: "pepper" } });
        const session = await api.getSession();
        expect(session).toEqual({ user: { username: "pepper" } });

        mockEmptyFetch(204);
        await expect(api.logout()).resolves.toBeUndefined();
    });

    it("exposes the CSRF nonce for the app boot sequence", () => {
        setCsrfToken("abc");
        expect(getCsrfToken()).toBe("abc");
    });
});
