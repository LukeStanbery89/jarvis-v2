/**
 * The chat sidebar: the new-chat button and the merged conversation list.
 *
 * Presentational — props in, events out. The settings moved out of the sidebar
 * to the app's own chrome in #90 phase 6d, along with the two state hints it
 * used to carry: the microphone and the location share belong to the app now,
 * so *every* page has to be able to say they are live, not just this column.
 * What is left here is what the sidebar is actually about — the conversations —
 * which is why the head it used to have is gone rather than empty.
 *
 * A row's delete is a hold-to-delete gesture (#157): the trash icon's ring
 * fills for three seconds and the conversation goes only if the hold completes.
 * The gesture is `HoldToDelete`; this component only supplies the row's name and
 * the existing `onRemoveThread` callback.
 */
import { SquarePen } from "lucide-react";
import type { SidebarRow } from "../../sidebar";
import { HapticButton } from "../app/HapticButton";
import { HoldToDelete } from "../app/HoldToDelete";

/** Props for {@link Sidebar}. */
export interface SidebarProps {
    /** Merged conversation rows, newest first. */
    entries: SidebarRow[];
    /** The active conversation id (the highlighted row). */
    activeId: string | null;
    /** A turn is streaming (thread switching is disabled). */
    streaming: boolean;
    /** Starts a fresh conversation. */
    onNewChat(): void;
    /** Opens a conversation. */
    onOpenThread(id: string): void;
    /**
     * Whether the narrow-screen drawer is showing (#146 phase D). Ignored on
     * wide screens, where the list is a column — the stylesheet decides.
     */
    drawerOpen?: boolean;
    /** Deletes a conversation. */
    onRemoveThread(id: string): void;
}

/**
 * The conversation sidebar.
 *
 * @param props - See {@link SidebarProps}.
 */
export function Sidebar({
    entries,
    activeId,
    streaming,
    onNewChat,
    onOpenThread,
    onRemoveThread,
    drawerOpen = false,
}: SidebarProps) {
    return (
        <aside
            id="chat-threads"
            className={drawerOpen ? "sidebar drawer-open" : "sidebar"}
        >
            <HapticButton
                className="new-chat"
                title="New chat"
                onClick={onNewChat}
            >
                <SquarePen size={16} />
                New chat
            </HapticButton>
            <nav>
                {entries.map((entry) => {
                    const current = entry.id === activeId;
                    return (
                        <div
                            key={entry.id}
                            className={
                                current ? "thread-row active" : "thread-row"
                            }
                        >
                            <button
                                type="button"
                                className="thread-open"
                                disabled={streaming}
                                aria-current={current ? "true" : undefined}
                                onClick={() => onOpenThread(entry.id)}
                                title={
                                    entry.kind === "voice"
                                        ? "voice conversation"
                                        : undefined
                                }
                            >
                                {entry.title}
                                {entry.kind === "voice" ? " (voice)" : ""}
                            </button>
                            <HoldToDelete
                                className="thread-delete"
                                label={entry.title}
                                onDelete={() => onRemoveThread(entry.id)}
                            />
                        </div>
                    );
                })}
            </nav>
        </aside>
    );
}
