/**
 * Durable, encrypted conversation history (#122).
 *
 * Checkpoints are the model's working memory; this service is the user's read
 * model. The WS turn path records normalized messages here once, and the REST
 * detail route pages them by row id. Titles are derived from the first user /
 * assistant rows, not from checkpoint internals.
 */
import type {
    AppChatMessage,
    AppDatabase,
    AppSession,
    ChatMessageRole,
} from "@lukestanbery/jarvis-auth";
import type { ToolSource } from "@lukestanbery/jarvis-protocol";
import type { ChatCipher } from "./chatCrypto";
import type { SessionEventPublisher } from "./sessionEvents";

/** How many messages the REST page returns by default. */
export const DEFAULT_HISTORY_PAGE_SIZE = 20;
/** Upper bound for a page request. */
export const MAX_HISTORY_PAGE_SIZE = 50;
/** Bounds applied when the server records a turn. */
export const MAX_STORED_USER_CHARS = 16_000;
export const MAX_STORED_ASSISTANT_CHARS = 32_000;
export const MAX_STORED_TOOL_CHARS = 16_000;
/** Retention: keep this many messages or this many ciphertext bytes. */
export const MAX_TRANSCRIPT_MESSAGES = 2_000;
export const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

/** The plaintext payload inside one encrypted transcript row. */
export type ChatMessagePayload =
    | {
          kind: "user";
          text: string;
          attachmentIds?: string[];
      }
    | {
          kind: "assistant";
          text: string;
          error?: boolean;
      }
    | {
          kind: "tool";
          name: string;
          args?: unknown;
          output?: unknown;
          sources?: ToolSource[];
      };

/** One message the WS turn path asks the service to record. */
export interface ChatTranscriptEntry {
    role: ChatMessageRole;
    payload: ChatMessagePayload;
}

/** One history message as the REST API returns it. */
export interface ChatHistoryMessage {
    id: number;
    role: ChatMessageRole;
    text?: string;
    attachmentIds?: string[];
    error?: boolean;
    tool?: {
        name: string;
        args?: unknown;
        output?: unknown;
        sources?: ToolSource[];
    };
}

/** One page of transcript rows. */
export interface ChatHistoryPage {
    messages: ChatHistoryMessage[];
    hasMore: boolean;
    nextBefore: number | null;
}

/** The cipher + history pair the REST layer needs for session content. */
export interface SessionContentServices {
    history: ChatHistoryService;
    cipher: ChatCipher;
    /** Cross-device notifications; the delete route publishes one. */
    events?: SessionEventPublisher;
}

/** The title-generation input: the first exchange, if it exists. */
export interface FirstExchange {
    user: string | null;
    assistant: string | null;
}

/** The history seam consumed by the REST layer and the WS turn path. */
export interface ChatHistoryService {
    /** Encrypts and appends one turn's normalized messages, returning them. */
    append(
        session: AppSession,
        entries: ChatTranscriptEntry[],
    ): ChatHistoryMessage[];
    /** Reads one page, newest first by default. */
    page(
        session: AppSession,
        opts: { limit?: number; before?: number },
    ): ChatHistoryPage;
    /** The first user/assistant text, used for title generation. */
    firstExchange(session: AppSession): FirstExchange;
    /** Applies the transcript retention limits and marks a trim. */
    enforceRetention(session: AppSession): number;
    /** Deletes the checkpoint thread; the session row cascades transcript rows. */
    deleteThread(threadId: string): Promise<void>;
    /** Decrypts one row for tests and the title path. */
    decrypt(row: AppChatMessage): ChatMessagePayload;
}

/** Truncates a string with a visible marker, staying within `max` chars. */
function capped(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const marker = "\n…[truncated]";
    return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

/** Normalizes a tool output for storage. */
function cappedOutput(output: unknown): unknown {
    if (typeof output === "string") {
        return capped(output, MAX_STORED_TOOL_CHARS);
    }
    try {
        const json = JSON.stringify(output);
        if (json !== undefined && json.length > MAX_STORED_TOOL_CHARS) {
            return capped(json, MAX_STORED_TOOL_CHARS);
        }
    } catch {
        // A non-serializable tool result is left to the existing transport
        // behavior; the model-facing value is what the turn already handled.
    }
    return output;
}

/** Applies the per-message caps before encryption. */
function bounded(entry: ChatTranscriptEntry): ChatTranscriptEntry {
    if (entry.payload.kind === "user") {
        return {
            ...entry,
            payload: {
                ...entry.payload,
                text: capped(entry.payload.text, MAX_STORED_USER_CHARS),
            },
        };
    }
    if (entry.payload.kind === "assistant") {
        return {
            ...entry,
            payload: {
                ...entry.payload,
                text: capped(entry.payload.text, MAX_STORED_ASSISTANT_CHARS),
            },
        };
    }
    return {
        ...entry,
        payload: {
            ...entry.payload,
            output: cappedOutput(entry.payload.output),
        },
    };
}

/** Maps one decrypted payload to the REST shape. */
function toHistoryMessage(
    id: number,
    role: ChatMessageRole,
    payload: ChatMessagePayload,
): ChatHistoryMessage {
    if (payload.kind === "tool") {
        return {
            id,
            role,
            tool: {
                name: payload.name,
                ...(payload.args !== undefined ? { args: payload.args } : {}),
                ...(payload.output !== undefined
                    ? { output: payload.output }
                    : {}),
                ...(payload.sources !== undefined
                    ? { sources: payload.sources }
                    : {}),
            },
        };
    }
    return {
        id,
        role,
        text: payload.text,
        ...(payload.kind === "user" && payload.attachmentIds?.length
            ? { attachmentIds: payload.attachmentIds }
            : {}),
        ...(payload.kind === "assistant" && payload.error
            ? { error: true }
            : {}),
    };
}

/**
 * Builds the transcript service.
 *
 * @param store - The app database (sessions + chat_messages).
 * @param cipher - The shared chat cipher.
 * @returns The history seam.
 */
export function createChatHistoryService(options: {
    store: AppDatabase;
    cipher: ChatCipher;
    deleteThread(threadId: string): Promise<void>;
    /** Retention overrides (tests); production uses the exported constants. */
    limits?: { maxMessages: number; maxBytes: number };
}): ChatHistoryService {
    const { store, cipher, deleteThread } = options;
    const limits = options.limits ?? {
        maxMessages: MAX_TRANSCRIPT_MESSAGES,
        maxBytes: MAX_TRANSCRIPT_BYTES,
    };
    return {
        append(session, entries) {
            if (entries.length === 0) {
                return [];
            }
            const createdAt = new Date().toISOString();
            const boundedEntries = entries.map(bounded);
            const rows = store.appendChatMessages(
                session.id,
                boundedEntries.map((entry) => ({
                    role: entry.role,
                    payload: cipher.encryptJson(entry.payload),
                    createdAt,
                })),
            );
            return rows.map((row, index) =>
                toHistoryMessage(
                    row.id,
                    row.role,
                    boundedEntries[index].payload,
                ),
            );
        },
        page(session, opts) {
            const limit = Math.min(
                MAX_HISTORY_PAGE_SIZE,
                Math.max(
                    1,
                    Math.floor(opts.limit ?? DEFAULT_HISTORY_PAGE_SIZE),
                ),
            );
            const rows = store.listChatMessages(session.id, {
                limit: limit + 1,
                ...(opts.before !== undefined ? { before: opts.before } : {}),
            });
            const hasMore = rows.length > limit;
            const pageRows = hasMore ? rows.slice(1) : rows;
            const messages = pageRows.map((row) =>
                toHistoryMessage(
                    row.id,
                    row.role,
                    cipher.decryptJson(row.payload),
                ),
            );
            return {
                messages,
                hasMore,
                nextBefore:
                    hasMore && messages.length > 0 ? messages[0].id : null,
            };
        },
        firstExchange(session) {
            const rows = store.listFirstChatMessages(session.id, 8);
            let user: string | null = null;
            let assistant: string | null = null;
            for (const row of rows) {
                const payload = cipher.decryptJson<ChatMessagePayload>(
                    row.payload,
                );
                if (payload.kind === "user" && user === null) {
                    user = payload.text;
                } else if (
                    payload.kind === "assistant" &&
                    payload.error !== true &&
                    payload.text.trim() !== "" &&
                    user !== null &&
                    assistant === null
                ) {
                    assistant = payload.text;
                }
            }
            return { user, assistant };
        },
        enforceRetention(session) {
            const removed = store.trimChatMessages(session.id, limits);
            if (removed > 0) {
                store.markSessionHistoryTrimmed(session.threadId);
            }
            return removed;
        },
        async deleteThread(threadId) {
            await deleteThread(threadId);
        },
        decrypt(row) {
            return cipher.decryptJson<ChatMessagePayload>(row.payload);
        },
    };
}
