/**
 * The chat sidebar: account header, the settings gear (with its unread badge and
 * the state hints that must stay visible), the new-chat button, and the merged
 * conversation list.
 *
 * Presentational — props in, events out. The four controls that used to live
 * here (location, wake word, desktop notifications, sign out) moved into the
 * settings panel (#143), which is why the only icon button left is the gear.
 * The hints beside it come from the pure modules (`briefLocationState`,
 * `briefWakeState`), so the copy stays node-testable.
 */
import { Mic, Settings as SettingsIcon, SquarePen, Trash2 } from "lucide-react";
import { AppLink } from "../../AppLink";
import {
    briefLocationState,
    describeLocationState,
    type LocationUiState,
} from "../../location";
import {
    describeWakeState,
    wakeIsListening,
    type SidebarRow,
} from "../../sidebar";

/** Props for {@link Sidebar}. */
export interface SidebarProps {
    /** The signed-in account name (header). */
    username: string;
    /** Merged conversation rows, newest first. */
    entries: SidebarRow[];
    /** The active conversation id (the highlighted row). */
    activeId: string | null;
    /** A turn is streaming (thread switching is disabled). */
    streaming: boolean;
    /** The location-sharing preference. */
    locationOn: boolean;
    /** Why the location state hint says what it says. */
    locationState: LocationUiState;
    /** Local wake engines exist and the server serves the model. */
    wakeAvailable: boolean;
    /** The controller is actively listening for the wake phrase. */
    wakeArmed: boolean;
    /** Notifications neither read nor dismissed (the badge over the gear). */
    unread: number;
    /** Whether the settings panel is showing (the gear's `aria-expanded`). */
    settingsOpen: boolean;
    /** Opens the settings panel. */
    onOpenSettings(): void;
    /** Starts a fresh conversation. */
    onNewChat(): void;
    /** Opens a conversation. */
    onOpenThread(id: string): void;
    /** Deletes a conversation. */
    onRemoveThread(id: string): void;
}

/**
 * The conversation sidebar.
 *
 * @param props - See {@link SidebarProps}.
 */
export function Sidebar({
    username,
    entries,
    activeId,
    streaming,
    locationOn,
    locationState,
    wakeAvailable,
    wakeArmed,
    unread,
    settingsOpen,
    onOpenSettings,
    onNewChat,
    onOpenThread,
    onRemoveThread,
}: SidebarProps) {
    // Two states must stay visible while the panel is closed: a live wake
    // detector (a microphone that is on) and a location share that is not
    // delivering. Everything else moved into the panel with its control.
    const wakeStateText = describeWakeState(wakeAvailable, wakeArmed);
    const listening = wakeIsListening(wakeAvailable, wakeArmed);
    const locationHint = locationOn ? briefLocationState(locationState) : null;
    return (
        <aside className="sidebar">
            <div className="sidebar-head">
                {/* The launcher is at `/` (#90 phase 6a). An in-app link
                    rather than a plain anchor, so stepping back to it does not
                    reload the page and drop the conversation. The top bar that
                    takes this over lands in phase 6b. */}
                <span className="sidebar-head-left">
                    <AppLink to="home" className="sidebar-home">
                        Home
                    </AppLink>
                    <span>{username}</span>
                </span>
                <span className="sidebar-actions">
                    {listening && (
                        <span
                            className="sidebar-state"
                            role="status"
                            aria-label={wakeStateText}
                            title={wakeStateText}
                        >
                            <Mic
                                size={14}
                                className="sidebar-state-icon"
                                aria-hidden="true"
                            />
                        </span>
                    )}
                    {locationHint !== null && (
                        <span
                            className="sidebar-state"
                            role="status"
                            title={describeLocationState(locationState)}
                        >
                            {locationHint}
                        </span>
                    )}
                    <button
                        type="button"
                        className="icon-btn"
                        aria-expanded={settingsOpen}
                        aria-controls="settings-panel"
                        aria-label={
                            unread > 0
                                ? `Settings, ${unread} unread notification${unread === 1 ? "" : "s"}`
                                : "Settings"
                        }
                        title="Settings"
                        onClick={onOpenSettings}
                    >
                        <SettingsIcon size={16} aria-hidden="true" />
                        {unread > 0 && (
                            <span className="icon-badge" aria-hidden="true">
                                {unread}
                            </span>
                        )}
                    </button>
                </span>
            </div>
            <button
                type="button"
                className="new-chat"
                title="New chat"
                onClick={onNewChat}
            >
                <SquarePen size={16} />
                New chat
            </button>
            <nav>
                {entries.map((entry) => (
                    <div
                        key={entry.id}
                        className={
                            entry.id === activeId
                                ? "thread-row active"
                                : "thread-row"
                        }
                    >
                        <button
                            type="button"
                            className="thread-open"
                            disabled={streaming}
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
                        <button
                            type="button"
                            className="thread-delete icon-btn"
                            aria-label={`Delete ${entry.title}`}
                            title={`Delete ${entry.title}`}
                            onClick={() => onRemoveThread(entry.id)}
                        >
                            <Trash2 size={16} />
                        </button>
                    </div>
                ))}
            </nav>
        </aside>
    );
}
