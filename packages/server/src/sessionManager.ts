/**
 * Session-lifecycle seam for the WebSocket layer.
 *
 * Owning the per-turn pipeline a prompt goes through — thread-lock acquire,
 * session-ledger claim, ownership guard, agent streaming (via an injected
 * runner), session touch, and lock release — plus guest-session cleanup on
 * socket close. Extracted out of `ws.ts` so that file stays protocol- and
 * socket-only and the ledger/lock/ownership math is unit-testable without a
 * port. The lock is a {@link KeyedLock} created per manager (one per
 * `attachChatServer`): production runs a single server, so cross-socket
 * exclusion is preserved, and tests get isolated lock state instead of sharing
 * a module global.
 *
 * Invariant: exactly one `SessionManager` must exist per `AppDatabase`/process
 * for the ::thread-lock:: to guarantee cross-socket exclusion. If a future
 * package (voice, another chat endpoint) ever mounts a second manager over the
 * same ledger, the lock must move to a store-level key instead.
 */
import type { AuthContext, SessionLedger } from "@lukestanbery/jarvis-auth";
import { ownsRow } from "@lukestanbery/jarvis-auth";
import type { ChatMode } from "@lukestanbery/jarvis-protocol";
import { createKeyedLock } from "./keyedLock";
import { logger } from "./logger";
import type { SessionTitleService } from "./sessionTitle";

/** How a turn resolved; the caller decides the user-facing message. */
export type TurnOutcome = "completed" | "busy" | "not-owned";

/**
 * Interface the `/ws` endpoint codes against.
 */
export interface SessionManager {
    /**
     * Runs one agent turn under the per-thread lock. Claims the session in the
     * ledger, guards ownership of it against `actor` (strict `ownsRow`
     * equality — no owner override on the chat path), streams the agent via
     * `stream`, and touches the session on success. Always releases the lock.
     *
     * - `"busy"` — another turn already holds the thread's lock (the prompt
     *   was not run).
     * - `"not-owned"` — the session belongs to a different principal (the
     *   prompt was not run, and the session was not touched).
     */
    runTurn(options: {
        sessionId: string;
        actor: AuthContext;
        guestThreads: Set<string>;
        /**
         * The prompt's declared chat mode; `"text"` when omitted. Recorded as
         * the ledger session's `kind` — write-once at claim time, so a
         * thread's kind is the mode of its first prompt and later prompts do
         * not re-claim it.
         */
        mode?: ChatMode;
        /** The original prompt, used to set the first excerpt title. */
        titleHint?: string;
        stream: (sessionId: string) => Promise<void>;
    }): Promise<TurnOutcome>;

    /**
     * Deletes the guest-owned session rows named by `sessionIds` (socket-close
     * cleanup). A row is only removed while it is still guest-owned — a
     * guest-created row that was somehow re-parented must never be deleted
     * from under its new owner.
     */
    cleanupGuests(sessionIds: Iterable<string>): void;
}

/**
 * Builds the default {@link SessionManager} over a `SessionLedger` — the
 * narrow role this seam needs, so the ledger split stays honest.
 */
export function createSessionManager(
    store: SessionLedger,
    options: {
        titles?: Pick<SessionTitleService, "ensureExcerpt">;
        deleteThread?: (threadId: string) => Promise<void>;
    } = {},
): SessionManager {
    /** Thread ids with a turn currently in flight, across all sockets. */
    const threadLocks = createKeyedLock();
    return {
        async runTurn({
            sessionId,
            actor,
            guestThreads,
            mode,
            titleHint,
            stream,
        }) {
            if (!threadLocks.tryAcquire(sessionId)) {
                return "busy";
            }
            try {
                const actorUserId =
                    actor.kind === "authed" ? actor.user.id : null;
                const { session, created } = store.claimSession(sessionId, {
                    userId: actorUserId,
                    deviceId: actor.kind === "authed" ? actor.device.id : null,
                    kind: mode ?? "text",
                });
                if (created && actor.kind !== "authed") {
                    guestThreads.add(sessionId);
                }
                // Thread-takeover guard: a session must only ever be chatted
                // on by the principal that owns it (guests own `userId = NULL`
                // rows, an authed principal owns its own). The thread names a
                // LangGraph history, and ownership is all that stands between
                // a socket and that history.
                if (!ownsRow(session.userId, actorUserId)) {
                    return "not-owned";
                }
                if (titleHint !== undefined && options.titles) {
                    options.titles.ensureExcerpt(session, titleHint);
                }
                await stream(sessionId);
                store.touchSession(sessionId);
                return "completed";
            } finally {
                threadLocks.release(sessionId);
            }
        },
        cleanupGuests(sessionIds) {
            for (const threadId of sessionIds) {
                const session = store.getSessionByThread(threadId);
                // Guest rows are `userId = NULL`; a guest claimed the row, and a
                // re-parented (owned) row must never be deleted from under its
                // owner. Expressed through the same policy as the chat guard.
                if (session && ownsRow(session.userId, null)) {
                    if (options.deleteThread === undefined) {
                        store.deleteSession(threadId);
                        continue;
                    }
                    // Delete the checkpoint before the ledger row: if the
                    // checkpoint store fails, the row remains visible for a
                    // later cleanup rather than orphaning an encrypted thread.
                    void options
                        .deleteThread(threadId)
                        .then(() => {
                            const current = store.getSessionByThread(threadId);
                            if (current && ownsRow(current.userId, null)) {
                                store.deleteSession(threadId);
                            }
                        })
                        .catch((err: unknown) => {
                            logger.warn(
                                `Could not remove guest checkpoint ${threadId}: ${
                                    err instanceof Error
                                        ? err.message
                                        : String(err)
                                }`,
                            );
                        });
                }
            }
        },
    };
}
