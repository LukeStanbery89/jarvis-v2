/**
 * Home Assistant wire types (#15), normalized between the tool and the client.
 *
 * Same shape of seam as `tools/weather/types.ts` and `tools/search/types.ts`: the
 * tool talks in these terms and never sees HTTP, and the client never sees the
 * model. Home Assistant's `/api/states` payload is large and loosely typed, so
 * everything crossing this boundary is coerced to something trustworthy.
 */

/**
 * One entity's state as the tool needs it.
 *
 * `entityId` and `state` are the only required fields; `attributes` holds the
 * handful of keys worth showing the model (friendly name, unit, target
 * temperature, brightness). Everything else Home Assistant reports is dropped at
 * the client boundary rather than carried into a tool result.
 */
export interface HomeAssistantEntity {
    /** Domain-prefixed id, e.g. `light.kitchen`. */
    readonly entityId: string;
    /** The domain prefix of {@link entityId} (`light`). */
    readonly domain: string;
    /** Current state string: `on`, `off`, `unavailable`, a number, … */
    readonly state: string;
    /** Display name when the entity reports one, else the entity id. */
    readonly friendlyName: string;
    /** The attributes worth surfacing; empty when the entity reports none. */
    readonly attributes: Readonly<Record<string, unknown>>;
}

/** A configured Home Assistant the tool can call. */
export interface HomeAssistantProvider {
    /** Instance name for logs and model-facing error text. */
    readonly name: "home-assistant";
    /**
     * Entity states, filtered to the domains the deployment may read.
     *
     * Results are cached for the configured TTL and the cache is dropped after a
     * successful write, so a control call never validates against a snapshot
     * that predates it. Throws {@link HomeAssistantError} on transport or shape
     * failure — never with the access token in the message.
     */
    entities(signal?: AbortSignal): Promise<readonly HomeAssistantEntity[]>;
    /**
     * Calls one Home Assistant service (`light/turn_on`) for one entity.
     *
     * `value` carries the service's single payload argument (brightness,
     * temperature) when the action needs one. Returns nothing: Home Assistant
     * answers with the affected entities' states as they stood *at dispatch*,
     * which is not the outcome of the write and must never be reported as one
     * (see the client module doc). Resolving is the success signal — the tool
     * reports the accepted action and lets a later `entities()`/read report the
     * state. Throws {@link HomeAssistantError} on failure.
     */
    callService(
        entityId: string,
        action: string,
        value?: number,
        signal?: AbortSignal,
    ): Promise<void>;
    /** Drops the cached snapshot; called by the tool after a write. */
    invalidate(): void;
}

/** Why a Home Assistant call failed; drives the tool's model-facing text. */
export class HomeAssistantError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HomeAssistantError";
    }
}
