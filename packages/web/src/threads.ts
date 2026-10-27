/**
 * Client-side transcript store for the web chat client.
 *
 * The server owns durable history (#122): `GET /api/sessions/{threadId}`
 * returns encrypted transcript rows as pages, and the web keeps only thread
 * metadata in `localStorage`. Message bodies live in memory for the open
 * session and are fetched again on reload; that removes the old plaintext
 * transcript cache.
 *
 * Message records distinguish user text, assistant text (which grows as
 * chunks stream in, and can carry an `error` marker so failures are styled
 * distinctly and never re-rendered as ordinary prose), and tool/toolResult
 * notices. A search result's presentation-only `sources` ride along with the
 * tool notice (#199), so the chat can show the answer's original links.
 *
 * All mutation helpers are **pure** (they return new maps) so a React
 * reducer can own the state. `Storage` is injected so node tests can run
 * without a DOM.
 */
import type { ToolSource } from "@lukestanbery/jarvis-protocol";
import type { ChatHistoryMessage, SessionDetail } from "./api";

/** One user-turn message (Markdown, rendered like the assistant's prose). */
export interface UserMessage {
    id: string;
    role: "user";
    text: string;
    at: number;
    /**
     * Attachment ids the turn referenced (#10), when it carried images. Only
     * the ids persist — attachment bytes are transient on the server, so a
     * reloaded transcript shows a muted "image not retained" note instead of
     * a preview.
     */
    attachmentIds?: string[];
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
    tool: {
        name: string;
        args?: unknown;
        output?: unknown;
        /** Original web sources behind a search result (#199). */
        sources?: ToolSource[];
    };
    at: number;
}

/** Any transcript message. */
export type ThreadMessage = UserMessage | AssistantMessage | ToolMessage;

/** One conversation: title, timestamps, the loaded messages, paging state. */
export interface ThreadRecord {
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ThreadMessage[];
    /** Whether the server has older transcript rows for this thread. */
    hasMore?: boolean;
    /** Cursor for the next older page (the oldest loaded message id). */
    nextBefore?: number | null;
}

/** All of a user's transcripts, keyed by wire `sessionId`. */
export type ThreadMap = Record<string, ThreadRecord>;

/** Title for a freshly created (not yet prompted) conversation. */
export const NEW_CHAT_TITLE = "New chat";

/** localStorage leaf holding the per-user thread map. */
export function threadsKey(username: string): string {
    return `jarvis.web.user.${username}.threads`;
}

/** Title of a thread's first user message (first ~60 chars). */
function titleFor(text: string): string {
    const trimmed = text.trim();
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
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

/** Maps one decrypted REST message into the local transcript shape. */
export function historyMessagesToThread(
    messages: ChatHistoryMessage[],
    atBase: number = 0,
): ThreadMessage[] {
    return messages.map((message, index) => {
        const at = atBase + index;
        if (message.role === "tool") {
            return {
                id: `history:${message.id}`,
                role: "tool",
                tool: {
                    name: message.tool.name,
                    ...(message.tool.args !== undefined
                        ? { args: message.tool.args }
                        : {}),
                    ...(message.tool.output !== undefined
                        ? { output: message.tool.output }
                        : {}),
                    ...(message.tool.sources !== undefined
                        ? { sources: message.tool.sources }
                        : {}),
                },
                at,
            };
        }
        if (message.role === "assistant") {
            return {
                id: `history:${message.id}`,
                role: "assistant",
                text: message.text,
                at,
                ...(message.error === true ? { error: true } : {}),
            };
        }
        return {
            id: `history:${message.id}`,
            role: "user",
            text: message.text,
            at,
            ...(message.attachmentIds?.length
                ? { attachmentIds: message.attachmentIds }
                : {}),
        };
    });
}

/**
 * Replaces a thread with the server's page.
 *
 * The server is authoritative; the local title/timestamps are kept only when
 * the server has no value yet. An empty server page is still a valid replace
 * (the thread may simply have no messages); the caller decides whether to
 * keep an unsent local transcript instead.
 */
export function hydrateThread(
    map: ThreadMap,
    sessionId: string,
    detail: SessionDetail,
    at: number = Date.now(),
): ThreadMap {
    const previous = map[sessionId];
    const createdAt = Date.parse(detail.createdAt);
    const updatedAt = Date.parse(detail.lastActiveAt);
    return {
        ...map,
        [sessionId]: {
            title: detail.title ?? previous?.title ?? NEW_CHAT_TITLE,
            createdAt: Number.isFinite(createdAt)
                ? createdAt
                : (previous?.createdAt ?? at),
            updatedAt: Number.isFinite(updatedAt)
                ? updatedAt
                : (previous?.updatedAt ?? at),
            messages: historyMessagesToThread(detail.messages),
            hasMore: detail.hasMore,
            nextBefore: detail.nextBefore,
        },
    };
}

/** Prepends an older page to a thread, preserving its loaded tail. */
export function prependThreadHistory(
    map: ThreadMap,
    sessionId: string,
    detail: SessionDetail,
): ThreadMap {
    const record = map[sessionId];
    if (!record) {
        return hydrateThread(map, sessionId, detail);
    }
    return {
        ...map,
        [sessionId]: {
            ...record,
            messages: [
                ...historyMessagesToThread(detail.messages),
                ...record.messages,
            ],
            hasMore: detail.hasMore,
            nextBefore: detail.nextBefore,
        },
    };
}

/** Updates a thread's title without changing its position or messages. */
export function setThreadTitle(
    map: ThreadMap,
    sessionId: string,
    title: string,
): ThreadMap {
    const record = map[sessionId];
    if (!record || record.title === title) {
        return map;
    }
    return {
        ...map,
        [sessionId]: { ...record, title },
    };
}

/**
 * Returns the map with `message` appended to `sessionId`'s thread (creating
 * the thread if needed). Auto-titles the thread on its first user message.
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
    const updated = {
        ...existing,
        title,
        updatedAt: message.at,
        messages: [...existing.messages, message],
    };
    return { ...map, [sessionId]: updated };
}

/**
 * Returns the map with a tool's result attached.
 *
 * The wire delivers a tool call (`tool`) and its result (`toolResult`) as two
 * frames and the server streams them adjacently, so this merges the output
 * into the trailing `tool` notice when the names match — one "Ran tool" box
 * per call instead of a call box followed by a result box. Anything else
 * (no preceding call, a different tool, or a call that already has output)
 * appends a standalone result notice, keeping out-of-order frames intact.
 *
 * `sources` is the search result's presentation-only original-link list
 * (#199); it is stored beside the output and never changes how the model's
 * text is displayed in the tool disclosure.
 */
export function appendToolResult(
    map: ThreadMap,
    sessionId: string,
    name: string,
    output: unknown,
    at: number = Date.now(),
    sources?: ToolSource[],
): ThreadMap {
    const record = map[sessionId];
    if (record) {
        const last = record.messages[record.messages.length - 1];
        if (
            last?.role === "tool" &&
            last.tool.name === name &&
            last.tool.output === undefined
        ) {
            const messages = [...record.messages];
            messages[messages.length - 1] = {
                ...last,
                tool: {
                    ...last.tool,
                    output,
                    ...(sources !== undefined ? { sources } : {}),
                },
            };
            return {
                ...map,
                [sessionId]: { ...record, updatedAt: at, messages },
            };
        }
    }
    return appendMessage(map, sessionId, {
        id: crypto.randomUUID(),
        role: "tool",
        tool: {
            name,
            output,
            ...(sources !== undefined ? { sources } : {}),
        },
        at,
    });
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
 * The metadata-only form persisted in localStorage.
 *
 * Messages are deliberately stripped: the server owns the encrypted
 * transcript, and a browser copy would be plaintext. Keeping the title and
 * paging cursor means the sidebar can render before the first fetch.
 */
function metadataMap(map: ThreadMap): ThreadMap {
    return Object.fromEntries(
        Object.entries(map).map(([id, record]) => [
            id,
            { ...record, messages: [] },
        ]),
    );
}

/**
 * Loads a user's thread metadata from storage; an absent or corrupt entry
 * loads as empty (a corrupt store never breaks the app). Any message bodies
 * left by an older build are dropped here and overwritten by the next save.
 */
export function loadThreads(storage: Storage, username: string): ThreadMap {
    const raw = storage.getItem(threadsKey(username));
    if (!raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed !== "object" || parsed === null) {
            return {};
        }
        const map: ThreadMap = {};
        for (const [id, value] of Object.entries(parsed)) {
            if (typeof value !== "object" || value === null) {
                continue;
            }
            const record = value as Partial<ThreadRecord>;
            if (
                typeof record.title !== "string" ||
                typeof record.createdAt !== "number" ||
                typeof record.updatedAt !== "number"
            ) {
                continue;
            }
            map[id] = {
                title: record.title,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                messages: [],
                ...(typeof record.hasMore === "boolean"
                    ? { hasMore: record.hasMore }
                    : {}),
                ...(typeof record.nextBefore === "number" ||
                record.nextBefore === null
                    ? { nextBefore: record.nextBefore }
                    : {}),
            };
        }
        return map;
    } catch {
        return {};
    }
}

/**
 * Persists a user's thread metadata.
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
    const metadata = metadataMap(map);
    try {
        storage.setItem(threadsKey(username), JSON.stringify(metadata));
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
    const oldest = Object.entries(metadata).sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt,
    )[0];
    if (!oldest) {
        return;
    }
    try {
        storage.setItem(
            threadsKey(username),
            JSON.stringify(deleteThread(metadata, oldest[0])),
        );
    } catch {
        // give up: keep the in-memory copy only
    }
}
