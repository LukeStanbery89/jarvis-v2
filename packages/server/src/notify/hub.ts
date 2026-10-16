/**
 * The live-connection registry (#139).
 *
 * Before this existed, `ws.ts` could only answer a socket on that socket's own
 * frames: nothing in the server could find "the user's open clients", so
 * anything server-initiated — a notification today, the escalation ladder and
 * speech channels later — had nowhere to land. This module is that index and
 * nothing else: it tracks which sockets an authenticated user currently has
 * open, and pushes a frame to all of them.
 *
 * Deliberately *not* in `ws.ts`: the route layer needs the same index, and
 * `ws.ts` is already the module that owns protocol concerns. `ws.ts` calls
 * {@link NotificationHub.add} on a successful `auth` and
 * {@link NotificationHub.remove} on close; the notification service asks
 * {@link NotificationHub.isPresent} and pushes through
 * {@link NotificationHub.deliver}.
 *
 * In-memory and per-process by design: a connection is a fact about this
 * process, so there is nothing to persist. The consequence is worth stating —
 * a JARVIS restart empties the registry, and undelivered notifications are
 * found again through `GET /api/notifications` rather than re-pushed.
 */
import type { ServerFrame } from "@lukestanbery/jarvis-protocol";
import { logger } from "../logger";

/** A socket the hub can push to; the `ws` WebSocket satisfies it structurally. */
export interface HubSocket {
    readyState: number;
    send(data: string): void;
}

/** `ws`'s OPEN constant, restated so this module needs no runtime import. */
const WS_OPEN = 1;

/** The live-connection registry. */
export interface NotificationHub {
    /** Tracks a socket as reachable for `userId` (idempotent per socket). */
    add(userId: number, socket: HubSocket): void;
    /** Forgets a socket, whichever user it was tracked under. */
    remove(socket: HubSocket): void;
    /** Whether `userId` has at least one open socket right now. */
    isPresent(userId: number): boolean;
    /**
     * Pushes one frame to every open socket of `userId`.
     *
     * @returns How many sockets accepted it. A socket that closed between the
     * presence check and the write is skipped rather than treated as a
     * failure — delivery is best-effort and the record is the durable half.
     */
    deliver(userId: number, frame: ServerFrame): number;
    /** Distinct users with at least one open socket (diagnostics/tests). */
    presentUsers(): number;
}

/**
 * Builds the registry.
 *
 * A socket is tracked under at most one user, so `remove` can take just the
 * socket: the common case (a user signs in on several devices) is a set per
 * user, and one socket never belongs to two users (the `auth` handshake binds
 * it once and `ws.ts` never re-binds it).
 */
export function createNotificationHub(): NotificationHub {
    const byUser = new Map<number, Set<HubSocket>>();
    const userOf = new Map<HubSocket, number>();

    const forget = (socket: HubSocket): void => {
        const userId = userOf.get(socket);
        if (userId === undefined) {
            return;
        }
        userOf.delete(socket);
        const sockets = byUser.get(userId);
        if (sockets === undefined) {
            return;
        }
        sockets.delete(socket);
        if (sockets.size === 0) {
            byUser.delete(userId);
        }
    };

    return {
        add(userId: number, socket: HubSocket): void {
            forget(socket);
            userOf.set(socket, userId);
            const sockets = byUser.get(userId);
            if (sockets === undefined) {
                byUser.set(userId, new Set([socket]));
                return;
            }
            sockets.add(socket);
        },

        remove(socket: HubSocket): void {
            forget(socket);
        },

        isPresent(userId: number): boolean {
            return byUser.has(userId);
        },

        deliver(userId: number, frame: ServerFrame): number {
            const sockets = byUser.get(userId);
            if (sockets === undefined) {
                return 0;
            }
            const payload = JSON.stringify(frame);
            let sent = 0;
            for (const socket of sockets) {
                if (socket.readyState !== WS_OPEN) {
                    continue;
                }
                try {
                    socket.send(payload);
                    sent += 1;
                } catch (err) {
                    // A write can fail mid-teardown. One dead socket must not
                    // cost the others their copy, and it is not worth an
                    // error frame — the notification is already durable.
                    logger.debug(
                        `notification push failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
            return sent;
        },

        presentUsers(): number {
            return byUser.size;
        },
    };
}
