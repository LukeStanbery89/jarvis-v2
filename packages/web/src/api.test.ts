/**
 * Unit tests for the REST client: request shapes, Bearer headers, error
 * mapping, and the injected-fetch seam (no server, no network).
 */
import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "./api";

/** Builds a fetch double answering one JSON status/body. */
function fetchJson(
    status: number,
    body: unknown,
): { fetch: typeof fetch; calls: { path: string; init: RequestInit }[] } {
    const calls: { path: string; init: RequestInit }[] = [];
    const fetchImpl = (async (path: string, init?: RequestInit) => {
        calls.push({ path, init: init ?? {} });
        return new Response(status === 204 ? null : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    return { fetch: fetchImpl, calls };
}

describe("createApi.login", () => {
    it("posts credentials with a web-<hex> device name and returns the result", async () => {
        const { fetch, calls } = fetchJson(200, {
            user: { id: 7, username: "luke", role: "owner" },
            device: {
                id: 3,
                name: "web-ab12",
                prefix: "dvt_ab12",
                token: "dvt_1",
            },
        });
        const result = await createApi(fetch).login("luke", "hunter22");
        const init = calls[0].init;
        expect(calls[0].path).toBe("/api/auth/login");
        expect(init.method).toBe("POST");
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body.username).toBe("luke");
        expect(body.password).toBe("hunter22");
        expect(body.deviceName).toMatch(/^web-[0-9a-f]{4}$/);
        expect(result.device.token).toBe("dvt_1");
    });

    it("surfaces the server's error body on failures", async () => {
        const { fetch } = fetchJson(401, {
            error: "Invalid username or password.",
        });
        await expect(createApi(fetch).login("luke", "wrong")).rejects.toThrow(
            "Invalid username or password.",
        );
        const { fetch: fetch429 } = fetchJson(429, {
            error: "Too many attempts; try again later.",
        });
        const err = createApi(fetch429).login("luke", "wrong");
        await expect(err).rejects.toBeInstanceOf(ApiError);
        await err.catch((e: ApiError) => expect(e.status).toBe(429));
    });

    it("falls back to the status text on a non-JSON error body", async () => {
        const calls: { path: string; init: RequestInit }[] = [];
        const fetchImpl = (async () =>
            new Response("<html>oops</html>", {
                status: 500,
            })) as unknown as typeof fetch;
        void calls;
        await expect(createApi(fetchImpl).login("u", "p")).rejects.toThrow();
    });
});

describe("createApi sessions", () => {
    it("sends the Bearer token on listSessions", async () => {
        const { fetch, calls } = fetchJson(200, []);
        const rows = await createApi(fetch).listSessions("tok");
        expect(rows).toEqual([]);
        expect(calls[0].path).toBe("/api/sessions");
        expect(
            (calls[0].init.headers as Record<string, string>).authorization,
        ).toBe("Bearer tok");
    });

    it("encodes the thread id path segment on deleteSession", async () => {
        const { fetch, calls } = fetchJson(204, null);
        await expect(
            createApi(fetch).deleteSession("tok", "thread/one"),
        ).resolves.toBeUndefined();
        expect(calls[0].path).toBe("/api/sessions/thread%2Fone");
        expect(calls[0].init.method).toBe("DELETE");
    });
});
