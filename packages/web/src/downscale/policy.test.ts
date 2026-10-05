import { describe, expect, it } from "vitest";
import {
    MAX_EDGE,
    LADDER_MAX_EDGES,
    LADDER_QUALITIES,
    isAllowedMime,
    planDownscale,
    ladderLength,
} from "./policy";

/** 4 MiB — the server's per-attachment cap. */
const BUDGET = 4 * 1024 * 1024;

describe("isAllowedMime", () => {
    it("accepts the sniffable image types", () => {
        for (const mime of [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
        ]) {
            expect(isAllowedMime(mime)).toBe(true);
        }
    });

    it("rejects everything else", () => {
        for (const mime of ["image/heic", "image/avif", "text/plain", ""]) {
            expect(isAllowedMime(mime)).toBe(false);
        }
    });
});

describe("planDownscale — passthrough", () => {
    it("uploads a small in-budget PNG byte-for-byte", () => {
        expect(
            planDownscale({
                sizeBytes: 300_000,
                mime: "image/png",
                width: 1920,
                height: 1080,
                budgetBytes: BUDGET,
            }),
        ).toEqual({ passthrough: true });
    });

    it("uploads a small JPEG byte-for-byte", () => {
        expect(
            planDownscale({
                sizeBytes: 1_500_000,
                mime: "image/jpeg",
                width: 2048,
                height: 1536,
                budgetBytes: BUDGET,
            }),
        ).toEqual({ passthrough: true });
    });

    it("re-encodes a small image only when dimensions exceed the clamp", () => {
        const plan = planDownscale({
            sizeBytes: 1000,
            mime: "image/png",
            width: 4096,
            height: 2048,
            budgetBytes: BUDGET,
        });
        expect(plan).toEqual({
            passthrough: false,
            maxEdge: 2048,
            mime: "image/png",
        });
    });
});

describe("planDownscale — re-encode targets", () => {
    it("keeps PNG sources lossless (PNG-as-PNG, per the Phase 0 decision)", () => {
        const plan = planDownscale({
            sizeBytes: 6 * 1024 * 1024, // over budget
            mime: "image/png",
            width: 3000,
            height: 2000,
            budgetBytes: BUDGET,
        });
        expect(plan).toEqual({
            passthrough: false,
            maxEdge: 2048,
            mime: "image/png",
        });
        expect("quality" in plan).toBe(false); // PNG has no quality knob
    });

    it("sends photos to JPEG q82", () => {
        expect(
            planDownscale({
                sizeBytes: 8 * 1024 * 1024,
                mime: "image/jpeg",
                width: 4000,
                height: 3000,
                budgetBytes: BUDGET,
            }),
        ).toEqual({
            passthrough: false,
            maxEdge: 2048,
            mime: "image/jpeg",
            quality: LADDER_QUALITIES[0],
        });
    });

    it("re-encodes disallowed types (gif/webp/heic) as JPEG", () => {
        for (const mime of ["image/gif", "image/webp", "image/heic"]) {
            const plan = planDownscale({
                sizeBytes: 100,
                mime,
                width: 100,
                height: 100,
                budgetBytes: BUDGET,
            });
            expect(plan).toMatchObject({
                passthrough: false,
                mime: "image/jpeg",
            });
        }
    });
});

describe("planDownscale — the budget ladder", () => {
    it("steps PNG sources down by pixels", () => {
        const mime = "image/png";
        const input = {
            sizeBytes: 6 * 1024 * 1024,
            mime,
            width: 3000,
            height: 2000,
            budgetBytes: BUDGET,
        };
        const edges = [0, 1, 2].map((rung) => planDownscale(input, rung));
        expect(edges.map((p) => ("maxEdge" in p ? p.maxEdge : null))).toEqual([
            ...LADDER_MAX_EDGES,
        ]);
        for (const p of edges) {
            expect(p).toMatchObject({ passthrough: false, mime: "image/png" });
        }
    });

    it("steps photos down by quality, holding the edge clamp", () => {
        const mime = "image/jpeg";
        const input = {
            sizeBytes: 8 * 1024 * 1024,
            mime,
            width: 4000,
            height: 3000,
            budgetBytes: BUDGET,
        };
        const plans = [0, 1, 2].map((rung) => planDownscale(input, rung));
        expect(plans.map((p) => ("quality" in p ? p.quality : null))).toEqual([
            ...LADDER_QUALITIES,
        ]);
        for (const p of plans) {
            expect(p).toMatchObject({
                passthrough: false,
                mime: "image/jpeg",
                maxEdge: MAX_EDGE,
            });
        }
    });

    it("clamps at the last rung instead of throwing", () => {
        const plan = planDownscale(
            {
                sizeBytes: 9 * 1024 * 1024,
                mime: "image/jpeg",
                width: 5000,
                height: 5000,
                budgetBytes: BUDGET,
            },
            99, // far past the ladder
        );
        expect(plan).toMatchObject({
            quality: LADDER_QUALITIES[LADDER_QUALITIES.length - 1],
        });
    });

    it("reports the ladder length per source type", () => {
        expect(ladderLength("image/png")).toBe(LADDER_MAX_EDGES.length);
        expect(ladderLength("image/jpeg")).toBe(LADDER_QUALITIES.length);
    });
});
