/**
 * Tests for the `homeAssistant` tool (#15): the identity and quota gates,
 * entity resolution, the read/write domain split, action→service mapping,
 * unit and value handling, list bounding, model-facing formatters, and failure
 * text. The provider is scripted, never live.
 */
import { describe, expect, it, vi } from "vitest";
import {
    createHomeAssistantTool,
    filterEntities,
    findEntity,
    formatEntity,
    isLightLike,
    isSwitchLike,
    renderLights,
    renderList,
    renderSwitches,
} from "../src/llm/tools/homeAssistant";
import { DEFAULT_HA_LIGHT_TOKENS } from "../src/config";
import { HomeAssistantError } from "../src/llm/tools/homeAssistant/types";
import type {
    HomeAssistantEntity,
    HomeAssistantProvider,
} from "../src/llm/tools/homeAssistant/types";
import { FixedWindowQuota } from "../src/rate/fixedWindowQuota";
import { logger } from "../src/logger";

const OWNER = { configurable: { userId: 7 } };

/** Builds an entity, overriding only what a test cares about. */
function entity(
    entityId: string,
    state: string,
    attributes: Record<string, unknown> = {},
): HomeAssistantEntity {
    const friendlyName = (attributes.friendly_name as string) ?? entityId;
    return {
        entityId,
        domain: entityId.split(".")[0],
        state,
        friendlyName,
        attributes: { friendly_name: friendlyName, ...attributes },
    };
}

const LIGHT = entity("light.kitchen", "on", {
    friendly_name: "Kitchen Light",
    brightness: 255,
});
const LAMP = entity("light.desk_lamp", "off", {
    friendly_name: "Desk Lamp",
    percentage: 40,
});
const COFFEE = entity("switch.coffee", "off", {
    friendly_name: "Coffee Maker",
});
const TEMP = entity("sensor.hallway_temperature", "21.4", {
    friendly_name: "Hallway Temperature",
    unit_of_measurement: "°C",
});
const THERMOSTAT = entity("climate.living_room", "heat", {
    friendly_name: "Living Room",
    current_temperature: 20.5,
    temperature: 22,
    unit_of_measurement: "°C",
});
const LOCK = entity("lock.front_door", "locked", {
    friendly_name: "Front Door",
});
const MOWER = entity("switch.mower", "off", { friendly_name: "Mower" });
const KITCHEN_SINK = entity("sensor.kitchen_sink_water", "off", {
    friendly_name: "Kitchen Sink Water",
});
/** A light modeled as a switch — the case `action: "lights"` exists for. */
const GARLAND = entity("switch.garland_lights", "off", {
    friendly_name: "Garland Lights",
});
/** The shadow child integrations create beside `switch.garland_lights`. */
const GARLAND_LED = entity("switch.garland_lights_led", "on", {
    friendly_name: "Garland Lights LED",
});

const HOUSE = [
    LIGHT,
    LAMP,
    COFFEE,
    TEMP,
    THERMOSTAT,
    LOCK,
    MOWER,
    KITCHEN_SINK,
];

/** The house as a real installation looks: a light named as a switch, plus LED. */
const TYPICAL_HOUSE = [...HOUSE, GARLAND, GARLAND_LED];

/** A scripted provider recording every service call; fails when scripted to. */
function fakeProvider(
    script: {
        entities?: HomeAssistantEntity[] | Error;
        callService?: Error;
    } = {},
): {
    provider: HomeAssistantProvider;
    calls: { entityId: string; action: string; value?: number }[];
    invalidations: number;
} {
    const calls: { entityId: string; action: string; value?: number }[] = [];
    let invalidations = 0;
    return {
        calls,
        get invalidations() {
            return invalidations;
        },
        provider: {
            name: "home-assistant",
            async entities() {
                const outcome = script.entities ?? HOUSE;
                if (outcome instanceof Error) {
                    throw outcome;
                }
                return outcome;
            },
            async callService(entityId, action, value) {
                calls.push({ entityId, action, value });
                // Home Assistant reports acceptance through its status code, so
                // the fake resolves unless scripted to fail.
                if (script.callService) {
                    throw script.callService;
                }
            },
            invalidate() {
                invalidations += 1;
            },
        },
    };
}

/** Builds the tool with sensible defaults; overrides are per-test. */
function build(
    overrides: {
        provider?: HomeAssistantProvider;
        quota?: FixedWindowQuota;
        controlDomains?: readonly string[];
        listLimit?: number;
        lightTokens?: readonly string[];
    } = {},
) {
    return createHomeAssistantTool({
        provider: overrides.provider ?? fakeProvider().provider,
        quota: overrides.quota ?? new FixedWindowQuota(10),
        controlDomains: overrides.controlDomains ?? [
            "light",
            "switch",
            "climate",
            "fan",
        ],
        listLimit: overrides.listLimit ?? 40,
        lightTokens: overrides.lightTokens ?? DEFAULT_HA_LIGHT_TOKENS,
    });
}

/**
 * The tool's own argument type, derived so a schema change fails the typecheck
 * here instead of silently drifting from the tests.
 */
type ToolInput = Parameters<ReturnType<typeof build>["invoke"]>[0];

/** Invokes the tool; `configurable` defaults to the owner identity. */
async function run(
    args: ToolInput,
    overrides: Parameters<typeof build>[0] = {},
    runtime: { configurable?: Record<string, unknown> } = OWNER,
): Promise<string> {
    return (await build(overrides).invoke(args, runtime)) as string;
}

describe("homeAssistant identity and quota gates", () => {
    it("refuses to act without a verified user id", async () => {
        for (const configurable of [
            undefined,
            {},
            { userId: "7" },
            { userId: 1.5 },
        ]) {
            const result = await run({ action: "list" }, {}, { configurable });
            expect(result).toMatch(/requires signing in/);
        }
    });

    it("reports the wait when the per-user quota is exhausted", async () => {
        const quota = new FixedWindowQuota(1);
        expect(await run({ action: "list" }, { quota })).toMatch(
            /^homeAssistant list/,
        );
        expect(await run({ action: "list" }, { quota })).toMatch(
            /rate limited/i,
        );
    });

    it("does not spend the quota of one user on another's", async () => {
        const quota = new FixedWindowQuota(1);
        expect(await run({ action: "list" }, { quota })).toMatch(/list/);
        expect(
            await run(
                { action: "list" },
                { quota },
                { configurable: { userId: 8 } },
            ),
        ).toMatch(/list/);
        expect(
            await run(
                { action: "list" },
                { quota },
                { configurable: { userId: 7 } },
            ),
        ).toMatch(/rate limited/i);
    });
});

describe("homeAssistant list", () => {
    it("lists every readable entity with its state", async () => {
        const result = await run({ action: "list" });
        expect(result).toContain("Kitchen Light [light.kitchen]: on");
        expect(result).toContain("Front Door [lock.front_door]: locked");
    });

    it("filters by query over name and domain", async () => {
        const byName = await run({ action: "list", query: "kitchen light" });
        expect(byName).toContain("light.kitchen");
        expect(byName).not.toContain("light.desk_lamp");

        const byDomain = await run({ action: "list", query: "sensor." });
        expect(byDomain).toContain("sensor.hallway_temperature");
        expect(byDomain).not.toContain("light.kitchen");
    });

    it("bounds the list and says how many were withheld", async () => {
        const result = await run({ action: "list" }, { listLimit: 3 });
        const lines = result
            .split("\n")
            .filter((l) => l.startsWith("- ") && !l.startsWith("- …"));
        expect(lines).toHaveLength(3);
        expect(result).toMatch(/and 5 more not shown/);
        expect(result).toMatch(/narrow with query/);
    });

    it("explains an empty result rather than returning nothing", async () => {
        const empty = await run(
            { action: "list" },
            { provider: fakeProvider({ entities: [] }).provider },
        );
        expect(empty).toMatch(/no entities this server may read/);

        const noMatch = await run({ action: "list", query: "attic" });
        expect(noMatch).toMatch(/nothing matches "attic"/);
    });

    it("states how much of the house the query left out", async () => {
        const result = await run({ action: "list", query: "kitchen" });
        expect(result).toMatch(
            /^homeAssistant list: 2 of 8 readable entities, filtered by "kitchen":/,
        );
    });
});

describe("homeAssistant lights and switches", () => {
    it("finds lights wherever they are modeled", async () => {
        const result = await run(
            { action: "lights" },
            { provider: fakeProvider({ entities: TYPICAL_HOUSE }).provider },
        );
        expect(result).toMatch(
            /^homeAssistant lights: 3 of 10 readable entities\./,
        );
        expect(result).toContain("Kitchen Light [light.kitchen]");
        expect(result).toContain("Desk Lamp [light.desk_lamp]");
        expect(result).toContain("Garland Lights [switch.garland_lights]");
        expect(result).not.toContain("Coffee Maker");
        expect(result).not.toContain("Mower");
        expect(result).not.toContain("garland_lights_led");
    });

    it("lists the switch domain, minus the shadow children", async () => {
        const result = await run(
            { action: "switches" },
            { provider: fakeProvider({ entities: TYPICAL_HOUSE }).provider },
        );
        expect(result).toMatch(
            /^homeAssistant switches: 3 of 10 readable entities\./,
        );
        expect(result).toContain("switch.coffee");
        expect(result).toContain("switch.mower");
        expect(result).toContain("switch.garland_lights");
        expect(result).not.toContain("garland_lights_led");
        expect(result).not.toContain("light.kitchen");
    });

    it("reports how it matched, so the model can widen the search", async () => {
        const result = await run({ action: "lights" });
        expect(result).toContain("Best-effort match");
        expect(result).toContain(DEFAULT_HA_LIGHT_TOKENS.join(", "));
        expect(result).toMatch(/call action 'list' to search/);
    });

    it("says a category may exist when nothing matched, not that it is empty", async () => {
        const noSwitches = await run(
            { action: "switches" },
            { provider: fakeProvider({ entities: [LIGHT, LAMP] }).provider },
        );
        expect(noSwitches).toMatch(
            /^homeAssistant switches: 0 of 2 readable entities\./,
        );
        expect(noSwitches).toMatch(/no switches this server may read/);

        const noLights = await run(
            { action: "lights" },
            { provider: fakeProvider({ entities: [COFFEE, MOWER] }).provider },
        );
        expect(noLights).toMatch(
            /^homeAssistant lights: 0 of 2 readable entities matched\./,
        );
        expect(noLights).toMatch(/may be missing/);
        expect(noLights).toMatch(/action 'list'/);
    });

    it("honours a narrowed light-token set", async () => {
        const result = await run(
            { action: "lights" },
            { lightTokens: ["lamp"] },
        );
        expect(result).toContain("Desk Lamp [light.desk_lamp]");
        expect(result).not.toContain("Kitchen Light [light.kitchen]");
    });

    it("explains an empty token set instead of reporting no lights", async () => {
        const result = await run({ action: "lights" }, { lightTokens: [] });
        expect(result).toMatch(/JARVIS_HA_LIGHT_TOKENS/);
        expect(result).toMatch(
            /^homeAssistant lights: 0 of 8 readable entities/,
        );
    });

    it("needs no entity id for either discovery action", async () => {
        expect(await run({ action: "lights" })).not.toMatch(/entity_id/);
        expect(await run({ action: "switches" })).not.toMatch(/entity_id/);
    });

    it("bounds both discovery lists and says how many were withheld", async () => {
        const lights = await run(
            { action: "lights" },
            {
                listLimit: 1,
                provider: fakeProvider({ entities: TYPICAL_HOUSE }).provider,
            },
        );
        expect(lights).toMatch(/and 2 more not shown/);

        const switches = await run(
            { action: "switches" },
            {
                listLimit: 1,
                provider: fakeProvider({ entities: TYPICAL_HOUSE }).provider,
            },
        );
        expect(switches).toMatch(/and 2 more not shown/);
    });
});

describe("homeAssistant get", () => {
    it("reads one entity by exact id", async () => {
        const result = await run({ action: "get", entity_id: "light.kitchen" });
        expect(result).toBe(
            "homeAssistant get: Kitchen Light [light.kitchen]: on (brightness 100%)",
        );
    });

    it("requires an entity id", async () => {
        const result = await run({ action: "get" });
        expect(result).toMatch(/needs an `entity_id`/);
    });

    it("surfaces the unit of a sensor", async () => {
        const result = await run({
            action: "get",
            entity_id: "sensor.hallway_temperature",
        });
        expect(result).toContain("21.4 (°C)");
    });

    it("shows current and target temperature for a thermostat", async () => {
        const result = await run({
            action: "get",
            entity_id: "climate.living_room",
        });
        expect(result).toContain("heat (now 20.5 °C, target 22 °C)");
    });
});

describe("homeAssistant writes", () => {
    it("turns a light on by exact id", async () => {
        const fake = fakeProvider();
        const result = await run(
            { action: "turn_on", entity_id: "light.desk_lamp" },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([
            {
                entityId: "light.desk_lamp",
                action: "turn_on",
                value: undefined,
            },
        ]);
        expect(result).toMatch(
            /turned on Desk Lamp \[light\.desk_lamp\]; Home Assistant accepted the request\./,
        );
        expect(result).not.toContain("It is now");
    });

    it("resolves a friendly name to its entity", async () => {
        const fake = fakeProvider();
        await run(
            { action: "turn_off", entity_id: "Coffee Maker" },
            { provider: fake.provider },
        );
        expect(fake.calls[0].entityId).toBe("switch.coffee");
    });

    it("passes brightness as a value on set_brightness", async () => {
        const fake = fakeProvider();
        await run(
            { action: "set_brightness", entity_id: "light.kitchen", value: 40 },
            { provider: fake.provider },
        );
        // set_brightness rides on light.turn_on with brightness_pct set.
        expect(fake.calls).toEqual([
            { entityId: "light.kitchen", action: "turn_on", value: 40 },
        ]);
    });

    it("passes temperature as a value on set_temperature", async () => {
        const fake = fakeProvider();
        await run(
            {
                action: "set_temperature",
                entity_id: "climate.living_room",
                value: 23.5,
            },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([
            {
                entityId: "climate.living_room",
                action: "set_temperature",
                value: 23.5,
            },
        ]);
    });

    it("invalidates the cached snapshot after a write", async () => {
        const fake = fakeProvider();
        await run(
            { action: "turn_off", entity_id: "light.kitchen" },
            { provider: fake.provider },
        );
        expect(fake.invalidations).toBe(1);
    });

    it("logs the write as an audit trail", async () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        await run({ action: "turn_on", entity_id: "light.desk_lamp" });
        expect(info.mock.calls.flat().join(" ")).toMatch(
            /turn_on accepted on light\.desk_lamp/,
        );
    });

    it("never reports a state, only that the request was accepted", async () => {
        // Home Assistant's service response is pre-dispatch state (a turn_off
        // routinely answers `on`); reporting it handed the model a
        // contradiction. It must not reach the result string at all.
        const result = await run({
            action: "turn_off",
            entity_id: "light.desk_lamp",
        });
        expect(result).toContain("turned off Desk Lamp [light.desk_lamp]");
        expect(result).toContain("Home Assistant accepted the request.");
        expect(result).not.toMatch(/\bare now\b|\bis now\b|reads/);
    });

    it("keeps the pre-write state out of the result even for a value write", async () => {
        const result = await run({
            action: "set_brightness",
            entity_id: "light.kitchen",
            value: 25,
        });
        expect(result).toContain("to 25%");
        expect(result).toContain("Home Assistant accepted the request.");
        expect(result).not.toContain("It is now");
    });

    it("tells the model a write is accepted rather than verified, and how to check", () => {
        const description = build().description;
        expect(description).toContain(
            "accepted the request, not that the device changed state",
        );
        expect(description).toContain("use action 'get'");
    });
});

describe("homeAssistant write refusals", () => {
    it("refuses a write to a readable-but-not-controllable domain", async () => {
        const fake = fakeProvider();
        const result = await run(
            { action: "turn_on", entity_id: "lock.front_door" },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([]);
        expect(result).toMatch(/may read but not control/);
        expect(result).toMatch(/Do not claim it was changed/);
    });

    it("refuses set_brightness on a non-light entity", async () => {
        const fake = fakeProvider();
        const result = await run(
            { action: "set_brightness", entity_id: "switch.coffee", value: 50 },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([]);
        expect(result).toMatch(/only applies to light\.\* entities/);
    });

    it("refuses set_temperature on a non-climate entity", async () => {
        const fake = fakeProvider();
        const result = await run(
            {
                action: "set_temperature",
                entity_id: "light.kitchen",
                value: 20,
            },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([]);
        expect(result).toMatch(/only applies to climate\.\* entities/);
    });

    it("requires a numeric value for a value-setting action", async () => {
        const fake = fakeProvider();
        const result = await run(
            { action: "set_temperature", entity_id: "climate.living_room" },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([]);
        expect(result).toMatch(/needs a numeric `value`/);
    });

    it("does not write when the named entity does not exist", async () => {
        const fake = fakeProvider();
        const result = await run(
            { action: "turn_on", entity_id: "light.attic" },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([]);
        expect(result).toMatch(/No entity matches "light\.attic"/);
    });

    it("does not write when the name is ambiguous, and names the candidates", async () => {
        const fake = fakeProvider();
        const result = await run(
            { action: "turn_on", entity_id: "kitchen" },
            { provider: fake.provider },
        );
        expect(fake.calls).toEqual([]);
        expect(result).toMatch(/several are close/);
        expect(result).toContain(
            "Kitchen Sink Water [sensor.kitchen_sink_water]",
        );
        expect(result).toMatch(/Retry with the exact `entity_id`/);
    });

    it.each(["unavailable", "unknown"])(
        "does not write to an entity reading %s",
        async (state) => {
            const fake = fakeProvider({
                entities: [entity("light.kitchen", state)],
            });
            const result = await run(
                { action: "turn_on", entity_id: "light.kitchen" },
                { provider: fake.provider },
            );
            expect(fake.calls).toEqual([]);
            expect(result).toContain(`currently reads "${state}"`);
            expect(result).toMatch(/Do not claim a change/);
        },
    );
});

describe("homeAssistant failures", () => {
    it("returns generic unreachable text for a transport failure", async () => {
        const fake = fakeProvider({
            entities: new HomeAssistantError("home assistant returned 401"),
        });
        const result = await run(
            { action: "list" },
            { provider: fake.provider },
        );
        expect(result).toMatch(/unreachable right now/);
        expect(result).not.toMatch(/401/);
    });

    it("returns generic unreachable text for an unexpected error", async () => {
        const fake = fakeProvider({
            entities: new TypeError("cannot read property of undefined"),
        });
        const result = await run(
            { action: "list" },
            { provider: fake.provider },
        );
        expect(result).toMatch(/unreachable right now/);
    });

    it("returns generic unreachable text when the write fails", async () => {
        const fake = fakeProvider({
            callService: new HomeAssistantError("home assistant returned 400"),
        });
        const result = await run(
            { action: "turn_on", entity_id: "light.kitchen" },
            { provider: fake.provider },
        );
        expect(result).toMatch(/unreachable right now/);
    });
});

describe("homeAssistant formatters", () => {
    it("formats an entity with no extras as id and state only", () => {
        expect(formatEntity(entity("switch.mower", "off"))).toBe(
            "switch.mower [switch.mower]: off",
        );
    });

    it("scales raw 0-255 brightness to a percentage", () => {
        expect(
            formatEntity(entity("light.a", "on", { brightness: 128 })),
        ).toContain("brightness 50%");
        expect(
            formatEntity(entity("light.a", "on", { brightness: 0 })),
        ).toContain("brightness 0%");
    });

    it("prefers a reported percentage over raw brightness", () => {
        expect(
            formatEntity(
                entity("light.a", "on", { brightness: 255, percentage: 40 }),
            ),
        ).toContain("brightness 40%");
    });

    it("ignores non-numeric extras", () => {
        const line = formatEntity(
            entity("sensor.a", "5", {
                unit_of_measurement: "kWh",
                current_temperature: "warm",
                battery_level: "unknown",
            }),
        );
        expect(line).toBe("sensor.a [sensor.a]: 5 (kWh)");
    });

    it("renders a header that states the denominator, filtered or not", () => {
        expect(renderList([LIGHT], "kitchen", 10)).toMatch(
            /^homeAssistant list: 1 of 1 readable entities, filtered by "kitchen":/,
        );
        expect(renderList([LIGHT, LAMP], undefined, 10)).toMatch(
            /^homeAssistant list: 2 of 2 readable entities:/,
        );
        expect(renderList(HOUSE, undefined, 10)).toMatch(
            /^homeAssistant list: 8 of 8 readable entities:/,
        );
        expect(renderList(HOUSE, "light", 10)).toMatch(
            /^homeAssistant list: 2 of 8 readable entities, filtered by "light":/,
        );
    });
});

describe("homeAssistant entity resolution", () => {
    it("prefers an exact id over an exact name", () => {
        expect(findEntity(HOUSE, "light.kitchen")?.entityId).toBe(
            "light.kitchen",
        );
    });

    it("matches a name case-insensitively", () => {
        expect(findEntity(HOUSE, "kitchen light")?.entityId).toBe(
            "light.kitchen",
        );
    });

    it("refuses a partial name that matches more than one entity", () => {
        expect(findEntity(HOUSE, "kitchen")).toBeUndefined();
    });

    it("refuses an empty needle", () => {
        expect(findEntity(HOUSE, "  ")).toBeUndefined();
    });

    it("sorts filtered entities by friendly name", () => {
        expect(
            filterEntities([COFFEE, LIGHT, LAMP], undefined).map(
                (e) => e.friendlyName,
            ),
        ).toEqual(["Coffee Maker", "Desk Lamp", "Kitchen Light"]);
    });

    it("returns everything for an empty query and matches on id or name", () => {
        expect(filterEntities(HOUSE, "   ")).toHaveLength(HOUSE.length);
        expect(filterEntities(HOUSE, "climate").map((e) => e.entityId)).toEqual(
            ["climate.living_room"],
        );
    });
});

describe("homeAssistant light and switch detection", () => {
    const tokens = DEFAULT_HA_LIGHT_TOKENS;

    it("treats a native light as a light even without a name token", () => {
        const plain = entity("light.toasty", "off", {
            friendly_name: "Toasty",
        });
        expect(isLightLike(plain, tokens)).toBe(true);
    });

    it("treats a switch as a light only when a name token matches", () => {
        expect(isLightLike(GARLAND, tokens)).toBe(true);
        expect(isLightLike(COFFEE, tokens)).toBe(false);
        expect(isLightLike(MOWER, tokens)).toBe(false);
    });

    it("rejects other domains even when the name screams light", () => {
        const sensor = entity("sensor.living_room_light", "5", {
            friendly_name: "Living Room Light Level",
        });
        expect(isLightLike(sensor, tokens)).toBe(false);
        expect(isLightLike(THERMOSTAT, tokens)).toBe(false);
    });

    it("keeps shadow children out of both categories", () => {
        expect(isLightLike(GARLAND_LED, tokens)).toBe(false);
        expect(isSwitchLike(GARLAND_LED)).toBe(false);
    });

    it("narrow switches to the switch domain alone", () => {
        expect(isSwitchLike(GARLAND)).toBe(true);
        expect(isSwitchLike(COFFEE)).toBe(true);
        expect(isSwitchLike(LIGHT)).toBe(false);
        expect(isSwitchLike(TEMP)).toBe(false);
    });

    it("exposes the same scope sentence from the renderers", () => {
        expect(renderLights(TYPICAL_HOUSE, tokens, 40)).toMatch(
            /^homeAssistant lights: 3 of 10 readable entities/,
        );
        expect(renderSwitches(TYPICAL_HOUSE, 40)).toMatch(
            /^homeAssistant switches: 3 of 10 readable entities/,
        );
    });

    it("never lists more than the ceiling in either discovery action", () => {
        const lines = (text: string) =>
            text
                .split("\n")
                .filter((l) => l.startsWith("- ") && !l.startsWith("- …"));
        expect(lines(renderLights(TYPICAL_HOUSE, tokens, 2))).toHaveLength(2);
        expect(lines(renderSwitches(TYPICAL_HOUSE, 2))).toHaveLength(2);
        expect(renderLights(TYPICAL_HOUSE, tokens, 2)).toMatch(
            /and 1 more not shown/,
        );
    });
});
