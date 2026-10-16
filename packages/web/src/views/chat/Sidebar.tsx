/**
 * The chat sidebar: account header, the location/wake/sign-out controls plus the
 * gear (with its unread badge) that opens the settings panel, the new-chat
 * button, and the merged conversation list.
 *
 * Presentational — props in, events out. The wake button's tooltip comes from
 * the pure `describeWakeState`; the location note/tooltip text from
 * `describeLocationState` (both stay in their `src/` modules so the copy remains
 * node-testable).
 */
import {
    AudioLines,
    BellRing,
    LogOut,
    MapPin,
    Settings as SettingsIcon,
    SquarePen,
    Trash2,
} from "lucide-react";
import { describeLocationState, type LocationUiState } from "../../location";
import { describeWakeState, type SidebarRow } from "../../sidebar";

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
    /** Why the location pin looks the way it does. */
    locationState: LocationUiState;
    /** Local wake engines exist and the server serves the model. */
    wakeAvailable: boolean;
    /** The wake-word preference. */
    wakeOn: boolean;
    /** The controller is actively listening for the wake phrase. */
    wakeArmed: boolean;
    /** This browser can raise OS notifications at all. */
    browserNotifyAvailable: boolean;
    /** The OS-notification preference for this browser. */
    browserNotifyOn: boolean;
    /** The OS-notification toggle's label/tooltip (from `browserNotifyState`). */
    browserNotifyLabel: string;
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
    /** Flips location sharing. */
    onToggleLocation(): void;
    /** Flips the wake-word toggle. */
    onToggleWake(): void;
    /** Flips the OS-notification toggle (prompting for permission). */
    onToggleBrowserNotify(): void;
    /** Signs out. */
    onSignOut(): void;
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
    wakeOn,
    wakeArmed,
    browserNotifyAvailable,
    browserNotifyOn,
    browserNotifyLabel,
    unread,
    settingsOpen,
    onOpenSettings,
    onNewChat,
    onOpenThread,
    onRemoveThread,
    onToggleLocation,
    onToggleWake,
    onToggleBrowserNotify,
    onSignOut,
}: SidebarProps) {
    const wakeStateText = describeWakeState(wakeAvailable, wakeArmed);
    return (
        <aside className="sidebar">
            <div className="sidebar-head">
                <span>{username}</span>
                <span className="sidebar-actions">
                    <button
                        type="button"
                        className={
                            locationState === "active"
                                ? "icon-btn location active"
                                : "icon-btn location"
                        }
                        aria-pressed={locationOn}
                        aria-label={describeLocationState(locationState)}
                        title={describeLocationState(locationState)}
                        onClick={onToggleLocation}
                    >
                        <MapPin size={16} />
                    </button>
                    {wakeAvailable && (
                        <button
                            type="button"
                            className={
                                wakeArmed
                                    ? "icon-btn location active"
                                    : "icon-btn location"
                            }
                            aria-pressed={wakeOn}
                            aria-label={wakeStateText}
                            title={wakeStateText}
                            onClick={onToggleWake}
                        >
                            <AudioLines size={16} />
                        </button>
                    )}
                    {browserNotifyAvailable && (
                        <button
                            type="button"
                            className={
                                browserNotifyOn
                                    ? "icon-btn location active"
                                    : "icon-btn location"
                            }
                            aria-pressed={browserNotifyOn}
                            aria-label={browserNotifyLabel}
                            title={browserNotifyLabel}
                            onClick={onToggleBrowserNotify}
                        >
                            <BellRing size={16} />
                        </button>
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
                    <button
                        type="button"
                        className="icon-btn"
                        aria-label="Sign out"
                        title="Sign out"
                        onClick={onSignOut}
                    >
                        <LogOut size={16} />
                    </button>
                </span>
            </div>
            {locationOn && locationState !== "active" && (
                <p className="location-note" role="status">
                    {locationState === "unsupported" &&
                        "Location unavailable — HTTPS or localhost required"}
                    {locationState === "locating" && "Locating…"}
                    {locationState === "denied" &&
                        "Location denied — allow it in the browser, then toggle the pin again"}
                    {locationState === "failed" &&
                        "Location lookup failed — toggle the pin to retry"}
                </p>
            )}
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
