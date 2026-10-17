/**
 * A one-way fan-out of socket frames (#90 phase 6b).
 *
 * The shell owns the socket and does everything the whole app needs from a
 * frame: the transcript dispatch and the audio queue. What is left over is
 * view-scoped — only a mounted voice session cares that a turn started
 * (`audioStart` → `speaking`) — so a view subscribes while it is mounted and
 * hears nothing when it is not. "No subscriber" is the honest answer for the
 * rest of the time: there is no voice session to inform.
 *
 * Deliberately not a context or an event emitter with string topics: one frame
 * type, one callback shape, and a subscription whose lifetime is a `useEffect`.
 */
import { useCallback, useMemo, useRef } from "react";
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";

/** The publish/subscribe half of the bus, as a view sees it. */
export interface FrameBus {
    /**
     * Publishes one frame to every current subscriber.
     *
     * Iterates a snapshot, so a listener that unsubscribes while being called
     * cannot disturb the others.
     */
    emit(frame: ServerFrame): void;
    /**
     * Listens to frames until the returned function is called.
     *
     * @param listener - Called once per frame, in subscription order.
     * @returns An unsubscribe function (the `useEffect` cleanup shape).
     */
    subscribe(listener: (frame: ServerFrame) => void): () => void;
}

/**
 * Owns one bus for the caller's lifetime.
 *
 * The returned object is memoized on its two stable callbacks, so passing it
 * down as a prop never re-runs a subscriber's effect.
 *
 * @returns The bus: `emit` for the socket's owner, `subscribe` for the views.
 */
export function useFrameBus(): FrameBus {
    const listeners = useRef(new Set<(frame: ServerFrame) => void>());

    const emit = useCallback((frame: ServerFrame): void => {
        for (const listener of [...listeners.current]) {
            listener(frame);
        }
    }, []);

    const subscribe = useCallback(
        (listener: (frame: ServerFrame) => void): (() => void) => {
            listeners.current.add(listener);
            return () => {
                listeners.current.delete(listener);
            };
        },
        [],
    );

    return useMemo(() => ({ emit, subscribe }), [emit, subscribe]);
}
