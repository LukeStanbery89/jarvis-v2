/**
 * The particle field behind the app (#146, phase A).
 *
 * The brief: a blue disc of particles on black, dense near the centre and
 * sparse at its edge, turning slowly and breathing. This module is that disc
 * and nothing else — no canvas, no DOM, no clock. {@link createField} seeds it
 * from a number, {@link step} advances it by a delta, and {@link project}
 * flattens it into the buffer the renderer stamps.
 *
 * The split is the app's usual one (`jobs.ts`, `notifications.ts`,
 * `clock.ts`): the motion model is a pure function of (seed, elapsed time,
 * energy), so it is unit-testable without a browser and the canvas code stays
 * a thin loop. It also means the look can be tuned from a test — the shape of
 * the disc is asserted, not eyeballed.
 *
 * `energy` is 0..1 and only widens the breathe (and brightens the disc). Phase
 * A always passed 0; phase E feeds it the spoken response's loudness, which is
 * why it was a parameter from the start rather than a later rewrite.
 */

/** One particle, in polar coordinates around the field's centre. */
export interface Particle {
    /** Resting radius: 0 at the centre, 1 at the disc's edge. */
    r: number;
    /** Angle in radians; the one coordinate that advances forever. */
    theta: number;
    /** Breathe offset in radians, drawn from {@link PHASE_SPREAD}'s window. */
    phase: number;
    /** Angular-speed nudge in rad/s, so the disc is not a rigid plate. */
    omega: number;
    /** Draw size in CSS pixels. */
    size: number;
    /** Base opacity, 0..1. */
    alpha: number;
}

/** A seeded disc of particles, and the clock they are breathing on. */
export interface Field {
    /** The disc — fixed for the field's lifetime, mutated in place by `step`. */
    readonly particles: Particle[];
    /** Field time in milliseconds; {@link step} advances it. */
    tMs: number;
    /** The last energy handed to {@link step}, 0..1. */
    energy: number;
}

/**
 * Centre weighting: `r = u^DENSITY_POWER` for uniform `u`, whose radial
 * density falls off as `r^(1/p - 1)`. Above 1 the core is dense and the rim
 * sparse, which is the brief's "focused heavily near the center".
 */
export const DENSITY_POWER = 1.3;

/** Base angular speed in rad/s — one slow turn in roughly 105 seconds. */
export const BASE_OMEGA = 0.06;

/** Per-particle angular nudge in rad/s (the plate is not rigid). */
export const OMEGA_JITTER = 0.02;

/** Breaths per second — about one every eleven seconds. */
export const BREATHE_HZ = 0.2;

/** Resting breathe amplitude, as a fraction of a particle's radius. */
export const BREATHE_AMPLITUDE = 0.06;

/**
 * The window the disc's breathe is staggered over, in radians.
 *
 * The brief asks for particles that breathe *together*: a phase drawn from the
 * whole cycle (`2π`) splits the disc in half — some inhaling while others
 * exhale — and reads as independent drift rather than one body. A narrow
 * window keeps them moving the same way (a particle's radial velocity is
 * `cos(window)`, so `0.36` keeps every one above `0.93` of full speed at the
 * far edge of the stagger) while the fractional offset still stops the disc
 * from pulsing like a metronome. Roughly an eighth of the half-cycle, which is
 * the "mostly together, slightly ragged" look.
 */
export const PHASE_SPREAD = 0.36;

/**
 * Extra breathe amplitude at full energy: the voice phase's whole effect.
 *
 * A spoken RMS rarely reaches the top of the range (see `ENERGY_GAIN`), so this
 * is sized for the middle of it: ordinary speech lands around ±17 % of a
 * particle's radius against the resting ±6 %, and only a shout reaches the
 * full ±33 %.
 */
export const ENERGY_AMPLITUDE = 4;

/**
 * The largest delta {@link step} will honour, in milliseconds.
 *
 * A backgrounded tab (or a suspended laptop) resumes with an enormous
 * `now - last`. Clamping means the disc picks up where it was instead of
 * teleporting, and it is also why `step` owns the rule rather than the loop.
 */
export const MAX_STEP_MS = 50;

/** Viewport pixels per particle, and the bounds that keep phones cheap. */
const AREA_PER_PARTICLE = 4_000;
const MIN_PARTICLES = 160;
const MAX_PARTICLES = 600;

const TWO_PI = Math.PI * 2;

/**
 * How many particles a viewport of `areaPx` deserves.
 *
 * Density is per-area rather than fixed so a phone does not draw a desktop's
 * particle count into a third of the pixels, and the bounds keep both ends
 * sane: few enough that a sparse background never becomes soup, many enough
 * that a 4K display still reads as a field.
 *
 * @param areaPx - The canvas's CSS-pixel area (`width * height`).
 * @returns A count in `[MIN_PARTICLES, MAX_PARTICLES]`.
 */
export function particleCount(areaPx: number): number {
    const wanted = areaPx / AREA_PER_PARTICLE;
    return Math.round(Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, wanted)));
}

/**
 * A tiny deterministic PRNG (mulberry32).
 *
 * Seeded rather than `Math.random` so a reload is the *same* sky and a test
 * can assert the shape of the disc; 32 bits of state and one multiply per
 * draw keeps it free at 60 fps.
 */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

const clamp01 = (value: number): number =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Seeds a disc of `count` particles.
 *
 * Size and opacity taper outward: the core holds the bright, larger particles
 * and the rim the faint, small ones, so the density gradient the radii produce
 * is reinforced rather than flattened by uniform dots.
 *
 * @param seed - Any integer; the same seed always yields the same field.
 * @param count - Particles to create (usually {@link particleCount}).
 * @returns A field at `t = 0` with no energy.
 */
export function createField(seed: number, count: number): Field {
    const random = mulberry32(seed);
    const total = Math.max(0, Math.round(count));
    const particles: Particle[] = [];
    for (let i = 0; i < total; i += 1) {
        const r = Math.pow(random(), DENSITY_POWER);
        particles.push({
            r,
            theta: random() * TWO_PI,
            phase: random() * PHASE_SPREAD,
            omega: (random() * 2 - 1) * OMEGA_JITTER,
            size: 2.2 - 1.6 * r + random() * 0.6,
            alpha: (0.18 + 0.72 * (1 - r)) * (0.55 + 0.45 * random()),
        });
    }
    return { particles, tMs: 0, energy: 0 };
}

/**
 * Advances the field by `dtMs` and records the energy the breathe should use.
 *
 * In place, deliberately: this runs 60 times a second over a few hundred
 * particles, and allocating a fresh disc per frame would hand the collector
 * work for no benefit. The disc's *shape* is still fixed at creation — only
 * the angle and the clock move.
 *
 * @param field - The field to advance (mutated).
 * @param dtMs - Time since the previous step; clamped to {@link MAX_STEP_MS}.
 * @param energy - 0..1 loudness; only widens the breathe (default 0).
 * @returns The same field, for chaining.
 */
export function step(field: Field, dtMs: number, energy = 0): Field {
    const ms = Math.max(0, Math.min(dtMs, MAX_STEP_MS));
    const dt = ms / 1000;
    field.tMs += ms;
    field.energy = clamp01(energy);
    for (const particle of field.particles) {
        particle.theta =
            (particle.theta + (BASE_OMEGA + particle.omega) * dt) % TWO_PI;
    }
    return field;
}

/**
 * Flattens the field into the renderer's buffer.
 *
 * Writes four floats per particle — `x`, `y`, `size`, `alpha` — into the
 * caller's `out`, so the loop allocates nothing. The breathe is applied here
 * rather than to `particle.r` because it depends on the field's clock, and
 * keeping the resting radius intact means the disc cannot drift inward over
 * time.
 *
 * @param field - The field to project.
 * @param cx - Centre x in CSS pixels.
 * @param cy - Centre y in CSS pixels.
 * @param radius - The disc's radius in CSS pixels.
 * @param out - A buffer with room for `4 × particles.length` floats.
 * @throws Never; a short buffer simply receives fewer particles.
 */
export function project(
    field: Field,
    cx: number,
    cy: number,
    radius: number,
    out: Float32Array,
): void {
    const seconds = field.tMs / 1000;
    const amplitude = BREATHE_AMPLITUDE * (1 + ENERGY_AMPLITUDE * field.energy);
    const omega = TWO_PI * BREATHE_HZ;
    const capacity = Math.floor(out.length / 4);
    const total = Math.min(field.particles.length, capacity);
    for (let i = 0; i < total; i += 1) {
        const particle = field.particles[i];
        const breathe =
            1 + amplitude * Math.sin(omega * seconds + particle.phase);
        const r = Math.max(0, Math.min(1, particle.r * breathe));
        const offset = i * 4;
        out[offset] = cx + Math.cos(particle.theta) * r * radius;
        out[offset + 1] = cy + Math.sin(particle.theta) * r * radius;
        out[offset + 2] = particle.size;
        out[offset + 3] = Math.min(
            1,
            particle.alpha * (1 + 0.55 * field.energy),
        );
    }
}
