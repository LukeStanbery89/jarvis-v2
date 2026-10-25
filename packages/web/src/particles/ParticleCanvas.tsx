/**
 * Draws the particle field on a full-viewport canvas (#146, phase A).
 *
 * The motion lives in `./field`, which knows nothing about canvases; this is
 * the loop around it — size the canvas, advance the field by the real frame
 * delta, project, stamp. Four rules keep it at a full frame rate:
 *
 * - **A cached glow sprite.** Each particle is one `drawImage` of a 32 px
 *   radial gradient with `lighter` compositing. Building a gradient per
 *   particle per frame (or using `shadowBlur`, the usual shortcut) is how a
 *   particle canvas turns into a 20 fps slideshow.
 * - **Capped device pixels.** The field is soft, so 1.5× is visually
 *   indistinguishable from 2–3× and costs a third of the fill rate. That
 *   matters twice over once phase B puts `backdrop-filter` panes on top of it.
 * - **A clamped delta.** A backgrounded tab resumes with a huge
 *   `now - last`; `step` clamps it, so the disc picks up where it was instead
 *   of teleporting.
 * - **Nothing allocated per frame.** The projected buffer is reused, and the
 *   field mutates in place.
 * - **Loudness, not beats.** Phase E hands `step` the spoken response's RMS,
 *   smoothed over ~200 ms through a ref, so the disc breathes with the voice
 *   and settles with it instead of strobing once per syllable.
 *
 * `prefers-reduced-motion: reduce` draws a single static frame: the field is
 * still there (it is the background), it just does not move. The media query
 * is watched, so toggling the OS setting takes effect without a reload.
 *
 * A disconnected socket (#177 follow-up) is the second reason the field can be
 * slow: instead of freezing, the loop keeps running at a crawl and the cyan
 * sprite is swapped for a yellow one, so the background says "JARVIS is not
 * reachable" without going dead. Reconnecting and closed both count; the initial
 * `connecting` handshake does not, because it is not a drop.
 */
import { useEffect, useRef } from "react";
import { createField, particleCount, project, step } from "./field";
import type { Field } from "./field";

/** The field's seed — a constant, so every visit is the same sky. */
const SEED = 0x4a415256;

/** The highest device-pixel ratio the canvas will render at. */
const MAX_DPR = 1.5;

/** The sprite's edge in pixels; it is a soft gradient, so 32 is plenty. */
const SPRITE_PX = 32;

/**
 * How many sprite-widths one particle covers.
 *
 * The sprite's bright core is roughly a quarter of its width, so a multiple of
 * four puts the visible dot at the `size` the field asked for while keeping a
 * wide, faint halo around it.
 */
const GLOW_SCALE = 4;

/** Rebuild the field only when a resize changes its particle count this much. */
const RESIZE_SLACK = 20;

/** The disc's radius as a fraction of the smaller viewport side. */
const FIELD_RADIUS = 0.46;

/**
 * How fast the field's loudness follows the voice, per frame (#146 phase E).
 *
 * A syllable lasts a few frames; at 0.1 the loudness settles over roughly
 * 170 ms, so the disc breathes with the sentence rather than strobing with
 * every phoneme. Attack and release share the coefficient deliberately — a
 * background should follow a conversation, not punctuate it.
 */
const ENERGY_SMOOTHING = 0.1;

/**
 * How much of its normal motion the field keeps while disconnected.
 *
 * A dropped socket should not freeze the background: a barely turning disc
 * still reads as alive, while a full-speed one would say nothing is wrong. At
 * 0.2 the usual ~105-second turn becomes ~9 minutes, and the ~11-second
 * breathe stretches to ~55 seconds. Reduced motion still wins and holds a
 * single frame.
 */
const DISCONNECTED_SPEED = 0.2;

/** Props for {@link ParticleCanvas}. */
export interface ParticleCanvasProps {
    /**
     * The current loudness of the spoken response, 0..1 (#146 phase E).
     *
     * Called once per frame. Absent (the sign-in screen, or a runtime with no
     * audio) means a field that only breathes on its own clock.
     */
    energy?: () => number;
    /**
     * Whether the chat socket has dropped (#177 follow-up).
     *
     * A disconnected field paints yellow and slows to a crawl, so the
     * background carries the same fact as the connection chip. Absent means
     * connected (the sign-in screen has no socket at all).
     */
    disconnected?: boolean;
}

/**
 * The field's canvas, or `null` where 2D canvas is unavailable.
 *
 * Rendered once by {@link AppShell} as a sibling behind `.app`, so it survives
 * every route change and the page content paints over it.
 *
 * @param props - See {@link ParticleCanvasProps}.
 */
export function ParticleCanvas({
    energy,
    disconnected = false,
}: ParticleCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    // Read through a ref: the loop is set up once, and a caller may pass a new
    // function on any render without the field being torn down and re-seeded.
    const energyRef = useRef(energy);
    energyRef.current = energy;
    // Same shape for the connection: the status can change without rebuilding
    // the field, and the loop must see the current value between frames.
    const disconnectedRef = useRef(disconnected);
    disconnectedRef.current = disconnected;
    /**
     * The running renderer's controls, so the connection effect can stop or
     * restart the loop without tearing the field down.
     */
    const rendererRef = useRef<{
        draw(): void;
        start(): void;
        stop(): void;
    } | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d") ?? null;
        if (canvas === null || context === null) {
            return;
        }

        const sprite = createGlowSprite("cyan");
        const disconnectedSprite = createGlowSprite("yellow");
        const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

        let field: Field | null = null;
        let points = new Float32Array(0);
        let width = 0;
        let height = 0;
        let radius = 0;
        let frame = 0;
        let last = 0;
        /** The smoothed loudness handed to `step` (#146 phase E). */
        let loudness = 0;

        const draw = () => {
            if (field === null || width === 0 || height === 0) {
                return;
            }
            const active = disconnectedRef.current
                ? disconnectedSprite
                : sprite;
            context.clearRect(0, 0, width, height);
            project(field, width / 2, height / 2, radius, points);
            context.globalCompositeOperation = "lighter";
            for (let offset = 0; offset < points.length; offset += 4) {
                const size = points[offset + 2] * GLOW_SCALE;
                context.globalAlpha = points[offset + 3];
                context.drawImage(
                    active,
                    points[offset] - size / 2,
                    points[offset + 1] - size / 2,
                    size,
                    size,
                );
            }
            context.globalAlpha = 1;
            context.globalCompositeOperation = "source-over";
        };

        /** Resizes the backing store to the viewport and re-seeds if needed. */
        const measure = () => {
            const cssWidth = canvas.clientWidth;
            const cssHeight = canvas.clientHeight;
            // A zero-sized box — a hidden pane, or a stylesheet that has not
            // applied yet — must not become a 1×1 canvas: that erases the
            // field and projects every particle onto a single pixel. Wait for
            // a real size instead (the observer fires again when there is one).
            if (cssWidth === 0 || cssHeight === 0) {
                return;
            }
            const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
            const pixelWidth = Math.round(cssWidth * dpr);
            const pixelHeight = Math.round(cssHeight * dpr);
            width = cssWidth;
            height = cssHeight;
            // Assigning either attribute clears the canvas, so an unchanged
            // size is not written again. (The CSS box is independent of these
            // values — see `.particle-field` in styles.css for why that
            // matters.)
            if (pixelWidth !== canvas.width) {
                canvas.width = pixelWidth;
            }
            if (pixelHeight !== canvas.height) {
                canvas.height = pixelHeight;
            }
            // The transform resets whenever width/height are assigned, so it
            // is set here rather than once at mount.
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            radius = Math.min(width, height) * FIELD_RADIUS;

            const wanted = particleCount(width * height);
            if (
                field === null ||
                Math.abs(wanted - field.particles.length) > RESIZE_SLACK
            ) {
                field = createField(SEED, wanted);
                points = new Float32Array(wanted * 4);
            }
        };

        const tick = (now: number) => {
            frame = requestAnimationFrame(tick);
            const delta = now - last;
            last = now;
            if (field !== null) {
                if (disconnectedRef.current) {
                    // Keep the disc alive, but at a crawl: the connection is
                    // down, not the app. No voice energy is read while there is
                    // no server to answer.
                    loudness = 0;
                    step(field, delta * DISCONNECTED_SPEED, 0);
                } else {
                    const reading = energyRef.current?.() ?? 0;
                    loudness += (reading - loudness) * ENERGY_SMOOTHING;
                    step(field, delta, loudness);
                }
                draw();
            }
        };

        const start = () => {
            if (frame !== 0 || motion.matches || document.hidden) {
                return;
            }
            last = performance.now();
            frame = requestAnimationFrame(tick);
        };

        const stop = () => {
            if (frame !== 0) {
                cancelAnimationFrame(frame);
            }
            frame = 0;
        };

        const onResize = () => {
            measure();
            // Redraw even when paused, so a reduced-motion field follows the
            // window instead of stretching with the old backing store.
            draw();
        };

        const onVisibility = () => {
            if (document.hidden) {
                stop();
            } else {
                start();
            }
        };

        const onMotion = () => {
            stop();
            if (motion.matches) {
                draw();
            } else {
                start();
            }
        };

        rendererRef.current = { draw, start, stop };
        measure();
        draw();
        start();

        const observer = new ResizeObserver(onResize);
        observer.observe(canvas);
        document.addEventListener("visibilitychange", onVisibility);
        motion.addEventListener("change", onMotion);

        return () => {
            rendererRef.current = null;
            stop();
            observer.disconnect();
            document.removeEventListener("visibilitychange", onVisibility);
            motion.removeEventListener("change", onMotion);
        };
    }, []);

    // A connection change must take effect without re-seeding the field: repaint
    // in the new tone and make sure the loop is running. The tick itself slows
    // the motion while disconnected, so Stop is never the right move here.
    useEffect(() => {
        const control = rendererRef.current;
        if (control === null) {
            return;
        }
        control.draw();
        control.start();
    }, [disconnected]);

    return (
        <canvas ref={canvasRef} className="particle-field" aria-hidden="true" />
    );
}

/** The two palettes the glow sprite is built from. */
type GlowTone = "cyan" | "yellow";

/**
 * Builds the one glow sprite every particle is stamped from.
 *
 * A radial gradient is expensive to build and cheap to stamp, so it is built
 * once: white-hot at the core, the tone through the body, transparent at the
 * edge. `lighter` compositing then lets overlapping particles accumulate
 * brightness naturally, which is what makes the centre of the disc feel lit
 * rather than simply crowded. The yellow sprite exists only for a dropped
 * connection (#177 follow-up); the field's geometry is identical.
 *
 * @param tone - Cyan while connected, yellow while the socket is down.
 * @returns The 32 px sprite the renderer stamps.
 */
function createGlowSprite(tone: GlowTone): HTMLCanvasElement {
    const sprite = document.createElement("canvas");
    sprite.width = SPRITE_PX;
    sprite.height = SPRITE_PX;
    const context = sprite.getContext("2d");
    if (context !== null) {
        const half = SPRITE_PX / 2;
        const palette =
            tone === "cyan"
                ? {
                      core: "rgba(160, 246, 255, 1)",
                      body: "rgba(0, 221, 255, 0.75)",
                      faint: "rgba(0, 221, 255, 0.18)",
                      edge: "rgba(0, 221, 255, 0)",
                  }
                : {
                      core: "rgba(255, 250, 190, 1)",
                      body: "rgba(255, 221, 0, 0.82)",
                      faint: "rgba(255, 221, 0, 0.22)",
                      edge: "rgba(255, 221, 0, 0)",
                  };
        const gradient = context.createRadialGradient(
            half,
            half,
            0,
            half,
            half,
            half,
        );
        gradient.addColorStop(0, palette.core);
        gradient.addColorStop(0.25, palette.body);
        gradient.addColorStop(0.6, palette.faint);
        gradient.addColorStop(1, palette.edge);
        context.fillStyle = gradient;
        context.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    }
    return sprite;
}
