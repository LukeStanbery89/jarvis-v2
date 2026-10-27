/**
 * Pure sidebar projection for the web chat client.
 *
 * Merges the server's `GET /api/sessions` rows with local thread records into
 * the rows the sidebar renders (owner filtering happens in the caller; this
 * de-dups by id, prefers the local title, keeps the later timestamp, and sorts
 * newest-first), plus the wake-toggle's tooltip text. Kept out of `Chat.tsx`
 * so the merge and the wake description are node-testable without a DOM.
 */
import type { SessionSummary } from "./api";
import { NEW_CHAT_TITLE, type ThreadMap } from "./threads";

/** One merged sidebar row. */
export interface SidebarRow {
    id: string;
    title: string;
    lastActive: number;
    kind?: "text" | "voice";
}

/**
 * Merges the server's session rows with local threads, newest first.
 *
 * A server row for a locally-known thread borrows the local title and the
 * later of the two timestamps; a server row with no local record falls back to
 * a short id-based `Thread <id>` label. Locally-created threads that the
 * server has not claimed yet appear with their own title.
 *
 * @param rows - The caller's own session rows (`GET /api/sessions`).
 * @param threads - The local thread map for the signed-in user.
 * @returns Sidebar rows sorted by descending `lastActive`.
 */
export function mergeSessions(
    rows: SessionSummary[],
    threads: ThreadMap,
): SidebarRow[] {
    const byId = new Map<string, SidebarRow>();
    for (const row of rows) {
        const local = threads[row.threadId];
        const fallback =
            row.threadId.length > 8
                ? `Thread ${row.threadId.slice(0, 8)}`
                : `Thread ${row.threadId}`;
        byId.set(row.threadId, {
            id: row.threadId,
            // Hydration copies the server title into the local record, so a
            // real local title is the freshest value (the live title frame
            // lands there). A newly-created "New chat" defers to the server.
            title:
                local?.title !== undefined && local.title !== NEW_CHAT_TITLE
                    ? local.title
                    : (row.title ?? local?.title ?? fallback),
            lastActive: Date.parse(row.lastActiveAt) || 0,
            kind: row.kind,
        });
    }
    for (const [id, record] of Object.entries(threads)) {
        const existing = byId.get(id);
        if (existing) {
            existing.lastActive = Math.max(
                existing.lastActive,
                record.updatedAt,
            );
        } else {
            byId.set(id, {
                id,
                title: record.title,
                lastActive: record.updatedAt,
            });
        }
    }
    return [...byId.values()].sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * Tooltip/a11y text for the wake-word toggle (#84 P4).
 *
 * @param wakeAvailable - Local engines exist and the server serves the model.
 * @param wakeArmed - The controller is actively listening for the wake phrase.
 * @returns Human text describing the current wake state.
 */
export function describeWakeState(
    wakeAvailable: boolean,
    wakeArmed: boolean,
): string {
    if (!wakeAvailable) {
        return "Wake word unavailable";
    }
    return wakeArmed ? "Listening for “Hey JARVIS”" : "Wake word off";
}

/**
 * A short inline hint for the wake state, or `null` when there is nothing to
 * say.
 *
 * Only an *armed* detector has something worth saying: it is the one wake state
 * with a live microphone, and the settings panel is closed most of the time, so
 * this keeps that fact on screen without keeping a whole button for it. The
 * panel carries the rest (unavailable, off) beside the control itself.
 *
 * The sidebar draws this as a blinking microphone rather than a word, so the
 * text is only the accessible name (see `Sidebar.tsx`).
 *
 * @param wakeAvailable - Local engines exist and the server serves the model.
 * @param wakeArmed - The controller is actively listening for the wake phrase.
 * @returns `true` while a detector is live.
 */
export function wakeIsListening(
    wakeAvailable: boolean,
    wakeArmed: boolean,
): boolean {
    return wakeAvailable && wakeArmed;
}
