/**
 * Cross-transport session events (#122 follow-up).
 *
 * A turn and a session delete can start on any transport — a WebSocket, the
 * REST session routes, or a future client. The sockets that need to know live
 * in `ws.ts`, so this small hub decouples the producer from them: the WS turn
 * path publishes activity and title updates, the REST delete route publishes a
 * deletion, and `attachChatServer` owns the per-user socket registry and
 * decides who receives a frame.
 *
 * The hub carries only ids and titles. Transcript bodies stay behind the
 * authenticated `GET /api/sessions/{threadId}` route; a listener that needs
 * them refetches, which keeps one encrypted read path and one authorization
 * check.
 */
import { logger } from "./logger";

/** One cross-device session notification. */
export type SessionEvent =
    | {
          /** A turn settled in `sessionId`; listeners should refetch it. */
          type: "activity";
          /** The owning account. */
          userId: number;
          sessionId: string;
          /**
           * The socket that produced the turn, when known. That socket already
           * has the messages and is excluded from the activity frame; REST or
           * scheduler producers omit it.
           */
          origin?: string;
      }
    | {
          /** The session row, transcript, and checkpoint were deleted. */
          type: "deleted";
          userId: number;
          sessionId: string;
      }
    | {
          /** A generated title replaced the excerpt. */
          type: "title";
          userId: number;
          sessionId: string;
          title: string;
      };

/** A listener registered with {@link SessionEvents}. */
export type SessionEventListener = (event: SessionEvent) => void;

/** The publish-only half used by the REST routes. */
export interface SessionEventPublisher {
    publish(event: SessionEvent): void;
}

/** The full hub: publish plus subscription for the socket layer. */
export interface SessionEvents extends SessionEventPublisher {
    /** Registers a listener; the returned function unsubscribes it. */
    subscribe(listener: SessionEventListener): () => void;
}

/**
 * Creates the in-process session-event hub.
 *
 * @returns A hub with one synchronous fan-out per publish.
 */
export function createSessionEvents(): SessionEvents {
    const listeners = new Set<SessionEventListener>();
    return {
        publish(event) {
            for (const listener of [...listeners]) {
                try {
                    listener(event);
                } catch (err) {
                    logger.warn(
                        `Session event listener failed: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                }
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
