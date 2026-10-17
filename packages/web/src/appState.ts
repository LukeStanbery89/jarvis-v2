/**
 * The app-level state the shell owns and the views consume (#90 phase 6b).
 *
 * Types only, in their own module so a view can name what it receives without
 * importing the shell that builds it (and so `Chat` never becomes a dependency
 * of its own parent).
 *
 * The split this records is the phase's whole point: everything that must
 * outlive a route change lives in the shell — the socket above all, because a
 * view that owns the connection disconnects on every navigation and drops the
 * tail of any stream in flight — while a view keeps what is scoped to what it
 * shows (the chat keeps its sessions, attachments, voice session and location
 * sharing).
 */
import type { StoredCredential } from "./credentials";
import type { BrowserNotifyState } from "./hooks/useBrowserNotify";
import type { FrameBus } from "./hooks/useFrameBus";
import type { NotificationsState } from "./hooks/useNotifications";
import type { PrefsState } from "./hooks/usePrefs";
import type { UseAudioResult } from "./hooks/useAudio";
import type { UseChatClientResult } from "./hooks/useChatClient";
import type { UseThreadsResult } from "./hooks/useThreads";

/** What a view receives from {@link AppShell}. */
export interface AppState {
    /** The signed-in credential (the token itself lives in the socket). */
    credential: StoredCredential;
    /** The credential stopped working — the app must drop to login. */
    onAuthRejected(): void;
    /** The user signed out deliberately. */
    onSignedOut(): void;
    /** The `/ws` client and its wire helpers (the shell owns the connection). */
    socket: UseChatClientResult;
    /** The transcript: threads, the open one, and the reducer's dispatch. */
    threads: UseThreadsResult;
    /** The shared audio player: spoken replies, the alarm, the wake cue. */
    audio: UseAudioResult;
    /** The notification list, the unread count, and the ring/banner split. */
    notifications: NotificationsState;
    /** The account's preference map, as last read or written. */
    prefs: PrefsState;
    /** The OS notification channel (a second way to interrupt). */
    browserNotify: BrowserNotifyState;
    /** Frames, for a view that still needs them (only voice does). */
    frames: FrameBus;
}
