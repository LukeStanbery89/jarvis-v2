/**
 * Tests for the shared provider transport (#103): the request/signal
 * composition (the caller's signal and the configured timeout must COMBINE —
 * `AbortSignal.any` — never replace one another), the failure taxonomy
 * (`unreachable`/`http`/`json`) with `cause` chaining, and the field
 * coercers. The provider-specific `mapFailure` is a stub here; the clients'
 * own suites pin their typed-error mappings.
 */
import { describe, expect, it } from "vitest";
import {
    asNumber,
    asString,
    requestJson,
    type ToolHttpFailure,
} from "../src/llm/tools/http";

const OK = new Response(JSON.stringify({ fine: true }), { status: 200 });

/** A fetch that never settles until its abort signal fires (a hung host). */
function hangingFetch(): typeof fetch {
    return ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
                reject(init.signal?.reason),
            );
        })) as unknown as typeof fetch;
}

/** Maps failures exactly like the real clients do (flat typed error). */
const mapFailure = (f: ToolHttpFailure): Error =>
    Object.assign(new Error(f.message), { failure: f });

/** Runs `promise`, resolving the typed failure it throws (fails if it resolves). */
async function capture(
    promise: Promise<unknown>,
): Promise<Error & { failure: ToolHttpFailure }> {
    try {
        await promise;
    } catch (e) {
        return e as Error & { failure: ToolHttpFailure };
    }
    throw new Error("expected the call to reject");
}

describe("requestJson signal composition", () => {
    it("still enforces the timeout when the caller supplies a signal (#103 footgun)", async () => {
        // The pre-#103 bug: `signal ?? AbortSignal.timeout(ms)` dropped the
        // timeout whenever a signal was present. A quiet (non-aborting)
        // caller signal plus a hung fetch must still reject on the timeout.
        const start = Date.now();
        await expect(
            requestJson({
                url: "https://provider.test/x",
                label: "provider",
                timeoutMs: 50,
                signal: new AbortController().signal,
                fetchImpl: hangingFetch(),
                mapFailure,
            }),
        ).rejects.toThrow(/unreachable/);
        expect(Date.now() - start).toBeLessThan(2_000);
    });

    it("aborts as soon as the caller's signal fires, before the timeout", async () => {
        const controller = new AbortController();
        const start = Date.now();
        const pending = requestJson({
            url: "https://provider.test/x",
            label: "provider",
            timeoutMs: 60_000,
            signal: controller.signal,
            fetchImpl: hangingFetch(),
            mapFailure,
        });
        controller.abort();
        await expect(pending).rejects.toThrow(/unreachable/);
        expect(Date.now() - start).toBeLessThan(2_000);
    });

    it("resolves normally when neither the caller nor the timeout fires", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const fetchImpl = (async (input: unknown, init?: RequestInit) => {
            calls.push({
                url: String(input),
                init: (init ?? {}) as RequestInit,
            });
            return OK;
        }) as unknown as typeof fetch;
        await expect(
            requestJson({
                url: "https://provider.test/x?a=1",
                label: "provider",
                timeoutMs: 1_000,
                signal: new AbortController().signal,
                method: "POST",
                headers: { Authorization: "Bearer x" },
                body: JSON.stringify({ q: 1 }),
                fetchImpl,
                mapFailure,
            }),
        ).resolves.toEqual({ fine: true });
        expect(calls[0]?.url).toBe("https://provider.test/x?a=1");
        expect(calls[0]?.init.method).toBe("POST");
        expect(calls[0]?.init.headers).toEqual({
            Authorization: "Bearer x",
        });
    });
});

describe("requestJson failure taxonomy", () => {
    it("chains the original error as cause on a transport failure", async () => {
        const boom = new TypeError("net::ERR_NETWORK_CHANGED");
        const err = await capture(
            requestJson({
                url: "https://provider.test/x",
                label: "provider",
                timeoutMs: 1_000,
                fetchImpl: (() => {
                    throw boom;
                }) as unknown as typeof fetch,
                mapFailure,
            }),
        );
        expect(err.message).toBe(
            "provider unreachable: net::ERR_NETWORK_CHANGED",
        );
        expect(err.failure.kind).toBe("unreachable");
        expect(err.failure.cause).toBe(boom);
    });

    it("uses the hook's message for HTTP failures and carries the status", async () => {
        const err = await capture(
            requestJson({
                url: "https://provider.test/x",
                label: "provider",
                timeoutMs: 1_000,
                fetchImpl: (async () =>
                    new Response(
                        JSON.stringify({ message: "city not found" }),
                        { status: 404 },
                    )) as unknown as typeof fetch,
                httpErrorText: async (response) =>
                    `provider returned ${response.status} (${
                        ((await response.json()) as { message: string }).message
                    })`,
                mapFailure,
            }),
        );
        expect(err.message).toBe("provider returned 404 (city not found)");
        expect(err.failure.kind).toBe("http");
        expect(err.failure.status).toBe(404);
        expect(err.failure.cause).toBeDefined();
    });

    it("falls back to `<label> returned <status>` without a hook", async () => {
        await expect(
            requestJson({
                url: "https://provider.test/x",
                label: "provider",
                timeoutMs: 1_000,
                fetchImpl: (async () =>
                    new Response("nope", {
                        status: 503,
                    })) as unknown as typeof fetch,
                mapFailure,
            }),
        ).rejects.toThrow("provider returned 503");
    });

    it("chains the parse error as cause on invalid JSON", async () => {
        const err = await capture(
            requestJson({
                url: "https://provider.test/x",
                label: "provider",
                timeoutMs: 1_000,
                fetchImpl: (async () =>
                    new Response("<html>not json</html>", {
                        status: 200,
                    })) as unknown as typeof fetch,
                mapFailure,
            }),
        );
        expect(err.message).toBe("provider returned invalid JSON");
        expect(err.failure.kind).toBe("json");
        expect(err.failure.cause).toBeInstanceOf(Error);
    });

    it("resolves undefined for ignoreBody without reading the body", async () => {
        await expect(
            requestJson({
                url: "https://provider.test/x",
                label: "provider",
                timeoutMs: 1_000,
                ignoreBody: true,
                fetchImpl: (async () =>
                    new Response(JSON.stringify({ ignored: true }), {
                        status: 200,
                    })) as unknown as typeof fetch,
                mapFailure,
            }),
        ).resolves.toBeUndefined();
    });
});

describe("provider JSON field coercers", () => {
    it("coerces strings and numbers defensively", () => {
        expect(asString("x")).toBe("x");
        expect(asString(7)).toBe("");
        expect(asString(undefined)).toBe("");
        expect(asNumber(4.2)).toBe(4.2);
        expect(asNumber("4.2")).toBe(NaN);
        expect(asNumber(Number.POSITIVE_INFINITY)).toBe(NaN);
        expect(asNumber(undefined)).toBe(NaN);
    });
});
