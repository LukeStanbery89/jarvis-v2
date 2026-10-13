/**
 * Pure upload lifecycle for the composer's image attachments (#10).
 *
 * Kept out of the chat component so the retry policy is node-testable:
 * {@link runChipUpload} drives one chip through preview → downscale → upload,
 * with a single stricter retry when the server rejects the prepared bytes with
 * a 413 (`ATTACHMENT_TOO_LARGE`), and always lands the chip in a terminal
 * `ready`/`failed` state. All real I/O (file reading, downscale/encode, the
 * upload POST) is injected via {@link UploadIo}, so tests use a scripted fake
 * and no network or DOM is required.
 */
import { MAX_ATTACHMENTS } from "@lukestanbery/jarvis-protocol";

/**
 * The upload budget the downscale policy plans against, in bytes.
 *
 * Mirrors the server's per-attachment cap (`DEFAULT_ATTACHMENT_MAX_BYTES`,
 * 4 MiB decoded). There is no endpoint exposing the cap, so the two constants
 * must stay in sync; a drifted server answer surfaces as a 413 and the send
 * path retries once with a stricter budget, so drift degrades gracefully.
 */
export const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024;

/** One image attached to the composer, through its upload lifecycle. */
export interface PendingImage {
    /** Local chip id (not the server attachment id). */
    id: string;
    name: string;
    /** `data:` preview (R6 — not `blob:`, no revoke bookkeeping). */
    dataUrl: string;
    /** Upload state: in flight, resolved id, or failure text. */
    state:
        | { kind: "uploading" }
        | { kind: "ready"; attachmentId: string }
        | { kind: "failed"; reason: string };
}

/** True when `pending` already holds the maximum number of images. */
export function capExceeded(pending: PendingImage[]): boolean {
    return pending.length >= MAX_ATTACHMENTS;
}

/**
 * The ready attachment ids a prompt references, in pending order.
 *
 * @param pending - The composer's current chips.
 * @returns Server attachment ids for chips whose upload resolved.
 */
export function determineReady(pending: PendingImage[]): string[] {
    const ids: string[] = [];
    for (const chip of pending) {
        if (chip.state.kind === "ready") {
            ids.push(chip.state.attachmentId);
        }
    }
    return ids;
}

/**
 * The server's retryable size rejection: a 413 carrying
 * `code: "ATTACHMENT_TOO_LARGE"` and the cap it enforced.
 */
export interface UploadLimitError {
    status: 413;
    code: "ATTACHMENT_TOO_LARGE";
    /** The cap the server reported, in bytes. */
    maxBytes?: number;
}

/**
 * Narrows an unknown upload failure to {@link UploadLimitError}.
 *
 * @param err - The caught value.
 * @returns Whether `err` is the retryable 413 from the upload endpoint.
 */
export function isRetryableLimit(err: unknown): err is UploadLimitError {
    return (
        typeof err === "object" &&
        err !== null &&
        (err as { status?: unknown }).status === 413 &&
        (err as { code?: unknown }).code === "ATTACHMENT_TOO_LARGE"
    );
}

/** The injected I/O seams {@link runChipUpload} drives. */
export interface UploadIo {
    /** `data:` preview for the chip ("" for files too large to preview raw). */
    readDataUrl(file: File): Promise<string>;
    /** Downscale/re-encode `file` to fit `budgetBytes`. */
    prepare(
        file: File,
        budgetBytes: number,
    ): Promise<{ mime: string; base64: string }>;
    /** POST the prepared bytes; a size rejection rejects with {@link UploadLimitError}. */
    upload(token: string, base64: string): Promise<{ attachmentId: string }>;
}

/** The terminal outcome of one chip's upload. */
export interface ChipUploadResult {
    /** The chip in its final state (preview filled in). */
    chip: PendingImage;
    /** The transcript preview to record, when the upload succeeded. */
    preview?: { attachmentId: string; dataUrl: string };
}

/**
 * Runs one chip's lifecycle, resolving to its terminal state.
 *
 * Reads the raw preview (a read failure degrades to ""), downscales under
 * `budgetBytes`, uploads, and — when the upload is rejected with a retryable
 * 413 — re-prepares once at half the reported cap before a second attempt. Any
 * terminal failure (a non-413 rejection, a second 413, a prepare error) lands
 * the chip in `failed` with the error's message.
 *
 * @param io - The injected I/O seams.
 * @param token - The bearer token for the upload.
 * @param chip - The chip being uploaded (its `dataUrl`/`state` are replaced).
 * @param file - The raw file behind the chip.
 * @param budgetBytes - The downscale budget for the first attempt.
 * @returns The final chip plus the preview to record on success.
 */
export async function runChipUpload(
    io: UploadIo,
    token: string,
    chip: PendingImage,
    file: File,
    budgetBytes: number = UPLOAD_BUDGET_BYTES,
): Promise<ChipUploadResult> {
    const dataUrl = await io.readDataUrl(file).catch(() => "");
    const withPreview: PendingImage = { ...chip, dataUrl };
    try {
        let prepared = await io.prepare(file, budgetBytes);
        let uploaded: { attachmentId: string };
        try {
            uploaded = await io.upload(token, prepared.base64);
        } catch (err) {
            if (!isRetryableLimit(err)) {
                throw err;
            }
            // One retry at half the reported cap — the "stricter budget"
            // rung for a file that slipped past the client-side policy.
            prepared = await io.prepare(
                file,
                Math.floor((err.maxBytes ?? budgetBytes) / 2),
            );
            uploaded = await io.upload(token, prepared.base64);
        }
        // The preview comes from the PREPARED bytes — always available
        // post-downscale. The raw file's data URL is "" for >4 MB files
        // (too big to preview raw), which would otherwise surface as the
        // missing-preview note on a fresh upload.
        const previewUrl = `data:${prepared.mime};base64,${prepared.base64}`;
        return {
            chip: {
                ...withPreview,
                dataUrl:
                    withPreview.dataUrl === ""
                        ? previewUrl
                        : withPreview.dataUrl,
                state: { kind: "ready", attachmentId: uploaded.attachmentId },
            },
            preview: {
                attachmentId: uploaded.attachmentId,
                dataUrl: previewUrl,
            },
        };
    } catch (err) {
        return {
            chip: {
                ...withPreview,
                state: {
                    kind: "failed",
                    reason:
                        err instanceof Error ? err.message : "upload failed",
                },
            },
        };
    }
}

/**
 * Reads a file as a `data:` URL for its composer chip.
 *
 * Files over the upload budget resolve to "" — too big to preview raw, so the
 * chip shows a note until the prepared-bytes preview lands.
 *
 * @param file - The raw file to preview.
 * @returns The `data:` URL, or "" when the file is too large to preview raw.
 */
export async function readAsDataUrl(file: File): Promise<string> {
    if (file.size > UPLOAD_BUDGET_BYTES) {
        return "";
    }
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(file);
    });
}
