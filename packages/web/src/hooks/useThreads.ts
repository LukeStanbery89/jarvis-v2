/**
 * Transcript-store hook for the chat view.
 *
 * Owns the reducer over the pure `threads.ts` helpers, the active-thread id,
 * and the throttled localStorage persistence. The pure reducer and its action
 * union stay exported (node-testable) at the top; the hook at the bottom is the
 * React-facing wrapper the view consumes.
 *
 * No `api`/token dependency: the store is entirely local. `openThread` accepts
 * `null` (clearing the active id) so a caller that deletes the active thread
 * can reset it without owning the state itself.
 */
import {
    useCallback,
    useEffect,
    useReducer,
    useRef,
    useState,
    type Dispatch,
    type RefObject,
} from "react";
import {
    appendChunk,
    appendMessage,
    appendToolResult,
    deleteThread,
    ensureThread,
    loadThreads,
    markAssistantError,
    saveThreads,
    type ThreadMap,
} from "../threads";

/** Transcript-store actions, all flowing through the pure threads helpers. */
export type ThreadsAction =
    | {
          type: "user";
          sessionId: string;
          text: string;
          at: number;
          attachmentIds?: string[];
      }
    | { type: "chunk"; sessionId: string; text: string; at: number }
    | {
          type: "tool";
          sessionId: string;
          name: string;
          args?: unknown;
          at: number;
      }
    | {
          type: "toolResult";
          sessionId: string;
          name: string;
          output?: unknown;
          at: number;
      }
    | { type: "assistantError"; sessionId: string; text: string; at: number }
    | { type: "ensure"; sessionId: string; at: number }
    | { type: "deleted"; sessionId: string };

/** The public surface {@link useThreads} returns to the chat view. */
export interface UseThreadsResult {
    /** The current thread map (the reducer state). */
    threads: ThreadMap;
    /** The active conversation id, or `null` when none is open. */
    activeId: string | null;
    /** Latest active id for socket event closures (never stale). */
    activeIdRef: RefObject<string | null>;
    /** Opens `id`, or clears the active thread when `null`. */
    openThread(id: string | null): void;
    /** Mints a fresh session id, ensures its thread, and activates it. */
    newChat(): void;
    /** Writes the latest map to storage immediately (turn-end, unmount). */
    persist(): void;
    /** The reducer's dispatch, for streaming frames and user messages. */
    dispatch: Dispatch<ThreadsAction>;
}

/**
 * Applies one action via the pure helpers (reducer for the thread map).
 *
 * @param map - The current thread map.
 * @param action - The action to apply.
 * @returns The next thread map.
 */
export function threadsReducer(
    map: ThreadMap,
    action: ThreadsAction,
): ThreadMap {
    switch (action.type) {
        case "user":
            return appendMessage(map, action.sessionId, {
                id: crypto.randomUUID(),
                role: "user",
                text: action.text,
                at: action.at,
                ...(action.attachmentIds?.length
                    ? { attachmentIds: action.attachmentIds }
                    : {}),
            });
        case "chunk":
            return appendChunk(map, action.sessionId, action.text, action.at);
        case "tool":
            return appendMessage(map, action.sessionId, {
                id: crypto.randomUUID(),
                role: "tool",
                tool: { name: action.name, args: action.args },
                at: action.at,
            });
        case "toolResult":
            return appendToolResult(
                map,
                action.sessionId,
                action.name,
                action.output,
                action.at,
            );
        case "assistantError":
            return markAssistantError(
                map,
                action.sessionId,
                action.text,
                action.at,
            );
        case "ensure":
            return ensureThread(map, action.sessionId, action.at);
        case "deleted":
            return deleteThread(map, action.sessionId);
    }
}

/**
 * The transcript store for one signed-in user.
 *
 * Loads the user's map from `storage` on first render, exposes the active id
 * (plus a latest-value ref for socket closures), and persists with a 300 ms
 * trailing throttle — one write per burst of chunk updates, a final write at
 * each turn's end via {@link UseThreadsResult.persist}, and an unmount flush.
 *
 * @param username - The signed-in account (namespaces the storage key).
 * @param storage - The `Storage` handle (injected so node tests can fake it).
 * @returns The thread map, active id, and the mutators the view drives.
 */
export function useThreads(
    username: string,
    storage: Storage = localStorage,
): UseThreadsResult {
    const [threads, dispatch] = useReducer(
        threadsReducer,
        username,
        (user: string) => loadThreads(storage, user),
    );
    const [activeId, setActiveId] = useState<string | null>(null);

    /** Latest thread map for the throttled persister. */
    const threadsRef = useRef(threads);
    threadsRef.current = threads;
    /** Latest active thread id (socket event closures must not go stale). */
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;

    const persist = useCallback((): void => {
        saveThreads(storage, username, threadsRef.current);
    }, [storage, username]);

    // Throttled trailing persistence: at most one write per 300ms burst of
    // chunk updates (the timer always reads the latest map via the ref).
    const saveTimer = useRef<number | null>(null);
    useEffect(() => {
        if (saveTimer.current !== null) {
            return;
        }
        saveTimer.current = window.setTimeout(() => {
            saveTimer.current = null;
            persist();
        }, 300);
    }, [threads, persist]);

    // Unmount flush: a pending throttled write is written before teardown.
    useEffect(
        () => () => {
            if (saveTimer.current !== null) {
                clearTimeout(saveTimer.current);
                saveTimer.current = null;
                persist();
            }
        },
        [persist],
    );

    const openThread = useCallback((id: string | null): void => {
        setActiveId(id);
    }, []);

    const newChat = useCallback((): void => {
        const id = crypto.randomUUID();
        dispatch({ type: "ensure", sessionId: id, at: Date.now() });
        setActiveId(id);
    }, []);

    return {
        threads,
        activeId,
        activeIdRef,
        openThread,
        newChat,
        persist,
        dispatch,
    };
}
