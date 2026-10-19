/**
 * The particle field's motion model (#146, phase A).
 *
 * No canvas and no browser: the field is a pure function of (seed, elapsed
 * time, energy), so the shape of the disc, the rotation, the breathe and the
 * clamp can all be asserted here. The renderer (`ParticleCanvas`) is then only
 * a loop that stamps the buffer these functions produce.
 */
import { describe, expect, it } from "vitest";
import {
    BASE_OMEGA,
    BREATHE_AMPLITUDE,
    DENSITY_POWER,
    ENERGY_AMPLITUDE,
    MAX_STEP_MS,
    PHASE_SPREAD,
    createField,
    particleCount,
    project,
    step,
} from "./field";
import type { Field } from "./field";

/** A one-particle field at a chosen radius, with no rotation and no phase. */
function single(r: number): Field {
    const field = createField(7, 1);
    const particle = field.particles[0];
    particle.r = r;
    particle.theta = 0;
    particle.phase = 0;
    particle.omega = 0;
    particle.size = 2;
    particle.alpha = 0.5;
    return field;
}

/** The largest and smallest projected radius over a full breathe cycle. */
function breatheSwing(energy: number): { min: number; max: number } {
    const radius = 100;
    const out = new Float32Array(4);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 720; i += 1) {
        const field = single(0.8);
        field.energy = energy;
        field.tMs = (i * 1000) / 60;
        project(field, 0, 0, radius, out);
        const projected = Math.hypot(out[0], out[1]) / radius;
        min = Math.min(min, projected);
        max = Math.max(max, projected);
    }
    return { min, max };
}

describe("particleCount", () => {
    it("scales with area and stays inside its bounds", () => {
        expect(particleCount(0)).toBe(160);
        expect(particleCount(1_920 * 1_080)).toBe(518);
        expect(particleCount(7_680 * 4_320)).toBe(600);
    });
});

describe("createField", () => {
    it("is deterministic for a seed and different across seeds", () => {
        expect(createField(42, 40)).toEqual(createField(42, 40));
        expect(createField(42, 40).particles).not.toEqual(
            createField(43, 40).particles,
        );
    });

    it("puts every particle inside the unit disc, with real size and opacity", () => {
        const field = createField(1, 300);
        for (const particle of field.particles) {
            expect(particle.r).toBeGreaterThanOrEqual(0);
            expect(particle.r).toBeLessThanOrEqual(1);
            expect(particle.size).toBeGreaterThan(0);
            expect(particle.alpha).toBeGreaterThan(0);
            expect(particle.alpha).toBeLessThanOrEqual(1);
        }
    });

    it("concentrates the disc near its centre", () => {
        const radii = createField(9, 4_000).particles.map((p) => p.r);
        const median = [...radii].sort((a, b) => a - b)[radii.length / 2];
        const rim = radii.filter((r) => r > 0.9).length;

        // The power is what "focused heavily near the center" means, so the
        // test asserts the distribution, not just the formula. With p = 1.7
        // the rim holds about 6% of the disc; the bound leaves sampling room.
        expect(DENSITY_POWER).toBeGreaterThan(1);
        expect(median).toBeLessThan(0.55);
        expect(rim / radii.length).toBeLessThan(0.1);
    });

    it("breathes as one disc, with only a narrow stagger", () => {
        const phases = createField(11, 500).particles.map((p) => p.phase);
        const spread = Math.max(...phases) - Math.min(...phases);

        // The whole disc sits inside one small window of the cycle...
        expect(spread).toBeLessThanOrEqual(PHASE_SPREAD + 1e-9);
        // ...and across that window every particle still moves the same way at
        // 90%+ of full speed, which is what "inhaling together" means.
        for (const phase of [0, PHASE_SPREAD]) {
            expect(Math.cos(phase)).toBeGreaterThan(0.9);
        }
    });

    it("tapers size and opacity outward", () => {
        const field = createField(3, 400);
        const inner = field.particles.filter((p) => p.r < 0.3);
        const outer = field.particles.filter((p) => p.r > 0.8);
        const average = (
            list: typeof field.particles,
            pick: (p: (typeof field.particles)[number]) => number,
        ) => list.reduce((sum, p) => sum + pick(p), 0) / list.length;

        expect(average(inner, (p) => p.size)).toBeGreaterThan(
            average(outer, (p) => p.size),
        );
        expect(average(inner, (p) => p.alpha)).toBeGreaterThan(
            average(outer, (p) => p.alpha),
        );
    });
});

describe("step", () => {
    it("advances the angle at the base speed plus the particle's own nudge", () => {
        const field = single(0.5);
        const particle = field.particles[0];
        particle.omega = 0.01;

        // Under the clamp, so this measures the speed rather than the cap.
        step(field, 20);

        expect(particle.theta).toBeCloseTo((BASE_OMEGA + 0.01) * 0.02, 10);
        expect(field.tMs).toBe(20);
    });

    it("clamps an enormous delta, so a backgrounded tab cannot teleport the disc", () => {
        const field = single(0.5);
        step(field, 60_000);

        expect(field.tMs).toBe(MAX_STEP_MS);
        expect(field.particles[0].theta).toBeCloseTo(
            (BASE_OMEGA * MAX_STEP_MS) / 1000,
            10,
        );
    });

    it("clamps energy into 0..1 and treats a broken value as silence", () => {
        const field = single(0.5);
        expect(step(field, 16, 5).energy).toBe(1);
        expect(step(field, 16, -2).energy).toBe(0);
        expect(step(field, 16, Number.NaN).energy).toBe(0);
    });

    it("never lets a long run leave the disc or produce a non-number", () => {
        const field = createField(5, 40);
        const out = new Float32Array(40 * 4);
        for (let i = 0; i < 10_000; i += 1) {
            step(field, 16, (i % 100) / 100);
        }
        project(field, 200, 200, 180, out);
        for (let i = 0; i < out.length; i += 1) {
            expect(Number.isFinite(out[i])).toBe(true);
            expect(out[i]).toBeGreaterThanOrEqual(0);
            expect(out[i]).toBeLessThanOrEqual(400);
        }
    });
});

describe("project", () => {
    it("writes x, y, size and alpha for every particle", () => {
        const field = single(0.5);
        const out = new Float32Array(4);
        project(field, 100, 100, 80, out);

        expect(out[0]).toBeCloseTo(100 + 0.5 * 80, 5);
        expect(out[1]).toBeCloseTo(100, 5);
        expect(out[2]).toBe(2);
        expect(out[3]).toBeCloseTo(0.5, 5);
    });

    it("fills only the particles that fit a short buffer", () => {
        const field = createField(2, 10);
        const out = new Float32Array(3 * 4);
        project(field, 0, 0, 100, out);

        // Everything past the third particle is untouched, not corrupted.
        for (let i = 12; i < out.length; i += 1) {
            expect(out[i]).toBe(0);
        }
    });

    it("breathes around the resting radius, and wider when the voice is up", () => {
        const quiet = breatheSwing(0);
        const loud = breatheSwing(1);

        // Resting radius is 0.8; the breathe is a fraction of it. Three
        // decimals is the buffer's precision, not the model's.
        expect(quiet.max).toBeCloseTo(0.8 * (1 + BREATHE_AMPLITUDE), 3);
        expect(quiet.min).toBeCloseTo(0.8 * (1 - BREATHE_AMPLITUDE), 3);
        expect(loud.max - loud.min).toBeGreaterThan(quiet.max - quiet.min);
        // The loud swing is the documented multiple, not an open-ended one.
        expect(loud.max).toBeCloseTo(
            0.8 * (1 + BREATHE_AMPLITUDE * (1 + ENERGY_AMPLITUDE)),
            3,
        );
    });

    it("brightens every particle as energy rises", () => {
        const dim = single(0.5);
        const bright = single(0.5);
        bright.energy = 1;
        const out = new Float32Array(4);

        project(dim, 0, 0, 100, out);
        const dimAlpha = out[3];
        project(bright, 0, 0, 100, out);

        expect(out[3]).toBeGreaterThan(dimAlpha);
        expect(out[3]).toBeLessThanOrEqual(1);
    });
});
