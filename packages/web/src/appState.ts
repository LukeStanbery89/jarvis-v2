/**
 * The app-level state the shell owns and the views consume (#90 phases 6b, 6d).
 *
 * Types only, in their own module so a view can name what it receives without
 * importing the shell that builds it (and so `Chat` never becomes a dependency
 * of its own parent).
 *
 * The split this records is the app's whole point: everything that must outlive
 * a route change lives in the shell — the socket above all, because a view that
 * owns the connection disconnects on every navigation and drops the tail of any
 * stream in flight — while a view keeps what is scoped to what it shows (the
 * chat keeps its sessions and its attachments). The voice session and the
 * location share joined that list in phase 6d: a wake word that only listens on
 * one page is not a wake word, and a spoken turn submits into the shell's active
 * thread exactly as a typed one does.
 */
import type { ChatMode } from "@lukestanbery/jarvis-protocol";
import type { StoredCredential } from "./credentials";
import type { BrowserNotifyState } from "./hooks/useBrowserNotify";
import type { UseLocationSharingResult } from "./hooks/useLocationSharing";
import type { NotificationsState } from "./hooks/useNotifications";
import type { PrefsState } from "./hooks/usePrefs";
import type { UseAudioResult } from "./hooks/useAudio";
import type { UseChatClientResult } from "./hooks/useChatClient";
import type { UseThreadsResult } from "./hooks/useThreads";
import type { UseVoiceSessionResult } from "./hooks/useVoiceSession";

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
    /**
     * The microphone (#90 phase 6d): the controller, its lifecycle snapshot, and
     * the mic/wake toggles. App-level, so the wake word listens on every page and
     * a barge-in is heard wherever the reply is playing.
     */
    voice: UseVoiceSessionResult;
    /** The device-location share (#31), app-level for the same reason. */
    location: UseLocationSharingResult;
    /** Whether a turn — typed or spoken — is in flight. */
    turning: boolean;
    /**
     * Runs one turn on the active thread (minting one when nothing is open).
     *
     * Owned by the shell because a voice turn can start on any page; the typed
     * composer calls the same runner, so the two origins cannot drift.
     *
     * @param text - The prompt text (already trimmed by the caller).
     * @param mode - `"text"` for typed prompts, `"voice"` for mic/wake prompts.
     * @param attachmentIds - Ready attachment ids (typed prompts only).
     * @returns Resolves on the terminal `done` frame; throws for the caller to
     *   surface (an error bubble for typed turns, the session's `rejected` state
     *   for voice ones).
     */
    runTurn(
        text: string,
        mode: ChatMode,
        attachmentIds: string[],
    ): Promise<void>;
}
