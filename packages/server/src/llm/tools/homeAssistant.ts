/**
 * The `homeAssistant` tool (#15): the agent's window onto the user's house.
 *
 * One tool with an `action` argument, so the model picks an intent rather than
 * choosing between tool names. Actions split into reads (`list`, `lights`,
 * `switches`, `get`) and writes (`turn_on`, `turn_off`, `toggle`,
 * `set_brightness`, `set_temperature`); the read and write paths are
 * deliberately different in what they are allowed to touch (see
 * `controlDomains` below).
 *
 * `lights` and `switches` exist because a light is not a domain on every
 * instance — a great many are modeled as `switch.*` — and no field in the REST
 * payload marks one. Rather than making a 4B model derive that category from a
 * raw list (and give up after one query that matched nothing), the category is
 * computed here: `lights` is domain-plus-name-token, `switches` is the plain
 * domain with shadow children dropped. Both are honest about being best-effort,
 * and every read reports how much of the house it actually saw.
 *
 * **Nothing is written that was not validated first.** Every control action
 * resolves `entity_id` against the instance's domain-filtered snapshot before a
 * service call goes out, so a typo, a hallucinated id, or an out-of-scope entity
 * is refused in model-facing prose instead of being sent to the house; an entity
 * reading `unavailable` or `unknown` is refused for the same reason — Home
 * Assistant acknowledging a command it cannot deliver is not a change. The
 * control domain list is a strict subset of the read list, which is how
 * `lock.*`, `cover.*`, `button.*`, `scene.*` and `script.*` stay readable but
 * unwritable — arming a lock from a model turn is a different risk class than
 * reading its state, and gets its own issue.
 *
 * Writes execute immediately and are reported as **accepted, never verified**:
 * Home Assistant's service response carries the entities' states as of
 * dispatch (a `turn_off` routinely answers `on`), so that body is discarded and
 * the tool states only the action and that it was accepted — the model is told
 * to use action `get` when it needs current state. The tool description tells
 * the model to confirm an ambiguous or sweeping ask in words first, and never
 * to guess a target; every write is logged at info as an audit trail of what
 * the assistant did.
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
    /** Name fragments that make a light a light to `action: "lights"`. */
    lightTokens: readonly string[];
}

/** The actions the model can ask for. */
const ACTIONS = [
    "list",
    "lights",
    "switches",
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
 * Exported for tests. Read actions (`get`, `list`) are the only reporters of
 * state, so this must stay in step with {@link formatEntity}.
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
 * Orders entities the way every read action presents them: by friendly name,
 * so the model sees a house in A-Z order rather than Home Assistant's registry
 * order (which shifts whenever a device is added).
 */
function byFriendlyName(
    a: HomeAssistantEntity,
    b: HomeAssistantEntity,
): number {
    return a.friendlyName.localeCompare(b.friendlyName);
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
    return matched.sort(byFriendlyName);
}

/**
 * Suffix integrations use for the shadow entity they create beside a real one
 * (`switch.bedroom_lights` plus `switch.bedroom_lights_led`).
 *
 * Both discovery actions drop these: they are a second handle on the same
 * fixture, so listing them doubles the apparent device count and buries the
 * entity the user actually means. Ids are lowercase on every Home Assistant
 * instance, but the comparison lowercases anyway rather than lean on that.
 */
const SHADOW_ENTITY_SUFFIX = "_led";

/**
 * Domains in which `action: "lights"` looks for lights.
 *
 * `light` for instances that model them natively, `switch` for the very common
 * installations that do not — on the requester's instance every light is a
 * switch and the `light` domain is empty, so filtering on `light` alone would
 * report zero lights while four sat in plain sight.
 */
const LIGHTLIKE_DOMAINS: ReadonlySet<string> = new Set(["light", "switch"]);

/**
 * Reports whether an entity reads as a light, given the configured name
 * fragments.
 *
 * Exported for tests. Two filters, both load-bearing: the domain filter keeps
 * a 3D printer out of the list, and the shadow suffix keeps the LED child of
 * every light out of it. Matching the id *and* the friendly name means a device
 * called "Luke's Office Lamp" qualifies even though its id is `switch.…`.
 * Best-effort by construction — a light named only "Kitchen" will be missed —
 * which is why the result says so and points the model at `list`.
 */
export function isLightLike(
    entity: HomeAssistantEntity,
    tokens: readonly string[],
): boolean {
    const id = entity.entityId.toLowerCase();
    if (id.endsWith(SHADOW_ENTITY_SUFFIX)) {
        return false;
    }
    if (!LIGHTLIKE_DOMAINS.has(entity.domain)) {
        return false;
    }
    const haystack = `${id} ${entity.friendlyName.toLowerCase()}`;
    return tokens.some((token) => token !== "" && haystack.includes(token));
}

/**
 * Reports whether an entity is a plainly-listable switch: the `switch` domain
 * minus the shadow children.
 *
 * Exported for tests. Deliberately not filtered by name — the point is the
 * domain itself, so a 3D printer belongs here even though `lights` excludes it.
 * The two actions overlap by design: a light modeled as a switch appears in
 * both.
 */
export function isSwitchLike(entity: HomeAssistantEntity): boolean {
    return (
        entity.domain === "switch" &&
        !entity.entityId.toLowerCase().endsWith(SHADOW_ENTITY_SUFFIX)
    );
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
                if (action === "lights") {
                    return renderLights(
                        entities,
                        deps.lightTokens,
                        deps.listLimit,
                    );
                }
                if (action === "switches") {
                    return renderSwitches(entities, deps.listLimit);
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

                if (
                    found.state === "unavailable" ||
                    found.state === "unknown"
                ) {
                    return `${found.friendlyName} [${found.entityId}] currently reads "${found.state}", so Home Assistant will not act on it. Do not claim a change; tell the user the device reads ${found.state}.`;
                }

                // Resolving is the whole result: HA's response body reports the
                // states as of dispatch, not as of completion, so reporting it
                // would hand the model a contradiction ("turned off, and it is
                // on"). Nothing after this line may assert a post-write state.
                await deps.provider.callService(
                    found.entityId,
                    SERVICE_FOR_ACTION[action],
                    value,
                );
                // The snapshot the validation just used is now stale.
                deps.provider.invalidate();
                logger.info(
                    `homeAssistant ${action} accepted on ${found.entityId} (was ${found.state})`,
                );
                return `homeAssistant ${action}: ${pastTense(action)} ${found.friendlyName} [${found.entityId}]${valueNote(action, value, found)}; Home Assistant accepted the request.`;
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
                "Read and control the user's Home Assistant instance: find " +
                "the lights or switches, list entities, read one entity's " +
                "state, or turn lights, switches and fans on/off, set light " +
                "brightness, and set a thermostat's target temperature. " +
                "Call it for ANY question about the user's home (devices, " +
                "lights, thermostat, sensors) — never answer from memory. " +
                "'What lights do I have' → action 'lights'; 'what switches' " +
                "→ action 'switches'; anything else starts with action 'list' " +
                "(optionally with `query` like 'kitchen' or 'sensor' — `query` " +
                "matches the entity_id as well as the name) to learn the exact " +
                "`entity_id`s; pass an `entity_id` for every other action. " +
                "Before concluding that a device or a whole category does not " +
                "exist, search again in this turn — a result from an earlier " +
                "turn, or one query that matched nothing, only proves that " +
                "search found nothing, not that the device is absent. A " +
                "successful write means Home Assistant accepted the request, " +
                "not that the device changed state — its own state may lag, so " +
                "use action 'get' before reporting the current state rather " +
                "than assuming it. Entity values are in the " +
                "instance's own unit — pass a number, never a unit string. " +
                "Confirm sweeping or ambiguous requests in words before acting " +
                "(e.g. 'turn everything off'), never guess a target, and answer " +
                "only what the user asked.",
            schema: z.object({
                action: z
                    .enum(ACTIONS)
                    .describe(
                        "'list' to see entities (optionally filtered by " +
                            "`query`), 'lights' for the lights, 'switches' for " +
                            "the switches, 'get' to read one entity, or a " +
                            "write: 'turn_on', 'turn_off', 'toggle', " +
                            "'set_brightness' (light.*), 'set_temperature' " +
                            "(climate.*)",
                    ),
                entity_id: z
                    .string()
                    .optional()
                    .describe(
                        "Exact id from action 'list', e.g. 'light.kitchen'. " +
                            "Required for every action except 'list', " +
                            "'lights' and 'switches'",
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
 * Renders one read action's entity lines beneath the caller's scope sentence,
 * bounded so a large instance cannot flood context.
 *
 * Exported for tests. When the list ceiling truncates, the count of what was
 * left out is stated explicitly — the model must be able to tell "there are no
 * more lights" from "there are more than I showed you".
 */
export function renderEntities(
    matched: readonly HomeAssistantEntity[],
    scope: string,
    limit: number,
    overflowHint: string,
): string {
    if (matched.length === 0) {
        return scope;
    }
    const shown = matched.slice(0, limit);
    const lines = shown.map((entity) => `- ${formatEntity(entity)}`);
    const omitted = matched.length - shown.length;
    return omitted > 0
        ? `${scope}\n${lines.join("\n")}\n- …and ${omitted} more not shown; ${overflowHint}`
        : `${scope}\n${lines.join("\n")}`;
}

/**
 * Renders the `list` action.
 *
 * Exported for tests. The header always states the denominator — "9 of 89
 * readable entities" — because a filtered list that reads like the whole house
 * is how the model concludes a device does not exist when it merely did not
 * match.
 */
export function renderList(
    entities: readonly HomeAssistantEntity[],
    query: string | undefined,
    limit: number,
): string {
    const total = entities.length;
    if (total === 0) {
        return "homeAssistant list: this instance has no entities this server may read.";
    }
    const matched = filterEntities(entities, query);
    if (matched.length === 0) {
        return `homeAssistant list: nothing matches "${query}" (0 of ${total} readable entities). Use action 'list' with no query to see everything available.`;
    }
    const scope = query
        ? `homeAssistant list: ${matched.length} of ${total} readable entities, filtered by "${query}":`
        : `homeAssistant list: ${total} of ${total} readable entities:`;
    return renderEntities(matched, scope, limit, "narrow with query.");
}

/**
 * Renders the `lights` action — the discovery pass for a category that is not
 * a domain on most instances.
 *
 * Exported for tests. The header names the basis it matched on and calls itself
 * best-effort, and the empty case says a device may be missing rather than that
 * there are no lights: quiet absence is the failure this action exists to
 * prevent.
 */
export function renderLights(
    entities: readonly HomeAssistantEntity[],
    tokens: readonly string[],
    limit: number,
): string {
    const total = entities.length;
    const basis =
        tokens.length > 0
            ? `Best-effort match — domains light and switch, name containing ${tokens.join(", ")}, excluding ${SHADOW_ENTITY_SUFFIX} children.`
            : `No name fragments are configured (JARVIS_HA_LIGHT_TOKENS is empty), so nothing can match. Set it to enable this action.`;
    const matched = entities
        .filter((entity) => isLightLike(entity, tokens))
        .sort(byFriendlyName);
    if (matched.length === 0) {
        // With tokens configured an empty answer is a heuristic miss, so it
        // says so; without them nothing was ever going to match, and blaming
        // the house for a configuration gap would be a lie.
        const advice =
            tokens.length > 0
                ? "A device with an unrelated name may be missing; call action 'list' to see everything."
                : "Call action 'list' to see everything.";
        return `homeAssistant lights: 0 of ${total} readable entities matched. ${basis} ${advice}`;
    }
    const scope = `homeAssistant lights: ${matched.length} of ${total} readable entities. ${basis} A device with an unrelated name may be missing; call action 'list' to search.`;
    return renderEntities(
        matched,
        scope,
        limit,
        "use action 'list' to search.",
    );
}

/**
 * Renders the `switches` action — the whole `switch` domain, minus shadow
 * children.
 *
 * Exported for tests. Reports the same denominator as the other reads; unlike
 * `lights` it claims no interpretation, because the domain is the definition.
 */
export function renderSwitches(
    entities: readonly HomeAssistantEntity[],
    limit: number,
): string {
    const total = entities.length;
    const basis = `Domain switch, excluding ${SHADOW_ENTITY_SUFFIX} children.`;
    const matched = entities.filter(isSwitchLike).sort(byFriendlyName);
    if (matched.length === 0) {
        return `homeAssistant switches: 0 of ${total} readable entities. ${basis} This instance has no switches this server may read.`;
    }
    const scope = `homeAssistant switches: ${matched.length} of ${total} readable entities. ${basis}`;
    return renderEntities(
        matched,
        scope,
        limit,
        "use action 'list' to search.",
    );
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
