/**
 * The Home Assistant REST client (#15).
 *
 * Two endpoints, hand-rolled `fetch` for the same reasons as the weather client:
 * full control over timeout and error shapes, zero new dependencies.
 *
 * - `GET /api/states` — every entity in the instance. A mature install has
 *   thousands, so the response is filtered to the deployment's readable domains
 *   and cached for a short TTL. Without the cache, one conversation turn would
 *   re-fetch and re-summarize the whole house on every call.
 * - `POST /api/services/<domain>/<service>` with `{ entity_id }` — the write
 *   path. Resolving is the whole of its result: Home Assistant answers with the
 *   affected entities' states as they stood *at dispatch*, which is not the
 *   outcome of the write (a `turn_off` routinely answers `on`), so the body is
 *   discarded rather than reported back as a post-action truth. The snapshot is
 *   dropped either way, so the next read re-fetches.
 *
 * The long-lived access token goes out as a `Bearer` header and nowhere else: it
 * is never logged, never part of a URL, and scrubbed out of any error text even
 * if Home Assistant echoes the header back in a body.
 */
import {
    HomeAssistantError,
    type HomeAssistantEntity,
    type HomeAssistantProvider,
} from "./types";
import { logger } from "../../../logger";

/** Options for {@link createHomeAssistantClient}. */
export interface HomeAssistantOptions {
    /** Base URL of the instance, without a trailing slash. */
    readonly url: string;
    /** The `HOME_ASSISTANT_ACCESS_TOKEN` secret; never logged or echoed. */
    readonly accessToken: string;
    /** Domains whose entities are exposed to the tool. */
    readonly readDomains: readonly string[];
    /** Wall-clock cap applied when the caller supplies no signal. */
    readonly timeoutMs: number;
    /** How long a fetched snapshot is reused. */
    readonly cacheTtlMs: number;
    /** Injectable for tests (defaults to global `fetch`). */
    readonly fetchImpl?: typeof fetch;
}

/**
 * Entity attributes worth carrying past the client boundary.
 *
 * Home Assistant reports a large, integration-specific attribute blob per
 * entity. Only the keys that change what the model would say are kept; the rest
 * is context bloat and occasionally holds identifiers nobody asked for.
 */
const KEPT_ATTRIBUTES = [
    "friendly_name",
    "unit_of_measurement",
    "device_class",
    "current_temperature",
    "temperature",
    "target_temp_high",
    "target_temp_low",
    "brightness",
    "percentage",
    "battery_level",
] as const;

/** Coerces an untrusted JSON string field, defaulting to "". */
function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/**
 * Extracts the domain from a `domain.object_id` entity id.
 *
 * Returns `undefined` when the id is not of that shape. The split alone is not
 * enough — `"kitchen".split(".")[0]` is truthy — so both halves must be present,
 * matching what {@link normalizeEntity} accepts on the read path.
 */
function entityDomain(entityId: string): string | undefined {
    // Home Assistant ids are `domain.object_id` with underscores in the object
    // id and never a second dot, so exactly one dot with both halves present is
    // the whole rule: it rejects "", "nodomain", ".leading" and "trailing.".
    const first = entityId.indexOf(".");
    if (first < 1 || first !== entityId.lastIndexOf(".")) {
        return undefined;
    }
    if (first === entityId.length - 1) {
        return undefined;
    }
    return entityId.slice(0, first);
}

/**
 * Normalizes one `/api/states` entry.
 *
 * Entries without a well-formed `entity_id` of the form `domain.object_id` are
 * dropped rather than half-parsed: everything downstream (validation, the
 * service endpoint, the model's answer) assumes that shape.
 */
function normalizeEntity(raw: unknown): HomeAssistantEntity | undefined {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }
    const source = raw as {
        entity_id?: unknown;
        state?: unknown;
        attributes?: unknown;
    };
    const entityId = asString(source.entity_id);
    const domain = entityDomain(entityId);
    if (domain === undefined) {
        return undefined;
    }
    const attributes: Record<string, unknown> = {};
    if (typeof source.attributes === "object" && source.attributes !== null) {
        for (const key of KEPT_ATTRIBUTES) {
            const value = (source.attributes as Record<string, unknown>)[key];
            if (value !== undefined && value !== null) {
                attributes[key] = value;
            }
        }
    }
    return {
        entityId,
        domain,
        state: asString(source.state),
        friendlyName: asString(attributes.friendly_name) || entityId,
        attributes,
    };
}

/**
 * Builds the Home Assistant client over the injected transport.
 *
 * The returned provider owns one cached snapshot: concurrent callers share it
 * (the in-flight promise is cached too, so a burst of calls makes one request),
 * and a write invalidates it.
 */
export function createHomeAssistantClient(
    opts: HomeAssistantOptions,
): HomeAssistantProvider {
    const readable = new Set(
        opts.readDomains.map((domain) => domain.trim().toLowerCase()),
    );
    let snapshot: {
        entities: readonly HomeAssistantEntity[];
        expiresAt: number;
    } | null = null;
    let inFlight: Promise<readonly HomeAssistantEntity[]> | null = null;

    const scrub = (text: string): string =>
        text.split(opts.accessToken).join("[redacted]").slice(0, 160);

    /**
     * Issues one authenticated request and parses the JSON body.
     *
     * Applies the timeout when the caller supplies no signal and maps
     * transport, HTTP, and JSON failures onto typed `HomeAssistantError`s. The
     * request line is logged without headers, so the token never reaches a log.
     *
     * `ignoreBody` asserts only that the status was 2xx: the write path needs
     * nothing from a response whose contents are discarded anyway, so a proxy
     * that rewrites or strips the body cannot turn a successful write into a
     * reported failure.
     */
    const request = async (
        path: string,
        init: { method: "GET" | "POST"; body?: unknown; ignoreBody?: boolean },
        signal?: AbortSignal,
    ): Promise<unknown> => {
        const effectiveSignal = signal ?? AbortSignal.timeout(opts.timeoutMs);
        logger.debug(
            `home assistant ${init.method} ${opts.url}${path} (${readable.size} readable domains)`,
        );
        let response: Response;
        try {
            response = await (opts.fetchImpl ?? fetch)(`${opts.url}${path}`, {
                method: init.method,
                signal: effectiveSignal,
                headers: {
                    Authorization: `Bearer ${opts.accessToken}`,
                    "Content-Type": "application/json",
                },
                ...(init.body === undefined
                    ? {}
                    : { body: JSON.stringify(init.body) }),
            });
        } catch (err) {
            throw new HomeAssistantError(
                `home assistant unreachable: ${
                    err instanceof Error ? err.message : "unknown error"
                }`,
            );
        }
        if (!response.ok) {
            // The body is untrusted and may echo the request, so it is scrubbed
            // of the token before it can reach a log line.
            let detail = "";
            try {
                detail = scrub(await response.text());
            } catch {
                detail = "";
            }
            throw new HomeAssistantError(
                `home assistant returned ${response.status}${
                    detail ? ` (${detail})` : ""
                }`,
            );
        }
        if (init.ignoreBody) {
            return undefined;
        }
        try {
            return await response.json();
        } catch {
            throw new HomeAssistantError(
                "home assistant returned invalid JSON",
            );
        }
    };

    return {
        name: "home-assistant",

        async entities(
            signal?: AbortSignal,
        ): Promise<readonly HomeAssistantEntity[]> {
            const now = Date.now();
            if (snapshot && snapshot.expiresAt > now) {
                logger.debug("home assistant entities served from cache");
                return snapshot.entities;
            }
            if (inFlight) {
                // A burst of calls in one turn must make one request.
                return inFlight;
            }
            inFlight = (async () => {
                const raw = await request(
                    "/api/states",
                    { method: "GET" },
                    signal,
                );
                if (!Array.isArray(raw)) {
                    throw new HomeAssistantError(
                        "home assistant returned an unexpected state payload",
                    );
                }
                const all = raw
                    .map(normalizeEntity)
                    .filter(
                        (entity): entity is HomeAssistantEntity =>
                            entity !== undefined,
                    );
                const exposed = all.filter((entity) =>
                    readable.has(entity.domain),
                );
                logger.debug(
                    `home assistant exposed ${exposed.length} of ${all.length} entities`,
                );
                snapshot = {
                    entities: exposed,
                    expiresAt: Date.now() + opts.cacheTtlMs,
                };
                return exposed;
            })();
            try {
                return await inFlight;
            } finally {
                inFlight = null;
            }
        },

        async callService(
            entityId: string,
            action: string,
            value?: number,
            signal?: AbortSignal,
        ): Promise<void> {
            const domain = entityDomain(entityId);
            if (!domain) {
                throw new HomeAssistantError(
                    `entity "${entityId}" is not a valid entity id`,
                );
            }
            const body: Record<string, unknown> = { entity_id: entityId };
            if (value !== undefined) {
                // Home Assistant's service payloads name the field per service
                // (`brightness_pct`, `temperature`); the tool owns that mapping.
                body[serviceValueField(action)] = value;
            }
            // A non-2xx throws here, so reaching the next line is the acceptance
            // signal. The body holds the entities' states as of dispatch —
            // pre-action, and therefore unreportable as an outcome — so it is
            // not read at all.
            await request(
                `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(action)}`,
                { method: "POST", body, ignoreBody: true },
                signal,
            );
            // The snapshot predates this write, so it must not survive it.
            snapshot = null;
        },

        invalidate(): void {
            if (snapshot) {
                logger.debug("home assistant snapshot invalidated");
            }
            snapshot = null;
        },
    };
}

/**
 * Maps a tool action to the service payload field carrying its value.
 *
 * Home Assistant's service schemas differ per action (`light.turn_on` takes
 * `brightness_pct`, `climate.set_temperature` takes `temperature`), so the
 * mapping is explicit rather than guessed from the action name.
 */
function serviceValueField(action: string): string {
    return action === "set_brightness" ? "brightness_pct" : "temperature";
}
