/**
 * Session-lifecycle seam for the WebSocket layer.
 *
 * Owning the per-turn pipeline a prompt goes through — thread-lock acquire,
 * session-ledger claim, ownership guard, agent streaming (via an injected
 * runner), session touch, and lock release — plus guest-session cleanup on
 * socket close. Extracted out of `ws.ts` so that file stays protocol- and
 * socket-only and the ledger/lock/ownership math is unit-testable without a
 * port. The lock set is per-manager (one per `attachChatServer`): production
 * runs a single server, so cross-socket exclusion is preserved, and tests get
 * isolated lock state instead of sharing a module global.
 *
 * Invariant: exactly one `SessionManager` must exist per `AppDatabase`/process
 * for the ::thread-lock:: to guarantee cross-socket exclusion. If a future
 * package (voice, another chat endpoint) ever mounts a second manager over the
 * same ledger, the lock must move to a store-level key instead.
 */
import type { AppDatabase, AuthContext } from "./auth";
import { ownsRow } from "./auth";

/** How a turn resolved; the caller decides the user-facing message. */
export type TurnOutcome = "completed" | "busy" | "not-owned";

/** The session-ledger surface `SessionManager` depends on (see Phase 5). */
export type SessionLedgerPort = Pick<
    AppDatabase,
    "claimSession" | "getSessionByThread" | "touchSession" | "deleteSession"
>;

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
 * Builds the default {@link SessionManager} over `store` — narrowed to the
 * `SessionLedgerPort` surface it calls, so a Phase-5 ledger split slots in
 * without touching this seam.
 */
export function createSessionManager(store: SessionLedgerPort): SessionManager {
    /** Thread ids with a turn currently in flight, across all sockets. */
    const threadLocks = new Set<string>();
    return {
        async runTurn({ sessionId, actor, guestThreads, stream }) {
            if (threadLocks.has(sessionId)) {
                return "busy";
            }
            threadLocks.add(sessionId);
            try {
                const actorUserId =
                    actor.kind === "authed" ? actor.user.id : null;
                const { session, created } = store.claimSession(sessionId, {
                    userId: actorUserId,
                    deviceId: actor.kind === "authed" ? actor.device.id : null,
                    kind: "text",
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
                await stream(sessionId);
                store.touchSession(sessionId);
                return "completed";
            } finally {
                threadLocks.delete(sessionId);
            }
        },
        cleanupGuests(sessionIds) {
            for (const threadId of sessionIds) {
                const session = store.getSessionByThread(threadId);
                // Guest rows are `userId = NULL`; a guest claimed the row, and a
                // re-parented (owned) row must never be deleted from under its
                // owner. Expressed through the same policy as the chat guard.
                if (session && ownsRow(session.userId, null)) {
                    store.deleteSession(threadId);
                }
            }
        },
    };
}
