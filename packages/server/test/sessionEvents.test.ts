/**
 * Cross-device session events (#122 follow-up): fan-out, unsubscribe, and a
 * listener that throws must not stop the others.
 */
import { describe, expect, it, vi } from "vitest";
import { createSessionEvents } from "../src/sessionEvents";

describe("createSessionEvents", () => {
    it("publishes to every subscriber and stops after unsubscribe", () => {
        const events = createSessionEvents();
        const first = vi.fn();
        const second = vi.fn();
        const stop = events.subscribe(first);
        events.subscribe(second);

        events.publish({
            type: "activity",
            userId: 7,
            sessionId: "thread-1",
        });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "activity",
                sessionId: "thread-1",
            }),
        );

        stop();
        events.publish({ type: "deleted", userId: 7, sessionId: "thread-1" });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
    });

    it("keeps publishing when one listener throws", () => {
        const events = createSessionEvents();
        const healthy = vi.fn();
        events.subscribe(() => {
            throw new Error("listener exploded");
        });
        events.subscribe(healthy);
        expect(() =>
            events.publish({
                type: "title",
                userId: 1,
                sessionId: "thread-1",
                title: "A title",
            }),
        ).not.toThrow();
        expect(healthy).toHaveBeenCalledTimes(1);
    });
});
