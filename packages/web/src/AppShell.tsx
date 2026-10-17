/**
 * The app shell (#90 phase 6b): the composition root for everything that has to
 * outlive a route change, and the switch that renders the page the address
 * names.
 *
 * Why the lift: `Chat` owned the socket, so navigating away closed it and coming
 * back reconnected — every step through the app dropped whatever was streaming.
 * The rest of what it owned is not chat-scoped either (the shell needs the
 * socket for notifications, and a fired timer has to ring wherever the user is),
 * so the app-level state lives here and a view receives it as one
 * {@link AppState}.
 *
 * What deliberately stays behind in `Chat`: the conversation's own hooks
 * (`useSessions`, `useAttachments`, `useVoiceSession`, `useLocationSharing`) and
 * the settings panel. The wake path is the riskiest thing in the app and it does
 * not have to move for a route change to survive; moving it would also change
 * *when* the microphone listens, which is a decision for its own phase.
 *
 * The chrome is here too: the top bar sits above the view, and the ring renders
 * over it, because both belong to the app rather than to any page in it.
 */
import { useEffect } from "react";
import type { ReactNode } from "react";
import type { ClientCapability } from "@lukestanbery/jarvis-protocol";
import { readNotificationsEnabled } from "./prefs";
import { selectToast } from "./notifications";
import { useRoute } from "./hooks/useRoute";
import { useThreads } from "./hooks/useThreads";
import { useAudio } from "./hooks/useAudio";
import { useFrameBus } from "./hooks/useFrameBus";
import { usePrefs } from "./hooks/usePrefs";
import { useNotifications } from "./hooks/useNotifications";
import { useBrowserNotify } from "./hooks/useBrowserNotify";
import { useChatClient } from "./hooks/useChatClient";
import { useJobs } from "./hooks/useJobs";
import type { AppState } from "./appState";
import type { StoredCredential } from "./credentials";
import { NavBar } from "./views/app/NavBar";
import { Dashboard } from "./views/app/Dashboard";
import { Toast } from "./views/app/Toast";
import { Chat } from "./views/Chat";
import { PagePlaceholder } from "./views/PagePlaceholder";
import { TimerRing } from "./views/chat/TimerRing";

/**
 * The capabilities this client announces in its `hello` frame. Module-level so
 * the construction effect sees a stable reference and never re-runs.
 */
const CHAT_CAPABILITIES: ClientCapability[] = [
    "markdown",
    "image",
    "link",
    "audio",
    // The out-of-turn `notification` frame (#139): this client renders
    // notifications, so the server may push them to its sockets.
    "notification",
];

/**
 * The pages that exist as addresses before they exist as content (#90 phase
 * 6b). Kept beside the switch, because the copy belongs to the placeholder and
 * not to the router.
 */
const PENDING_PAGES: Record<
    "timers" | "reminders" | "notifications",
    { title: string; note: string }
> = {
    timers: {
        title: "Timers",
        note: "Every countdown you have running, and how long is left.",
    },
    reminders: {
        title: "Reminders",
        note: "What the assistant will remind you about, and when.",
    },
    notifications: {
        title: "Notifications",
        note: "What JARVIS has reported, newest first.",
    },
};

/** Props for {@link AppShell}. */
export interface AppShellProps {
    /** The signed-in credential. */
    credential: StoredCredential;
    /** The credential stopped working — the app must drop to login. */
    onAuthRejected(): void;
    /** The user signed out deliberately. */
    onSignedOut(): void;
}

/**
 * The signed-in app: the app-level state, the page the address names, and the
 * overlays that belong to no page in particular.
 */
export function AppShell({
    credential,
    onAuthRejected,
    onSignedOut,
}: AppShellProps) {
    const route = useRoute();

    const threads = useThreads(credential.username);
    const audio = useAudio();

    // The settings panel (#143) is still the chat's, but the preference *read*
    // is the shell's: the notification hook's ring policy is gated by the
    // account's master switch, so it has to happen above that hook.
    const prefs = usePrefs({ token: credential.token });
    /** The account's kill switch: outranks the browser's own preference. */
    const notificationsEnabled = readNotificationsEnabled(prefs.prefs).value;

    // Notifications (#139): the list is fetched over REST and merged with the
    // live frames the socket pushes, which is why the hook is called before the
    // client that feeds it. `notifyEnabled` is the account's master switch: a
    // suppressed notification is still a readable record, but nothing may start
    // ringing on its behalf (#90).
    const notifications = useNotifications({
        token: credential.token,
        notifyEnabled: notificationsEnabled,
    });

    /**
     * Acknowledges the ringing timer (#90 phase 4).
     *
     * `Stop` is the one exit: the notification is dismissed (the durable half)
     * and the alarm stops immediately rather than waiting for the REST round
     * trip. A failed dismissal rolls the row back, and the ring resumes with it
     * — the overlay never claims an acknowledgement the server did not get.
     */
    function stopTimer(id: string): void {
        audio.stopRing();
        notifications.dismiss(id);
    }

    // The OS channel (#139 phase 2): a second way to interrupt, for the case
    // where the user is not looking at this tab. Clicking an OS notification
    // comes back here to mark it read.
    const browserNotify = useBrowserNotify({
        username: credential.username,
        notifications: notifications.notifications,
        loaded: notifications.loaded,
        masterEnabled: notificationsEnabled,
        // A timer's OS popup is a Stop: clicking it is an acknowledgement, not
        // a read. Everything else is the notification list's "mark read".
        onOpen: (notification) => {
            if (notification.class === "timer") {
                stopTimer(notification.id);
            } else {
                notifications.markRead(notification.id);
            }
        },
    });

    // The job list lives here because three surfaces read it — the dashboard
    // now, the Timers and Reminders pages next phase — and because a job that
    // just ran is a state change the notification frame already announces.
    const jobs = useJobs({ token: credential.token });

    // Frames reach two places: what the shell does for the whole app (the
    // transcript, the audio queue) and whatever a view subscribed to (only a
    // voice session does — see `useFrameBus`).
    const frames = useFrameBus();

    const socket = useChatClient({
        token: credential.token,
        capabilities: CHAT_CAPABILITIES,
        // `audio` (#83): voice turns from this client are also spoken
        // server-side; the player renders the binary chunks.
        onAudio: (pcm) => audio.audio.play(pcm),
        onNotification: (notification) => {
            notifications.acceptFrame(notification);
            // A job that just ran changed the list the dashboard reads (its
            // state, not its announcement), and this is the one moment a state
            // change is already being pushed to this client.
            if (notification.jobId !== undefined) {
                jobs.refresh();
            }
        },
        onFrame: (frame) => {
            // The spoken-audio span carries the sample rate the player decodes
            // at; a text-mode turn never sends it.
            if ("audioStart" in frame) {
                audio.audio.setFormat(frame.audioStart.sampleRate);
            }
            const sessionId = threads.activeIdRef.current;
            if (sessionId !== null) {
                if ("chunk" in frame) {
                    threads.dispatch({
                        type: "chunk",
                        sessionId,
                        text: frame.chunk,
                        at: Date.now(),
                    });
                } else if ("tool" in frame) {
                    threads.dispatch({
                        type: "tool",
                        sessionId,
                        name: frame.tool.name,
                        args: frame.tool.args,
                        at: Date.now(),
                    });
                } else if ("toolResult" in frame) {
                    threads.dispatch({
                        type: "toolResult",
                        sessionId,
                        name: frame.toolResult.name,
                        output: frame.toolResult.output,
                        at: Date.now(),
                    });
                }
            }
            // Last, so a subscriber sees exactly what the transcript consumed.
            frames.emit(frame);
        },
        // A notification raised while the server could not be reached was
        // pushed to nobody, so the list is the only place it can appear: when
        // the client reports that a connection finally came up after a failed
        // attempt, re-read the page. The client reports that itself, because
        // the status sequence cannot distinguish it (`connecting` and
        // `reconnecting` both precede `connected`) — and the effect that tried
        // to, with a dependency that changes every render, was a fetch loop.
        // `refresh` is a stable `useCallback`.
        onReconnected: notifications.refresh,
        onAuthRejected,
    });

    /**
     * A timer's ring belongs to the alert selection, not to a click: it starts
     * when a fired timer becomes the ring target (or when the next one takes
     * over after a Stop) and stops the moment nothing is owed. The player's
     * `startRing` is idempotent, so a hand-over does not restart the pattern.
     */
    const ringId = notifications.ring?.id ?? null;
    useEffect(() => {
        if (ringId === null) {
            audio.stopRing();
        } else {
            audio.startRing();
        }
    }, [ringId, audio.startRing, audio.stopRing]);

    /**
     * The audio context starts suspended, and only a user gesture may resume
     * it. Unlocking on the mic press alone meant a timer that fired before the
     * user ever touched the mic was silent (#90 phase 4), so the first gesture
     * of any kind — a click, a key, a tap — unlocks it once. In the shell this
     * covers every page: a gesture counted wherever the user happens to be.
     */
    useEffect(() => {
        const unlock = (): void => {
            audio.unlock();
            window.removeEventListener("pointerdown", unlock);
            window.removeEventListener("keydown", unlock);
        };
        window.addEventListener("pointerdown", unlock, { passive: true });
        window.addEventListener("keydown", unlock);
        return () => {
            window.removeEventListener("pointerdown", unlock);
            window.removeEventListener("keydown", unlock);
        };
    }, [audio.unlock]);

    /**
     * The floating toast (#90 phase 6b): one row, on every page, because a fired
     * reminder has to reach the user wherever they are. `selectToast` decides
     * which row (a reminder, or a timer that failed or was missed) and the
     * account's master switch silences the whole thing, as it does the ring.
     */
    const toast = selectToast(notifications.notifications, {
        enabled: notificationsEnabled,
    });

    const state: AppState = {
        credential,
        onAuthRejected,
        onSignedOut,
        socket,
        threads,
        audio,
        notifications,
        prefs,
        browserNotify,
        frames,
    };

    /** The page the address names. */
    function currentView(): ReactNode {
        if (route === "home") {
            return (
                <Dashboard
                    username={credential.username}
                    jobs={jobs}
                    unread={notifications.unread}
                />
            );
        }
        if (route === "chat") {
            return <Chat app={state} />;
        }
        return (
            <PagePlaceholder
                title={PENDING_PAGES[route].title}
                note={PENDING_PAGES[route].note}
            />
        );
    }

    return (
        <div className="app">
            <NavBar unread={notifications.unread} status={socket.status} />
            <div className="app-view">{currentView()}</div>
            {toast !== null && (
                <Toast
                    notification={toast}
                    onMarkRead={notifications.markRead}
                    onDismiss={notifications.dismiss}
                />
            )}
            {notifications.ring !== null && (
                <TimerRing timer={notifications.ring} onStop={stopTimer} />
            )}
        </div>
    );
}
