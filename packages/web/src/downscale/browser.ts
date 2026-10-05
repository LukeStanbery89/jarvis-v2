/**
 * The browser half of the attachment pipeline (#10) — a thin adapter.
 *
 * Turns a picked/pasted/dropped `File` into upload-ready bytes by executing
 * whatever {@link planDownscale} decides: decode with `createImageBitmap`
 * (with `imageOrientation: "from-image"` so EXIF-rotated photos come in
 * upright), clamp to the planned edge on a canvas, and re-encode via
 * `canvas.toBlob`. All DOM/canvas work lives here and ONLY here — the policy
 * module stays pure, so its budget contract is tested in bare Node while
 * this file is exercised in the browser (`noUnusedLocals` is on: keep even
 * intentional stubs' bindings `_`-prefixed).
 *
 * Previews use `data:` URLs, not `blob:` (review finding R6) — the served
 * CSP's `img-src` allows `data:` but the pipeline is simpler and
 * revoke-timing-bug-free without object URLs.
 */
import {
    isAllowedMime,
    ladderLength,
    planDownscale,
    type DownscalePlan,
} from "./policy";

/** The upload-ready result of {@link prepareForUpload}. */
export interface PreparedImage {
    /** Bytes to upload (original or re-encoded). */
    blob: Blob;
    /** The bytes' type — what `data:` previews and upload logging should say. */
    mime: string;
    /** base64 of {@link PreparedImage.blob}, ready for the JSON upload body. */
    base64: string;
}

/**
 * Reads a blob as base64 (no `FileReader` event dance).
 */
async function blobToBase64(blob: Blob): Promise<string> {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** Draws a bitmap to a canvas clamped to `maxEdge` and encodes it. */
async function encodeClamped(
    bitmap: ImageBitmap,
    plan: DownscalePlan & { passthrough: false },
): Promise<Blob> {
    const scale = Math.min(
        1,
        plan.maxEdge / Math.max(bitmap.width, bitmap.height),
    );
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("canvas 2d context unavailable");
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, plan.mime, plan.quality),
    );
    if (!blob) {
        throw new Error(`canvas could not encode ${plan.mime}`);
    }
    return blob;
}

/**
 * Prepares one image file for upload under `budgetBytes`.
 *
 * Passthrough files come back untouched. Re-encoded files walk the plan's
 * ladder (pixel rungs for PNG sources, quality rungs for photos) until the
 * encoded bytes fit the budget; exhausting the ladder throws — the caller
 * surfaces the failure with the file's name rather than uploading oversize
 * bytes the server would only refuse.
 */
export async function prepareForUpload(
    file: File,
    budgetBytes: number,
): Promise<PreparedImage> {
    if (!isAllowedMime(file.type)) {
        throw new Error(
            `${file.name}: unsupported image type (${file.type || "unknown"})`,
        );
    }
    // Dimensions come from the real decoded size — measured even for
    // likely-passthrough files, because an in-budget but oversize image must
    // still be clamped (measuring is one decode; re-encoding is the CPU the
    // policy avoids).
    const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
    });
    try {
        const base = {
            sizeBytes: file.size,
            mime: file.type,
            width: bitmap.width,
            height: bitmap.height,
            budgetBytes,
        };
        const first = planDownscale(base, 0);
        if (first.passthrough) {
            return {
                blob: file,
                mime: file.type,
                base64: await blobToBase64(file),
            };
        }
        const rungs = ladderLength(file.type);
        let blob: Blob | null = null;
        for (let rung = 0; rung < rungs; rung += 1) {
            const step = planDownscale(base, rung);
            if (step.passthrough) {
                break;
            }
            blob = await encodeClamped(bitmap, step);
            if (blob.size <= budgetBytes) {
                return {
                    blob,
                    mime: step.mime,
                    base64: await blobToBase64(blob),
                };
            }
        }
        throw new Error(
            `${file.name}: still too large after downscaling (${blob?.size ?? 0} bytes)`,
        );
    } finally {
        bitmap.close();
    }
}
