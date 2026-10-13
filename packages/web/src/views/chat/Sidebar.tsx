/**
 * The chat sidebar: account header, the location/wake/sign-out controls, the
 * new-chat button, and the merged conversation list.
 *
 * Presentational — props in, events out. The wake button's tooltip comes from
 * the pure `describeWakeState`; the location note/tooltip text from
 * `describeLocationState` (both stay in their `src/` modules so the copy remains
 * node-testable).
 */
import { AudioLines, LogOut, MapPin, SquarePen, Trash2 } from "lucide-react";
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
    onNewChat,
    onOpenThread,
    onRemoveThread,
    onToggleLocation,
    onToggleWake,
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
