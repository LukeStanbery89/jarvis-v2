/**
 * A per-key mutual-exclusion set, shared by the two things that hold a turn.
 *
 * `sessionManager.ts` holds a chat thread while a prompt streams, and
 * `scheduler/loop.ts` holds a job while a scheduled run executes. Both need the
 * same question answered — "is this key busy right now?" — and a second
 * hand-rolled `Set` is where the two would drift apart.
 *
 * The keyspaces are disjoint *by construction*: a chat thread's key is its
 * ledger `thread_id`, and a job's key is `job:<id>`, which no client can name
 * (a prompt's `sessionId` is claimed in the ledger, and a job id is never a
 * thread id). So one primitive serving both cannot cross-block a job against a
 * conversation.
 *
 * Deliberately tiny and synchronous: it answers a question about *this
 * process's* in-memory state, and callers pair a successful acquire with a
 * `release` in a `finally` (never an await between the check and the acquire —
 * that would be a race the set cannot see).
 */
export interface KeyedLock {
    /** Takes `key` if it is free. `false` means somebody else holds it. */
    tryAcquire(key: string): boolean;
    /** Frees `key`. Releasing a key nobody holds is a no-op. */
    release(key: string): void;
    /** Whether `key` is held right now (diagnostics and tests). */
    isHeld(key: string): boolean;
}

/**
 * Builds a lock. One instance per concern per process — the chat path's is
 * created by `createSessionManager`, the scheduler's by `createScheduler` — so
 * a test gets isolated lock state instead of sharing a module global.
 */
export function createKeyedLock(): KeyedLock {
    const held = new Set<string>();
    return {
        tryAcquire(key: string): boolean {
            if (held.has(key)) {
                return false;
            }
            held.add(key);
            return true;
        },
        release(key: string): void {
            held.delete(key);
        },
        isHeld(key: string): boolean {
            return held.has(key);
        },
    };
}
