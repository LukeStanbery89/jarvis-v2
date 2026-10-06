/**
 * The `homeAssistant` tool (#15): the agent's window onto the user's house.
 *
 * One tool with an `action` argument, so the model picks an intent rather than
 * choosing between tool names. Actions split into reads (`list`, `get`) and
 * writes (`turn_on`, `turn_off`, `toggle`, `set_brightness`,
 * `set_temperature`); the read and write paths are deliberately different in
 * what they are allowed to touch (see `controlDomains` below).
 *
 * **Nothing is written that was not validated first.** Every control action
 * resolves `entity_id` against the instance's domain-filtered snapshot before a
 * service call goes out, so a typo, a hallucinated id, or an out-of-scope entity
 * is refused in model-facing prose instead of being sent to the house. The
 * control domain list is a strict subset of the read list, which is how
 * `lock.*`, `cover.*`, `button.*`, `scene.*` and `script.*` stay readable but
 * unwritable — arming a lock from a model turn is a different risk class than
 * reading its state, and gets its own issue.
 *
 * Writes execute immediately. The tool description tells the model to confirm an
 * ambiguous or sweeping ask in words first, and never to guess a target; every
 * write is logged at info as an audit trail of what the assistant did.
 *
 * The caller's identity arrives through LangGraph's `configurable.userId` — the
 * same verified seam `getWeather`, `webSearch` and `analyzeImage` use — so the
 * quota keys on the real account. Every failure returns actionable model-facing
 * text; nothing here throws at the model.
 */
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";
import {
    HomeAssistantError,
    type HomeAssistantEntity,
    type HomeAssistantProvider,
} from "./homeAssistant/types";
import { FixedWindowQuota } from "../../rate/fixedWindowQuota";
import { logger } from "../../logger";

/** Everything the tool needs, injected at wiring time. */
export interface HomeAssistantDeps {
    /** The configured Home Assistant provider. */
    provider: HomeAssistantProvider;
    /** Per-user call budget (reads and writes share it). */
    quota: FixedWindowQuota;
    /** Domains whose entities the tool may write. */
    controlDomains: readonly string[];
    /** Ceiling on entities listed in one call. */
    listLimit: number;
}

/** The actions the model can ask for. */
const ACTIONS = [
    "list",
    "get",
    "turn_on",
    "turn_off",
    "toggle",
    "set_brightness",
    "set_temperature",
] as const;

/** Actions that change the physical state of the house. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set([
    "turn_on",
    "turn_off",
    "toggle",
    "set_brightness",
    "set_temperature",
]);

/** Service name Home Assistant expects for each write action. */
const SERVICE_FOR_ACTION: Readonly<Record<string, string>> = {
    turn_on: "turn_on",
    turn_off: "turn_off",
    toggle: "toggle",
    set_brightness: "turn_on",
    set_temperature: "set_temperature",
};

/** Domain each value-setting action requires. */
const DOMAIN_FOR_ACTION: Readonly<Record<string, string>> = {
    set_brightness: "light",
    set_temperature: "climate",
};

/** Actions that need an `entity_id`. */
const NEEDS_ENTITY: ReadonlySet<string> = new Set([
    "get",
    "turn_on",
    "turn_off",
    "toggle",
    "set_brightness",
    "set_temperature",
]);

/** Model-facing text when a socket is a guest; mirrors the other metered tools. */
const SIGN_IN_REQUIRED =
    "Home Assistant control requires signing in. Ask the user to authenticate and retry.";

/** Model-facing text for a failed call; never leaks internals. */
function failureText(reason: string): string {
    logger.warn(`homeAssistant failed — ${reason}`);
    return "Home Assistant is unreachable right now. Tell the user their home could not be reached, and do not guess what state it is in.";
}

/**
 * Renders the " to <value>" clause of a write confirmation.
 *
 * Brightness is always a percentage because that is what `brightness_pct` means
 * on the wire; a temperature needs the entity's own unit, since the instance may
 * be metric and the caller passed a bare number.
 */
function valueNote(
    action: string,
    value: number | undefined,
    entity: HomeAssistantEntity,
): string {
    if (value === undefined || !Number.isFinite(value)) {
        return "";
    }
    if (action === "set_brightness") {
        return ` to ${Math.round(value)}%`;
    }
    const unit = entity.attributes.unit_of_measurement;
    return ` to ${value}${typeof unit === "string" ? ` ${unit}` : ""}`;
}

/** Past-tense verb for the confirmation line. */
function pastTense(action: string): string {
    switch (action) {
        case "turn_on":
            return "turned on";
        case "turn_off":
            return "turned off";
        case "toggle":
            return "toggled";
        case "set_brightness":
            return "set the brightness of";
        default:
            return "set the temperature of";
    }
}

/**
 * Renders one entity as a single model-facing line.
 *
 * Pure and exported for tests. Only the attributes that change what the model
 * would say are shown, and `unit_of_measurement` is always included when the
 * entity reports one — a temperature without its unit is how "70" turns into
 * 158 °F on the wrong system.
 */
export function formatEntity(entity: HomeAssistantEntity): string {
    return `${entity.friendlyName} [${entity.entityId}]: ${entity.state}${stateDetails(entity)}`;
}

/**
 * Renders the parenthesised extras for an entity's state, or "" when it has
 * none — the unit, the current/target temperatures, the brightness, the
 * battery.
 *
 * Exported so the write confirmation can report the same detail as `get`; the
 * two must not drift.
 */
export function stateDetails(entity: HomeAssistantEntity): string {
    const attrs = entity.attributes;
    const extras: string[] = [];
    if (typeof attrs.current_temperature === "number") {
        extras.push(`now ${attrs.current_temperature}${unitOf(attrs)}`);
    }
    if (typeof attrs.temperature === "number") {
        extras.push(`target ${attrs.temperature}${unitOf(attrs)}`);
    }
    if (typeof attrs.target_temp_high === "number") {
        extras.push(`high ${attrs.target_temp_high}${unitOf(attrs)}`);
    }
    if (typeof attrs.target_temp_low === "number") {
        extras.push(`low ${attrs.target_temp_low}${unitOf(attrs)}`);
    }
    // A bare `unit_of_measurement` is only informative when nothing above
    // carried the number it belongs to — printing it beside "now 20.5 °C" just
    // reads as noise. A plain sensor (temperature, power) needs it.
    if (extras.length === 0 && typeof attrs.unit_of_measurement === "string") {
        extras.push(attrs.unit_of_measurement);
    }
    // `percentage` wins over raw `brightness`: it is what the user set and is
    // already 0-100, whereas brightness needs scaling.
    if (typeof attrs.percentage === "number") {
        extras.push(`brightness ${Math.round(attrs.percentage)}%`);
    } else if (typeof attrs.brightness === "number") {
        extras.push(
            `brightness ${Math.round((attrs.brightness / 255) * 100)}%`,
        );
    }
    if (typeof attrs.battery_level === "number") {
        extras.push(`battery ${Math.round(attrs.battery_level)}%`);
    }
    return extras.length > 0 ? ` (${extras.join(", ")})` : "";
}

/** The entity's unit, with a leading space, or "" when it reports none. */
function unitOf(attrs: Readonly<Record<string, unknown>>): string {
    return typeof attrs.unit_of_measurement === "string"
        ? ` ${attrs.unit_of_measurement}`
        : "";
}

/**
 * Finds one entity by id or by friendly name (case-insensitive).
 *
 * Exported for tests. Exact id wins over an exact friendly-name match, which
 * wins over a prefix match — so "kitchen" finds "Kitchen Lamp" without letting
 * "Kitchen" collide with "Kitchen Sink" unless nothing else matched. Returns
 * `undefined` when nothing matched or when the name was ambiguous, because
 * guessing which of two devices the user meant is exactly the mistake this tool
 * must not make.
 */
export function findEntity(
    entities: readonly HomeAssistantEntity[],
    needle: string,
): HomeAssistantEntity | undefined {
    const wanted = needle.trim().toLowerCase();
    if (wanted === "") {
        return undefined;
    }
    const byId = entities.find((e) => e.entityId.toLowerCase() === wanted);
    if (byId) {
        return byId;
    }
    const exact = entities.filter(
        (e) => e.friendlyName.toLowerCase() === wanted,
    );
    if (exact.length === 1) {
        return exact[0];
    }
    if (exact.length > 1) {
        return undefined;
    }
    const partial = entities.filter((e) =>
        e.friendlyName.toLowerCase().includes(wanted),
    );
    return partial.length === 1 ? partial[0] : undefined;
}

/**
 * Filters entities by a free-text query over id and friendly name.
 *
 * Exported for tests. An empty query returns everything; the caller applies the
 * list ceiling.
 */
export function filterEntities(
    entities: readonly HomeAssistantEntity[],
    query: string | undefined,
): HomeAssistantEntity[] {
    const wanted = query?.trim().toLowerCase() ?? "";
    const matched = wanted
        ? entities.filter(
              (e) =>
                  e.entityId.toLowerCase().includes(wanted) ||
                  e.friendlyName.toLowerCase().includes(wanted),
          )
        : [...entities];
    return matched.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
}

/**
 * Builds the `homeAssistant` tool over the injected provider and quota.
 */
export function createHomeAssistantTool(deps: HomeAssistantDeps) {
    const controlDomains = new Set(
        deps.controlDomains.map((domain) => domain.trim().toLowerCase()),
    );

    return tool(
        async (
            {
                action,
                entity_id,
                query,
                value,
            }: {
                action: (typeof ACTIONS)[number];
                entity_id?: string;
                query?: string;
                value?: number;
            },
            runtime: ToolRuntime,
        ): Promise<string> => {
            const owner = runtime.configurable?.userId;
            if (typeof owner !== "number" || !Number.isInteger(owner)) {
                logger.warn("homeAssistant called without a user id");
                return SIGN_IN_REQUIRED;
            }
            const admission = deps.quota.tryAcquire(owner);
            if (!admission.ok) {
                const seconds = Math.max(
                    1,
                    Math.ceil(admission.retryAfterMs / 1000),
                );
                return `Home Assistant is rate limited — try again in about ${seconds}s.`;
            }
            const isWrite = WRITE_ACTIONS.has(action);
            logger.debug(
                `homeAssistant ${action} (${isWrite ? "write" : "read"})${
                    entity_id ? ` ${entity_id}` : ""
                }`,
            );

            try {
                const entities = await deps.provider.entities();

                if (action === "list") {
                    return renderList(entities, query, deps.listLimit);
                }

                if (NEEDS_ENTITY.has(action) && !entity_id?.trim()) {
                    return `The "${action}" action needs an \`entity_id\`. Use action "list" to see what is available, then pass the exact id (for example "light.kitchen").`;
                }

                const found = findEntity(entities, entity_id ?? "");
                if (!found) {
                    return ambiguousText(entities, entity_id ?? "");
                }

                if (!isWrite) {
                    return `homeAssistant ${action}: ${formatEntity(found)}`;
                }

                if (!controlDomains.has(found.domain)) {
                    logger.warn(
                        `homeAssistant refused a ${action} on out-of-scope domain ${found.domain}`,
                    );
                    return `${found.friendlyName} [${found.entityId}] is a ${found.domain} entity, which this server may read but not control. Do not claim it was changed; tell the user it is read-only here.`;
                }

                const requiredDomain = DOMAIN_FOR_ACTION[action];
                if (requiredDomain && found.domain !== requiredDomain) {
                    return `The "${action}" action only applies to ${requiredDomain}.* entities, and ${found.entityId} is a ${found.domain} entity.`;
                }

                if (requiredDomain && !Number.isFinite(value)) {
                    return `The "${action}" action needs a numeric \`value\`.`;
                }

                const result = await deps.provider.callService(
                    found.entityId,
                    SERVICE_FOR_ACTION[action],
                    value,
                );
                // The snapshot the validation just used is now stale.
                deps.provider.invalidate();
                const settled =
                    result.entities.find(
                        (e) => e.entityId === found.entityId,
                    ) ?? found;
                logger.info(
                    `homeAssistant ${action} on ${found.entityId} -> ${settled.state}`,
                );
                return `homeAssistant ${action}: ${pastTense(action)} ${settled.friendlyName} [${settled.entityId}]${valueNote(action, value, found)}. It is now ${settled.state}${stateDetails(settled)}.`;
            } catch (err) {
                return failureText(
                    err instanceof HomeAssistantError
                        ? err.message
                        : "unexpected error",
                );
            }
        },
        {
            name: "homeAssistant",
            description:
                "Read and control the user's Home Assistant instance: list " +
                "entities, read one entity's state, or turn lights, switches and " +
                "fans on/off, set light brightness, and set a thermostat's " +
                "target temperature. Call it for ANY question about the user's " +
                "home (devices, lights, thermostat, sensors) — never answer from " +
                "memory. Start with action 'list' (optionally with `query` like " +
                "'kitchen' or 'light') to learn the exact `entity_id`s; pass an " +
                "`entity_id` for every other action. Entity values are in the " +
                "instance's own unit — pass a number, never a unit string. " +
                "Confirm sweeping or ambiguous requests in words before acting " +
                "(e.g. 'turn everything off'), never guess a target, and answer " +
                "only what the user asked.",
            schema: z.object({
                action: z
                    .enum(ACTIONS)
                    .describe(
                        "'list' to see entities (optionally filtered by " +
                            "`query`), 'get' to read one entity, or a write: " +
                            "'turn_on', 'turn_off', 'toggle', " +
                            "'set_brightness' (light.*), 'set_temperature' " +
                            "(climate.*)",
                    ),
                entity_id: z
                    .string()
                    .optional()
                    .describe(
                        "Exact id from action 'list', e.g. 'light.kitchen'. " +
                            "Required for every action except 'list'",
                    ),
                query: z
                    .string()
                    .optional()
                    .describe(
                        "Action 'list' only: filter by name or domain " +
                            "substring, e.g. 'kitchen' or 'sensor'",
                    ),
                value: z
                    .number()
                    .optional()
                    .describe(
                        "set_brightness: 0-100. set_temperature: the target in " +
                            "the instance's unit. Omit for other actions",
                    ),
            }),
        },
    );
}

/**
 * Renders the `list` action, bounded so a large instance cannot flood context.
 *
 * Exported for tests. When matches are truncated the count of what was left out
 * is stated explicitly — the model must be able to tell "there are no more
 * lights" from "there are more than I showed you".
 */
export function renderList(
    entities: readonly HomeAssistantEntity[],
    query: string | undefined,
    limit: number,
): string {
    const matched = filterEntities(entities, query);
    if (matched.length === 0) {
        return query
            ? `homeAssistant list: nothing matches "${query}". Use action 'list' with no query to see everything available.`
            : "homeAssistant list: this instance has no entities this server may read.";
    }
    const shown = matched.slice(0, limit);
    const lines = shown.map((entity) => `- ${formatEntity(entity)}`);
    const omitted = matched.length - shown.length;
    const header = `homeAssistant list (${matched.length} match${matched.length === 1 ? "" : "es"}):`;
    return omitted > 0
        ? `${header}\n${lines.join("\n")}\n- …and ${omitted} more not shown; narrow with query.`
        : `${header}\n${lines.join("\n")}`;
}

/**
 * Model-facing text when a named entity could not be resolved to exactly one.
 *
 * Names the candidates rather than picking one, so the model can retry with an
 * exact id instead of guessing — and says so when nothing matched at all.
 */
function ambiguousText(
    entities: readonly HomeAssistantEntity[],
    needle: string,
): string {
    const wanted = needle.trim().toLowerCase();
    const close = filterEntities(entities, wanted).slice(0, 5);
    if (close.length === 0) {
        return `No entity matches "${needle}". Use action 'list' to see what is available, then pass an exact \`entity_id\`.`;
    }
    return `No single entity matches "${needle}" — ${close.length > 1 ? "several are close" : "one is close"}: ${close.map((e) => `${e.friendlyName} [${e.entityId}]`).join(", ")}. Retry with the exact \`entity_id\`.`;
}
