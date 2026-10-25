/**
 * The hold-to-delete gesture (#157).
 *
 * The suite is node-only and has no DOM, so the component's markup is rendered
 * with `react-dom/server` — the shape `SnoozeMenu.test.ts` established — and the
 * timing rule is exercised through the exported `scheduleHold` under fake
 * timers. Between the two they cover what the gesture promises: the button is a
 * hold control (a ring and a duration, not a plain delete tap), a release before
 * the duration never fires, and a completed hold fires exactly once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HOLD_TO_DELETE_MS, HoldToDelete, scheduleHold } from "./HoldToDelete";

/** The markup, rendered once for every markup test. */
const html = renderToStaticMarkup(
    createElement(HoldToDelete, {
        label: "Project plan",
        onDelete: () => undefined,
    }),
);

const buttonTag = /<button[^>]*hold-to-delete[^>]*>/.exec(html)?.[0] ?? "";

/**
 * One attribute's value out of a rendered tag, or `null`.
 *
 * @param tag - The rendered opening tag.
 * @param name - The attribute name to read.
 * @returns Its value, or `null` when absent.
 */
function attr(tag: string, name: string): string | null {
    const match = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
    return match === null ? null : (match[1] ?? null);
}

describe("HoldToDelete", () => {
    it("names the gesture and the thing it deletes", () => {
        expect(attr(buttonTag, "aria-label")).toBe(
            "Hold to delete Project plan",
        );
        expect(attr(buttonTag, "title")).toBe(
            "Press and hold to delete Project plan",
        );
    });

    it("states the three-second duration the ring and timer share", () => {
        expect(HOLD_TO_DELETE_MS).toBe(3000);
        expect(attr(buttonTag, "data-hold-ms")).toBe("3000");
        expect(attr(buttonTag, "style")).toContain("--hold-duration:3000ms");
    });

    it("starts empty, with both ring halves in the markup", () => {
        expect(attr(buttonTag, "data-holding")).toBe("false");
        expect(html).toContain('class="hold-to-delete-ring"');
        expect(html).toContain('class="hold-to-delete-track"');
        expect(html).toContain('class="hold-to-delete-fill"');
    });

    it("keeps the caller's placement class", () => {
        const placed = renderToStaticMarkup(
            createElement(HoldToDelete, {
                label: "Project plan",
                className: "thread-delete",
                onDelete: () => undefined,
            }),
        );

        expect(placed).toContain(
            'class="icon-btn hold-to-delete thread-delete"',
        );
    });
});

describe("scheduleHold", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("fires once, and only after the whole hold", () => {
        vi.useFakeTimers();
        const onComplete = vi.fn();
        scheduleHold(HOLD_TO_DELETE_MS, onComplete);

        vi.advanceTimersByTime(HOLD_TO_DELETE_MS - 1);
        expect(onComplete).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(onComplete).toHaveBeenCalledTimes(1);

        // A later pointer/key release must not fire it again.
        vi.advanceTimersByTime(HOLD_TO_DELETE_MS);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("does nothing when released before the ring closes", () => {
        vi.useFakeTimers();
        const onComplete = vi.fn();
        const hold = scheduleHold(HOLD_TO_DELETE_MS, onComplete);

        vi.advanceTimersByTime(HOLD_TO_DELETE_MS - 1);
        hold.cancel();
        vi.advanceTimersByTime(HOLD_TO_DELETE_MS * 2);

        expect(onComplete).not.toHaveBeenCalled();
    });

    it("lets a completed hold's handle be cancelled harmlessly", () => {
        vi.useFakeTimers();
        const onComplete = vi.fn();
        const hold = scheduleHold(HOLD_TO_DELETE_MS, onComplete);

        vi.advanceTimersByTime(HOLD_TO_DELETE_MS);
        hold.cancel();

        expect(onComplete).toHaveBeenCalledTimes(1);
    });
});
