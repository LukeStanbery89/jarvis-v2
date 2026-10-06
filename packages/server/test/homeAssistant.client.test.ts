/**
 * Tests for the Home Assistant REST client (#15): request shapes, auth header
 * placement, read-domain filtering, defensive normalization, the TTL cache and
 * its invalidation, write payloads, and typed failures. The token must never
 * appear in a URL, a log line, or an error message. Home Assistant is mocked,
 * never live.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHomeAssistantClient } from "../src/llm/tools/homeAssistant/client";
import { HomeAssistantError } from "../src/llm/tools/homeAssistant/types";
import { logger } from "../src/logger";

const TOKEN = "ha-super-secret-token";

const BASE = {
    url: "http://ha.local:8123",
    accessToken: TOKEN,
    readDomains: ["light", "switch", "sensor", "climate"],
    timeoutMs: 5_000,
    cacheTtlMs: 0,
};

/** Builds a mock fetch answering with `body` (or throwing when scripted). */
function mockFetch(
    respond:
        | { status?: number; body?: unknown; text?: string }
        | { failWith: unknown },
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        calls.push({ url: String(input), init: (init ?? {}) as RequestInit });
        if ("failWith" in respond) {
            throw respond.failWith;
        }
        return new Response(
            respond.text ?? JSON.stringify(respond.body ?? []),
            {
                status: respond.status ?? 200,
                headers: { "Content-Type": "application/json" },
            },
        );
    };
    return { fetch: impl as unknown as typeof fetch, calls };
}

/** A representative `/api/states` payload, including out-of-scope domains. */
const STATES = [
    {
        entity_id: "light.kitchen",
        state: "on",
        attributes: {
            friendly_name: "Kitchen Light",
            brightness: 255,
            supported_color_modes: ["hs"],
            entity_picture: "/api/image/large.png",
        },
    },
    {
        entity_id: "switch.coffee",
        state: "off",
        attributes: { friendly_name: "Coffee Maker" },
    },
    {
        entity_id: "sensor.hallway_temperature",
        state: "21.4",
        attributes: {
            friendly_name: "Hallway Temperature",
            unit_of_measurement: "°C",
            device_class: "temperature",
        },
    },
    {
        entity_id: "lock.front_door",
        state: "locked",
        attributes: { friendly_name: "Front Door" },
    },
    {
        entity_id: "climate.living_room",
        state: "heat",
        attributes: {
            friendly_name: "Living Room",
            current_temperature: 20.5,
            temperature: 22,
            unit_of_measurement: "°C",
        },
    },
];

afterEach(() => {
    vi.restoreAllMocks();
});

describe("homeAssistant client reads", () => {
    it("sends the token as a Bearer header and never in the URL", async () => {
        const mock = mockFetch({ body: STATES });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await client.entities();
        expect(mock.calls).toHaveLength(1);
        expect(mock.calls[0].url).toBe("http://ha.local:8123/api/states");
        expect(mock.calls[0].url).not.toContain(TOKEN);
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("exposes only entities in the configured read domains", async () => {
        const mock = mockFetch({ body: STATES });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        const ids = (await client.entities()).map((e) => e.entityId);
        expect(ids).toEqual([
            "light.kitchen",
            "switch.coffee",
            "sensor.hallway_temperature",
            "climate.living_room",
        ]);
    });

    it("normalizes entities and keeps only useful attributes", async () => {
        const mock = mockFetch({ body: STATES });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        const [light] = await client.entities();
        expect(light.domain).toBe("light");
        expect(light.state).toBe("on");
        expect(light.friendlyName).toBe("Kitchen Light");
        expect(light.attributes.brightness).toBe(255);
        expect(light.attributes.supported_color_modes).toBeUndefined();
        expect(light.attributes.entity_picture).toBeUndefined();
    });

    it("falls back to the entity id when there is no friendly name", async () => {
        const mock = mockFetch({
            body: [{ entity_id: "switch.anon", state: "on", attributes: {} }],
        });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        expect((await client.entities())[0].friendlyName).toBe("switch.anon");
    });

    it("drops malformed entries and non-object attributes", async () => {
        const mock = mockFetch({
            body: [
                null,
                "nonsense",
                { entity_id: "nodomain", state: "on" },
                { entity_id: "light.trailing.", state: "on" },
                {
                    entity_id: "light.ok",
                    state: "on",
                    attributes: "not-an-object",
                },
                { entity_id: "light.nostate", attributes: {} },
            ],
        });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        const entities = await client.entities();
        expect(entities.map((e) => e.entityId)).toEqual([
            "light.ok",
            "light.nostate",
        ]);
        expect(entities[0].state).toBe("on");
        expect(entities[0].attributes).toEqual({});
        expect(entities[1].state).toBe("");
    });

    it("throws a typed error when the payload is not an array", async () => {
        const mock = mockFetch({ body: { message: "not a list" } });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(client.entities()).rejects.toThrow(HomeAssistantError);
        await expect(client.entities()).rejects.toThrow(/unexpected state/);
    });
});

describe("homeAssistant client caching", () => {
    it("serves a second read from cache within the TTL", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000);
        const mock = mockFetch({ body: STATES });
        const client = createHomeAssistantClient({
            ...BASE,
            cacheTtlMs: 15_000,
            fetchImpl: mock.fetch,
        });
        await client.entities();
        vi.spyOn(Date, "now").mockReturnValue(1_500);
        await client.entities();
        expect(mock.calls).toHaveLength(1);
    });

    it("refetches once the TTL has expired", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000);
        const mock = mockFetch({ body: STATES });
        const client = createHomeAssistantClient({
            ...BASE,
            cacheTtlMs: 15_000,
            fetchImpl: mock.fetch,
        });
        await client.entities();
        vi.spyOn(Date, "now").mockReturnValue(20_000);
        await client.entities();
        expect(mock.calls).toHaveLength(2);
    });

    it("collapses a burst of concurrent reads into one request", async () => {
        const mock = mockFetch({ body: STATES });
        const client = createHomeAssistantClient({
            ...BASE,
            cacheTtlMs: 60_000,
            fetchImpl: mock.fetch,
        });
        await Promise.all([
            client.entities(),
            client.entities(),
            client.entities(),
        ]);
        expect(mock.calls).toHaveLength(1);
    });

    it("refetches after invalidate()", async () => {
        const mock = mockFetch({ body: STATES });
        const client = createHomeAssistantClient({
            ...BASE,
            cacheTtlMs: 60_000,
            fetchImpl: mock.fetch,
        });
        await client.entities();
        client.invalidate();
        await client.entities();
        expect(mock.calls).toHaveLength(2);
    });

    it("does not cache a failed read", async () => {
        const mock = mockFetch({ status: 502, text: "upstream down" });
        const client = createHomeAssistantClient({
            ...BASE,
            cacheTtlMs: 60_000,
            fetchImpl: mock.fetch,
        });
        await expect(client.entities()).rejects.toThrow(HomeAssistantError);
        await expect(client.entities()).rejects.toThrow(HomeAssistantError);
        expect(mock.calls).toHaveLength(2);
    });
});

describe("homeAssistant client writes", () => {
    it("posts a service call with the entity id and no token in the URL", async () => {
        const mock = mockFetch({
            body: [{ entity_id: "light.kitchen", state: "on", attributes: {} }],
        });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(
            client.callService("light.kitchen", "turn_on"),
        ).resolves.toBeUndefined();
        expect(mock.calls[0].url).toBe(
            "http://ha.local:8123/api/services/light/turn_on",
        );
        expect(mock.calls[0].init.method).toBe("POST");
        expect(JSON.parse(String(mock.calls[0].init.body))).toEqual({
            entity_id: "light.kitchen",
        });
    });

    it("maps brightness to brightness_pct and temperature to temperature", async () => {
        const mock = mockFetch({ body: [] });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await client.callService("light.kitchen", "set_brightness", 40);
        await client.callService("climate.living_room", "set_temperature", 22);
        expect(JSON.parse(String(mock.calls[0].init.body))).toEqual({
            entity_id: "light.kitchen",
            brightness_pct: 40,
        });
        expect(JSON.parse(String(mock.calls[1].init.body))).toEqual({
            entity_id: "climate.living_room",
            temperature: 22,
        });
        expect(mock.calls[1].url).toContain(
            "/api/services/climate/set_temperature",
        );
    });

    it("drops the cached snapshot after a write", async () => {
        const mock = mockFetch({ body: [] });
        const client = createHomeAssistantClient({
            ...BASE,
            cacheTtlMs: 60_000,
            fetchImpl: mock.fetch,
        });
        await client.entities();
        await client.callService("light.kitchen", "turn_off");
        await client.entities();
        expect(mock.calls).toHaveLength(3);
        expect(mock.calls[1].url).toContain("/api/services/light/turn_off");
    });

    it("rejects an entity id that is not domain.object_id", async () => {
        const mock = mockFetch({ body: [] });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        for (const bad of ["kitchen", ".kitchen", "light.kitchen.", "a.b.c"]) {
            await expect(client.callService(bad, "turn_on")).rejects.toThrow(
                /not a valid entity id/,
            );
        }
        expect(mock.calls).toHaveLength(0);
    });

    it("discards the service response body entirely", async () => {
        const mock = mockFetch({ body: { unexpected: true } });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(
            client.callService("light.kitchen", "turn_on"),
        ).resolves.toBeUndefined();
        expect(mock.calls).toHaveLength(1);
    });

    it("treats a 2xx write as accepted even when the body is not JSON", async () => {
        const mock = mockFetch({ text: "<html>rewritten by a proxy</html>" });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(
            client.callService("light.kitchen", "turn_off"),
        ).resolves.toBeUndefined();
    });
});

describe("homeAssistant client failures", () => {
    it("maps a transport failure to a typed error", async () => {
        const mock = mockFetch({ failWith: new Error("connect ECONNREFUSED") });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(client.entities()).rejects.toThrow(HomeAssistantError);
        await expect(client.entities()).rejects.toThrow(/unreachable/);
    });

    it("includes the status and scrubs the token from an error body", async () => {
        const mock = mockFetch({
            status: 401,
            text: `unauthorized for token ${TOKEN}`,
        });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(client.entities()).rejects.toThrow(/returned 401/);
        await expect(client.entities()).rejects.toThrow(/\[redacted\]/);
        await expect(client.entities()).rejects.not.toThrow(TOKEN);
    });

    it("reports invalid JSON", async () => {
        const mock = mockFetch({ text: "<html>not json</html>" });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(client.entities()).rejects.toThrow(/invalid JSON/);
    });

    it("never logs the token", async () => {
        const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const mock = mockFetch({ status: 500, text: TOKEN });
        const client = createHomeAssistantClient({
            ...BASE,
            fetchImpl: mock.fetch,
        });
        await expect(client.entities()).rejects.toThrow(HomeAssistantError);
        await client
            .callService("light.kitchen", "turn_on")
            .catch(() => undefined);
        for (const spy of [debug, info, warn]) {
            for (const call of spy.mock.calls) {
                expect(JSON.stringify(call)).not.toContain(TOKEN);
            }
        }
    });
});
