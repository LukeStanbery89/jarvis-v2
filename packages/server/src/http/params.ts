/**
 * Query-parameter parsing for the REST routers.
 *
 * Both forms below exist because the contract validator runs with
 * `coerceTypes`, which rewrites `req.query` in place: by the time a handler
 * sees `limit` it is already a number and `includeSettled` already a boolean.
 * A guard written against the raw string form therefore ignored every real
 * request the spec advertises — the bug both of these were extracted to stop
 * repeating (`notify/http.ts` had one copy each, and the jobs routes needed the
 * same behaviour rather than a second reading of it).
 */

/**
 * Clamps a `limit` query parameter into a page's bounds.
 *
 * An absent, non-numeric, or non-positive value becomes `fallback`; anything
 * above `max` is clamped to it, so a caller cannot ask for an unbounded page.
 */
export function parseLimit(
    value: unknown,
    options: { fallback: number; max: number },
): number {
    const parsed =
        typeof value === "number"
            ? value
            : typeof value === "string" && value.length > 0
              ? Number(value)
              : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
        return options.fallback;
    }
    return Math.min(parsed, options.max);
}

/** Reads a boolean query parameter in either the coerced or the raw form. */
export function parseBoolean(value: unknown): boolean {
    return value === true || value === "true";
}
