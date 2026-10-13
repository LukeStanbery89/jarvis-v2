/**
 * Unit tests for the pure attachment upload lifecycle: the one-stricter 413
 * retry, preview fallback, terminal states, and the chip helpers. All I/O is a
 * scripted fake, so no network or DOM is involved.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENTS } from "@lukestanbery/jarvis-protocol";
import {
    capExceeded,
    determineReady,
    isRetryableLimit,
    runChipUpload,
    type PendingImage,
    type UploadIo,
} from "./attachments";

/** The policy never inspects file bytes; a marker stands in for the file. */
const FILE = {} as File;

/** The 413 the upload endpoint throws for a too-large payload. */
const limit = {
    status: 413 as const,
    code: "ATTACHMENT_TOO_LARGE" as const,
    maxBytes: 1000,
};

/** A fresh uploading chip. */
function chip(id = "c1"): PendingImage {
    return { id, name: "a.png", dataUrl: "", state: { kind: "uploading" } };
}

/** A fully-successful I/O double; override the seam under test. */
function io(over: Partial<UploadIo> = {}): UploadIo {
    return {
        readDataUrl: async () => "data:raw",
        prepare: async () => ({ mime: "image/png", base64: "AAA" }),
        upload: async () => ({ attachmentId: "att1" }),
        ...over,
    };
}

describe("runChipUpload", () => {
    it("marks the chip ready and returns the prepared preview on success", async () => {
        const result = await runChipUpload(io(), "tok", chip(), FILE);
        expect(result.chip.state).toEqual({
            kind: "ready",
            attachmentId: "att1",
        });
        expect(result.chip.dataUrl).toBe("data:raw");
        expect(result.preview).toEqual({
            attachmentId: "att1",
            dataUrl: "data:image/png;base64,AAA",
        });
    });

    it("falls back to the prepared preview when the raw read yields empty", async () => {
        const result = await runChipUpload(
            io({ readDataUrl: async () => "" }),
            "tok",
            chip(),
            FILE,
        );
        expect(result.chip.dataUrl).toBe("data:image/png;base64,AAA");
    });

    it("survives a raw read failure and still uploads", async () => {
        const result = await runChipUpload(
            io({
                readDataUrl: async () => {
                    throw new Error("read failed");
                },
            }),
            "tok",
            chip(),
            FILE,
        );
        expect(result.chip.state.kind).toBe("ready");
        expect(result.chip.dataUrl).toBe("data:image/png;base64,AAA");
    });

    it("retries once at half the reported cap on a 413, then succeeds", async () => {
        const prepare = vi.fn(async (_file: File, _budgetBytes: number) => ({
            mime: "image/jpeg",
            base64: "retry",
        }));
        let calls = 0;
        const upload = vi.fn(async () => {
            calls += 1;
            if (calls === 1) {
                throw limit;
            }
            return { attachmentId: "att2" };
        });
        const result = await runChipUpload(
            io({ prepare, upload }),
            "tok",
            chip(),
            FILE,
            4000,
        );
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(prepare).toHaveBeenNthCalledWith(1, FILE, 4000);
        expect(prepare).toHaveBeenNthCalledWith(2, FILE, 500);
        expect(result.chip.state).toEqual({
            kind: "ready",
            attachmentId: "att2",
        });
        expect(result.preview?.dataUrl).toBe("data:image/jpeg;base64,retry");
    });

    it("marks the chip failed with the message on a non-413 rejection", async () => {
        const result = await runChipUpload(
            io({
                upload: async () => {
                    throw new Error("boom");
                },
            }),
            "tok",
            chip(),
            FILE,
        );
        expect(result.chip.state).toEqual({
            kind: "failed",
            reason: "boom",
        });
        expect(result.preview).toBeUndefined();
    });

    it("marks the chip failed when the retry also 413s", async () => {
        const result = await runChipUpload(
            io({
                upload: async () => {
                    throw limit;
                },
            }),
            "tok",
            chip(),
            FILE,
        );
        expect(result.chip.state.kind).toBe("failed");
    });
});

describe("determineReady", () => {
    it("returns ready ids in pending order, skipping others", () => {
        const pending: PendingImage[] = [
            {
                id: "a",
                name: "a",
                dataUrl: "",
                state: { kind: "ready", attachmentId: "1" },
            },
            { id: "b", name: "b", dataUrl: "", state: { kind: "uploading" } },
            {
                id: "c",
                name: "c",
                dataUrl: "",
                state: { kind: "ready", attachmentId: "2" },
            },
            {
                id: "d",
                name: "d",
                dataUrl: "",
                state: { kind: "failed", reason: "x" },
            },
        ];
        expect(determineReady(pending)).toEqual(["1", "2"]);
    });
});

describe("capExceeded", () => {
    it("is false below the cap and true at it", () => {
        const make = (count: number): PendingImage[] =>
            Array.from({ length: count }, (_, i) => ({
                id: String(i),
                name: "x",
                dataUrl: "",
                state: { kind: "uploading" as const },
            }));
        expect(capExceeded(make(MAX_ATTACHMENTS - 1))).toBe(false);
        expect(capExceeded(make(MAX_ATTACHMENTS))).toBe(true);
    });
});

describe("isRetryableLimit", () => {
    it("accepts the 413 code and rejects everything else", () => {
        expect(isRetryableLimit(limit)).toBe(true);
        expect(isRetryableLimit(new Error("x"))).toBe(false);
        expect(isRetryableLimit({ status: 413 })).toBe(false);
        expect(isRetryableLimit(null)).toBe(false);
    });
});
