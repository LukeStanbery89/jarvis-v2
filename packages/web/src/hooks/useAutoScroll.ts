/**
 * Transcript auto-scroll hook.
 *
 * Keeps the newest content in view: any message change (own send, streamed
 * chunks, tool notices) or a thread switch snaps the transcript container to the
 * bottom. The effect reads the messages reference, so it fires on each store
 * mutation rather than every render.
 */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { ThreadMessage } from "../threads";

/**
 * Scrolls `containerRef` to the bottom on message or thread change.
 *
 * @param containerRef - The scrolling transcript container.
 * @param messages - The active thread's messages.
 * @param activeId - The active thread id (a switch also snaps to the bottom).
 */
export function useAutoScroll(
    containerRef: RefObject<HTMLDivElement | null>,
    messages: ThreadMessage[],
    activeId: string | null,
): void {
    useEffect(() => {
        const el = containerRef.current;
        if (el && messages.length > 0) {
            el.scrollTop = el.scrollHeight;
        }
    }, [messages, activeId]);
}
