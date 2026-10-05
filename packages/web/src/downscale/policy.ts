/**
 * The attachment downscale policy (#10) — pure, browser-free.
 *
 * Decides whether an image may upload byte-for-byte or must be re-encoded,
 * and at which ladder rung. Kept free of DOM types so the whole budget
 * contract is unit-testable in bare Node (`vitest.config.ts` only runs
 * `.test.ts` in the `node` environment — there is no jsdom here), with
 * `downscale/browser.ts` as the thin adapter that decodes/encodes whatever
 * this module decides.
 *
 * The rules, from the plan's decisions table:
 * - **Passthrough** when the file is already an allowed type, within the
 *   byte budget, and at most {@link MAX_EDGE} on its longest side. Small
 *   valid images upload byte-for-byte — no CPU cost, no quality loss.
 * - Otherwise re-encode: **PNG sources stay PNG** (lossless — glyphs stay
 *   crisp; the Phase 0 probe ruled WebP out of the VL runtime, and the
 *   measured sizes — ~0.03 MB for a 2048px text screenshot — removed the
 *   size objection). **Photos go JPEG** at q82. GIF/WebP sources re-encode
 *   as JPEG (they are "wrong type" by definition; a GIF's animation is
 *   dropped — acceptable for an analysis surface).
 * - When a re-encode still exceeds the budget, the caller steps up the
 *   **ladder** by calling this with `rung` incremented: PNG sources lose
 *   pixels ({@link LADDER_MAX_EDGES}), photos lose quality
 *   ({@link LADDER_QUALITIES} — and keep clamping at {@link MAX_EDGE}).
 */
/** Longest edge (px) a downscale may emit — above what a VL encoder consumes. */
export const MAX_EDGE = 2048;

/** Longest-edge rungs for PNG sources, stepped when still over budget. */
export const LADDER_MAX_EDGES = [2048, 1536, 1024] as const;

/** JPEG quality rungs for photo sources, stepped when still over budget. */
export const LADDER_QUALITIES = [82, 60, 45] as const;

/** Mime types the server's magic-byte sniff accepts for upload. */
export const ALLOWED_MIMES: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

/** Output mimes the re-encoder may emit. */
export type EncodedMime = "image/png" | "image/jpeg";

/** What the caller should do with an image, per {@link planDownscale}. */
export type DownscalePlan =
    /** Upload the original bytes untouched. */
    | { passthrough: true }
    /** Re-encode to `mime` at `quality` (JPEG only), clamped to `maxEdge`. */
    | {
          passthrough: false;
          maxEdge: number;
          mime: EncodedMime;
          quality?: number;
      };

/** Inputs to {@link planDownscale}. */
export interface PolicyInput {
    /** The file's byte size. */
    sizeBytes: number;
    /** The file's declared mime type. */
    mime: string;
    /** Decoded image width in px. */
    width: number;
    /** Decoded image height in px. */
    height: number;
    /** The upload budget in bytes (the server's per-attachment cap). */
    budgetBytes: number;
}

/** True when `mime` is one the server accepts for upload. */
export function isAllowedMime(mime: string): boolean {
    return ALLOWED_MIMES.has(mime);
}

/** True when the type is one the passthrough path may send untouched. */
function isPassthroughMime(mime: string): boolean {
    return mime === "image/png" || mime === "image/jpeg";
}

/** True when a PNG source re-encodes as PNG (lossless) rather than JPEG. */
function isLosslessSource(mime: string): boolean {
    return mime === "image/png";
}

/**
 * Decides the encoding plan for one image at one ladder rung.
 *
 * `rung` 0 is the first re-encode attempt; each step up trades resolution
 * (PNG sources) or quality (photos) for size. When the ladder is exhausted
 * the plan still emits its smallest rung — the caller reports the residual
 * failure ("still too large after downscaling") rather than this module
 * throwing, so a caller can surface its own message with the file's name.
 */
export function planDownscale(input: PolicyInput, rung = 0): DownscalePlan {
    if (
        rung === 0 &&
        input.sizeBytes <= input.budgetBytes &&
        isPassthroughMime(input.mime) &&
        input.width <= MAX_EDGE &&
        input.height <= MAX_EDGE
    ) {
        return { passthrough: true };
    }
    if (isLosslessSource(input.mime)) {
        const maxEdge =
            LADDER_MAX_EDGES[Math.min(rung, LADDER_MAX_EDGES.length - 1)];
        return { passthrough: false, maxEdge, mime: "image/png" };
    }
    const maxEdge = MAX_EDGE;
    const quality =
        LADDER_QUALITIES[Math.min(rung, LADDER_QUALITIES.length - 1)];
    return { passthrough: false, maxEdge, mime: "image/jpeg", quality };
}

/** The number of ladder rungs a source type walks before giving up. */
export function ladderLength(mime: string): number {
    return isLosslessSource(mime)
        ? LADDER_MAX_EDGES.length
        : LADDER_QUALITIES.length;
}
