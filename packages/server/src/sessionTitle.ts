/**
 * Conversation titles (#122): an instant excerpt, then a model upgrade.
 *
 * A new thread is labelled from its first prompt the moment it is claimed, so
 * the sidebar never shows a bare thread id. After the first completed turn the
 * title service reads the first user/assistant exchange from the encrypted
 * transcript and asks the local model for a short title. The excerpt remains
 * the fallback if the model call fails; a later completed turn retries.
 *
 * Titles are chat-derived content and are stored encrypted, like message
 * payloads. The plaintext exists only in memory and on the wire frame.
 */
import type { AppDatabase, AppSession } from "@lukestanbery/jarvis-auth";
import type { ChatCipher } from "./chatCrypto";
import { logger } from "./logger";
import type { ChatHistoryService } from "./sessionHistory";

/** Longest title the wire/API accepts. */
export const MAX_SESSION_TITLE_LENGTH = 80;
/** Longest automatic excerpt before ellipsis. */
export const MAX_EXCERPT_LENGTH = 60;

/** The title-generation seam, injectable in tests. */
export type GenerateTitle = (input: {
    user: string | null;
    assistant: string | null;
}) => Promise<string | null>;

/** The title operations the session manager and WS turn path use. */
export interface SessionTitleService {
    /** Sets the excerpt when the session has no title yet. */
    ensureExcerpt(session: AppSession, prompt: string): string | null;
    /**
     * Generates and stores a model title from the first exchange.
     *
     * @returns The plaintext title when it changed, otherwise `null`.
     */
    upgrade(session: AppSession): Promise<string | null>;
}

/** Removes a trailing attachment marker and collapses display whitespace. */
export function titleFromPrompt(prompt: string): string {
    const withoutMarker = prompt
        .replace(/\n*\[attachments:[^\]]*\]\s*$/i, "")
        .trim();
    const collapsed = withoutMarker.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) {
        return "New chat";
    }
    return collapsed.length > MAX_EXCERPT_LENGTH
        ? `${collapsed.slice(0, MAX_EXCERPT_LENGTH - 1)}…`
        : collapsed;
}

/**
 * Sanitizes a model's one-line title.
 *
 * Models often answer with quotes, a `Title:` prefix, or a trailing full stop.
 * The stored title is display text, so those decorations are stripped rather
 * than shown.
 */
export function sanitizeModelTitle(raw: string): string | null {
    let title = raw.replace(/\s+/g, " ").trim();
    const stripQuotes = (value: string): string =>
        value.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
    title = stripQuotes(title);
    title = title.replace(/^title\s*:\s*/i, "");
    title = stripQuotes(title);
    title = title.replace(/[.:;]+$/g, "").trim();
    if (title.length === 0) {
        return null;
    }
    return title.length > MAX_SESSION_TITLE_LENGTH
        ? `${title.slice(0, MAX_SESSION_TITLE_LENGTH - 1)}…`
        : title;
}

/**
 * Builds the title service.
 *
 * @param store - The app database.
 * @param history - The transcript service (first exchange).
 * @param cipher - The shared chat cipher.
 * @param generate - The model title generator.
 */
export function createSessionTitleService(options: {
    store: AppDatabase;
    history: ChatHistoryService;
    cipher: ChatCipher;
    generate: GenerateTitle;
}): SessionTitleService {
    const { store, history, cipher, generate } = options;
    /** In-flight upgrades, so two turns cannot race the same title. */
    const upgrading = new Set<string>();
    return {
        ensureExcerpt(session, prompt) {
            if (session.title !== null) {
                return null;
            }
            const title = titleFromPrompt(prompt);
            store.setSessionTitle(
                session.threadId,
                cipher.encrypt(title),
                "excerpt",
            );
            return title;
        },
        async upgrade(session) {
            if (session.userId === null || session.titleSource === "model") {
                return null;
            }
            if (upgrading.has(session.threadId)) {
                return null;
            }
            upgrading.add(session.threadId);
            try {
                const exchange = history.firstExchange(session);
                if (exchange.user === null) {
                    return null;
                }
                const raw = await generate(exchange);
                if (raw === null) {
                    return null;
                }
                const title = sanitizeModelTitle(raw);
                if (title === null) {
                    return null;
                }
                store.setSessionTitle(
                    session.threadId,
                    cipher.encrypt(title),
                    "model",
                );
                return title;
            } catch (err) {
                logger.warn(
                    `Could not generate a title for ${session.threadId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                return null;
            } finally {
                upgrading.delete(session.threadId);
            }
        },
    };
}
