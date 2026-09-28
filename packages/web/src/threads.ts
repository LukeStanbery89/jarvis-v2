/**
 * Client-side transcript store for the web chat client.
 *
 * The server persists LangGraph thread state but no readable message
 * history, so the UI keeps transcripts in localStorage, namespaced per
 * username and keyed by `sessionId` (the same id the server's session ledger
 * and the wire protocol use). Threads created on other clients surface in
 * the sidebar through `GET /api/sessions` and simply start empty; first
 * prompt continues their thread.
 *
 * Message records distinguish user text, assistant text (which grows as
 * chunks stream in, and can carry an `error` marker so failures are styled
 * distinctly and never re-rendered as ordinary prose), and tool/toolResult
 * notices.
 *
 * All mutation helpers are **pure** (they return new maps) so a React
 * reducer can own the state; persistence is the separate `saveThreads`
 * call, capped per thread and with a quota-failure fallback (evict the
 * oldest whole thread once, then give up — the in-memory copy keeps
 * working). The `Storage` handle is injected so node tests can run without
 * a DOM.
 */

/** One user-turn message (plain text, rendered verbatim). */
export interface UserMessage {
    id: string;
    role: "user";
    text: string;
    at: number;
}

/**
 * One assistant reply. Grows chunk-by-chunk while streaming; `error` marks
 * a failed turn so the UI can style it as a failure banner instead of prose.
 */
export interface AssistantMessage {
    id: string;
    role: "assistant";
    text: string;
    at: number;
    error?: boolean;
}

/** One tool-call or tool-result notice from the agent loop. */
export interface ToolMessage {
    id: string;
    role: "tool";
    tool: { name: string; args?: unknown; output?: unknown };
    at: number;
}

/** Any transcript message. */
export type ThreadMessage = UserMessage | AssistantMessage | ToolMessage;

/** One conversation: auto-titled, timestamped, message list. */
export interface ThreadRecord {
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ThreadMessage[];
}

/** All of a user's transcripts, keyed by wire `sessionId`. */
export type ThreadMap = Record<string, ThreadRecord>;

/** Title for a freshly created (not yet prompted) conversation. */
export const NEW_CHAT_TITLE = "New chat";

/** Longest message list kept per thread (oldest dropped first). */
const MAX_MESSAGES_PER_THREAD = 200;

/** localStorage leaf holding the per-user thread map. */
export function threadsKey(username: string): string {
    return `jarvis.web.user.${username}.threads`;
}

/** Title of a thread's first user message (first ~60 chars). */
function titleFor(text: string): string {
    const trimmed = text.trim();
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

/** Caps a thread's message list, dropping the oldest entries first. */
function withTrimmedMessages(record: ThreadRecord): ThreadRecord {
    if (record.messages.length <= MAX_MESSAGES_PER_THREAD) {
        return record;
    }
    return {
        ...record,
        messages: record.messages.slice(-MAX_MESSAGES_PER_THREAD),
    };
}

/**
 * Returns the map with a thread guaranteed to exist for `sessionId` (a
 * no-op when present). Used by the "New chat" flow before the first prompt.
 */
export function ensureThread(
    map: ThreadMap,
    sessionId: string,
    at: number = Date.now(),
): ThreadMap {
    if (map[sessionId]) {
        return map;
    }
    return {
        ...map,
        [sessionId]: {
            title: NEW_CHAT_TITLE,
            createdAt: at,
            updatedAt: at,
            messages: [],
        },
    };
}

/**
 * Returns the map with `message` appended to `sessionId`'s thread (creating
 * the thread if needed). Touches `updatedAt` and trims to the message cap.
 * Auto-titles the thread on its first user message.
 */
export function appendMessage(
    map: ThreadMap,
    sessionId: string,
    message: ThreadMessage,
): ThreadMap {
    const existing = map[sessionId] ?? {
        title: NEW_CHAT_TITLE,
        createdAt: message.at,
        updatedAt: message.at,
        messages: [],
    };
    const title =
        existing.title === NEW_CHAT_TITLE && message.role === "user"
            ? titleFor(message.text)
            : existing.title;
    const updated = withTrimmedMessages({
        ...existing,
        title,
        updatedAt: message.at,
        messages: [...existing.messages, message],
    });
    return { ...map, [sessionId]: updated };
}

/**
 * Returns the map with `chunk` appended to the thread's trailing assistant
 * message (created on the first chunk of a turn), streaming-style.
 */
export function appendChunk(
    map: ThreadMap,
    sessionId: string,
    chunk: string,
    at: number = Date.now(),
): ThreadMap {
    const record = map[sessionId];
    if (!record) {
        return map;
    }
    const last = record.messages[record.messages.length - 1];
    if (last?.role === "assistant" && !last.error) {
        const messages = [...record.messages];
        messages[messages.length - 1] = {
            ...last,
            text: last.text + chunk,
        };
        return {
            ...map,
            [sessionId]: { ...record, updatedAt: at, messages },
        };
    }
    return appendMessage(map, sessionId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: chunk,
        at,
    });
}

/**
 * Returns the map with a failed-turn marker appended (or stamped onto the
 * trailing assistant message), so the UI can render the failure distinctly.
 */
export function markAssistantError(
    map: ThreadMap,
    sessionId: string,
    text: string,
    at: number = Date.now(),
): ThreadMap {
    const record = map[sessionId];
    if (!record) {
        return map;
    }
    const last = record.messages[record.messages.length - 1];
    if (last?.role === "assistant" && last.text === "" && !last.error) {
        const messages = [...record.messages];
        messages[messages.length - 1] = { ...last, text, error: true };
        return {
            ...map,
            [sessionId]: { ...record, updatedAt: at, messages },
        };
    }
    return appendMessage(map, sessionId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text,
        at,
        error: true,
    });
}

/** Returns the map without `sessionId`'s thread (a no-op when absent). */
export function deleteThread(map: ThreadMap, sessionId: string): ThreadMap {
    if (!map[sessionId]) {
        return map;
    }
    const next = { ...map };
    delete next[sessionId];
    return next;
}

/**
 * Loads a user's thread map from storage; an absent or corrupt entry loads
 * as empty (a corrupt store never breaks the app).
 */
export function loadThreads(storage: Storage, username: string): ThreadMap {
    const raw = storage.getItem(threadsKey(username));
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as ThreadMap;
        return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Persists a user's thread map.
 *
 * On `QuotaExceededError` the oldest whole thread (by `updatedAt`) is
 * evicted and the write retried once — better to lose one stale conversation
 * than to stop persisting entirely; if the retry also fails, persistence is
 * skipped silently and the in-memory copy keeps working.
 */
export function saveThreads(
    storage: Storage,
    username: string,
    map: ThreadMap,
): void {
    try {
        storage.setItem(threadsKey(username), JSON.stringify(map));
        return;
    } catch (err) {
        if (
            !(err instanceof DOMException) ||
            err.name !== "QuotaExceededError"
        ) {
            throw err;
        }
    }
    // Quota hit: evict the oldest whole thread (by `updatedAt`) and retry
    // once — losing one stale conversation beats losing persistence; if the
    // retry fails too, give up silently (the in-memory copy keeps working).
    const oldest = Object.entries(map).sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt,
    )[0];
    if (!oldest) {
        return;
    }
    try {
        storage.setItem(
            threadsKey(username),
            JSON.stringify(deleteThread(map, oldest[0])),
        );
    } catch {
        // give up: keep the in-memory copy only
    }
}
