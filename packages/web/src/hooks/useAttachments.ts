/**
 * Composer attachment hook for the chat view (#10).
 *
 * Thin wiring over the pure `attachments.ts` lifecycle: owns the pending-chip
 * and in-session preview state, appends chips, and drives each through
 * {@link runChipUpload} with the real I/O (file read, downscale, upload POST).
 * The cap check deliberately reads the committed `pending` at call time — the
 * same semantics the view had inline, so a multi-file drop keeps its behavior.
 */
import { useCallback, useRef, useState } from "react";
import { MAX_ATTACHMENTS } from "@lukestanbery/jarvis-protocol";
import { api } from "../api";
import {
    capExceeded,
    readAsDataUrl,
    runChipUpload,
    type PendingImage,
    type UploadIo,
} from "../attachments";
import { prepareForUpload } from "../downscale/browser";

/** Real I/O for the attachment upload policy (`attachments.ts`). */
const uploadIo: UploadIo = {
    readDataUrl: readAsDataUrl,
    prepare: (file, budgetBytes) => prepareForUpload(file, budgetBytes),
    upload: (token, base64) => api.uploadAttachment(token, base64),
};

/** The public surface {@link useAttachments} returns. */
export interface UseAttachmentsResult {
    /** The composer's chips, through their upload lifecycle. */
    pending: PendingImage[];
    /** In-session previews: attachmentId → data: URL (not persisted). */
    previews: Record<string, string>;
    /** Attaches image files: prepare (downscale if needed), then upload. */
    attachFiles(files: FileList | File[]): void;
    /** Drops one pending chip. */
    detachChip(id: string): void;
    /** Clears all chips (send, or the active thread was deleted). */
    clearPending(): void;
}

/**
 * Owns the composer's attachment chips and previews.
 *
 * @param options.token - The bearer token for uploads.
 * @param options.onError - Shows a banner message (non-image, cap exceeded).
 * @returns The chips/previews and the attach/detach/clear mutators.
 */
export function useAttachments(options: {
    token: string;
    onError(message: string): void;
}): UseAttachmentsResult {
    const [pending, setPending] = useState<PendingImage[]>([]);
    const [previews, setPreviews] = useState<Record<string, string>>({});
    /** Latest props for the event-time and async upload closures. */
    const tokenRef = useRef(options.token);
    tokenRef.current = options.token;
    const onErrorRef = useRef(options.onError);
    onErrorRef.current = options.onError;
    /** The committed chips (the cap check's parity surface). */
    const pendingRef = useRef(pending);
    pendingRef.current = pending;

    const attachFiles = useCallback((files: FileList | File[]): void => {
        for (const file of Array.from(files)) {
            if (!file.type.startsWith("image/")) {
                onErrorRef.current(`${file.name} is not an image`);
                continue;
            }
            if (capExceeded(pendingRef.current)) {
                onErrorRef.current(
                    `At most ${MAX_ATTACHMENTS} images per message`,
                );
                break;
            }
            const chip: PendingImage = {
                id: crypto.randomUUID(),
                name: file.name || "pasted image",
                dataUrl: "",
                state: { kind: "uploading" },
            };
            setPending((current) => [...current, chip]);
            void runChipUpload(uploadIo, tokenRef.current, chip, file).then(
                ({ chip: next, preview }) => {
                    setPending((current) =>
                        current.map((p) => (p.id === next.id ? next : p)),
                    );
                    if (preview !== undefined) {
                        setPreviews((prev) => ({
                            ...prev,
                            [preview.attachmentId]: preview.dataUrl,
                        }));
                    }
                },
            );
        }
    }, []);

    const detachChip = useCallback((chipId: string): void => {
        setPending((c) => c.filter((p) => p.id !== chipId));
    }, []);

    const clearPending = useCallback((): void => {
        setPending([]);
    }, []);

    return { pending, previews, attachFiles, detachChip, clearPending };
}
