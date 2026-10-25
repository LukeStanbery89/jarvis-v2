/**
 * The app shell (#90 phases 6b, 6d): the composition root for everything that
 * has to outlive a route change, and the switch that renders the page the
 * address names.
 *
 * Why the lift: `Chat` owned the socket, so navigating away closed it and coming
 * back reconnected — every step through the app dropped whatever was streaming.
 * The rest of what it owned is not chat-scoped either (the shell needs the
 * socket for notifications, and a fired timer has to ring wherever the user is),
 * so the app-level state lives here and a view receives it as one
 * {@link AppState}.
 *
 * Phase 6d brought the microphone across the same line. A wake word that only
 * listens while one page is open is not a wake word, and the turn a voice match
 * submits into is this shell's active thread, so `useVoiceSession`,
 * `useLocationSharing` and the turn runner live here now. That is also what
 * retires the frame bus: its only subscriber was the chat view's voice effect
 * (`audioStart` → `speaking`), and this module already consumes every frame.
 *
 * What deliberately stays behind in `Chat`: the hooks that are about what the
 * chat *shows* (`useSessions` — the sidebar's server rows), the composer's
 * uploads, and the settings panel's own open/closed state. The chrome is here
 * too: the top bar sits above the view, and the ring renders over it, because
 * both belong to the app rather than to any page in it. The particle field
 * (#146) is the third thing in that category — it is fixed behind the view, so
 * navigating between pages neither restarts it nor unmounts its canvas.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatMode, ClientCapability } from "@lukestanbery/jarvis-protocol";
import type { VoiceController } from "@lukestanbery/jarvis-voice";
import { readNotificationsEnabled } from "./prefs";
import { selectToasts } from "./notifications";
import { snoozeReminder, snoozeRequestFor } from "./snooze";
import { navigate } from "./router";
import { briefLocationState, describeLocationState } from "./location";
import { describeWakeState, wakeIsListening } from "./sidebar";
import { useRoute } from "./hooks/useRoute";
import { useThreads } from "./hooks/useThreads";
import { useAudio } from "./hooks/useAudio";
import { usePrefs } from "./hooks/usePrefs";
import { useNotifications } from "./hooks/useNotifications";
import { useBrowserNotify } from "./hooks/useBrowserNotify";
import { useChatClient } from "./hooks/useChatClient";
import { useJobs } from "./hooks/useJobs";
import { useVoiceSession, voiceStatusLine } from "./hooks/useVoiceSession";
import { useLocationSharing } from "./hooks/useLocationSharing";
import { useAppearance } from "./hooks/useAppearance";
import type { AppState } from "./appState";
import type { StoredCredential } from "./credentials";
import { NavBar } from "./views/app/NavBar";
import { IconRail } from "./views/app/IconRail";
import { ParticleCanvas } from "./particles/ParticleCanvas";
import { Dashboard } from "./views/app/Dashboard";
import { NotificationsPage } from "./views/app/NotificationsPage";
import { RemindersPage, TimersPage } from "./views/app/JobsPages";
import { ToastStack } from "./views/app/Toast";
import { Chat } from "./views/Chat";
import { Settings } from "./views/app/Settings";
import { TimerRing } from "./views/app/TimerRing";

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
    /**
     * Whether the chat's narrow-screen thread drawer is showing (#146 phase D).
     *
     * The control lives in the top bar, which is the shell's, while the drawer
     * it opens belongs to the chat view — so the state sits here and both ends
     * read it. The bar only shows the button on the chat route.
     */
    const [threadsOpen, setThreadsOpen] = useState(false);
    // A navigation leaves the chat, so the drawer must not greet the next visit
    // open — and Escape closes it, the same courtesy the page menu pays.
    useEffect(() => {
        setThreadsOpen(false);
    }, [route]);
    useEffect(() => {
        if (!threadsOpen) {
            return;
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setThreadsOpen(false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [threadsOpen]);

    /** Whether a turn is in flight, typed or spoken (the composer's state). */
    const [turning, setTurning] = useState(false);
    /** Whether the settings panel is showing (the Settings item owns it now). */
    const [settingsOpen, setSettingsOpen] = useState(false);

    const threads = useThreads(credential.username);
    const audio = useAudio();
    /**
     * This browser's visual preferences (#146 phases B2, D): whether the field
     * is mounted, whether the panes blur, and whether the wide-screen rail shows
     * its page labels. Per browser rather than per account — see `appearance.ts`
     * for why.
     */
    const appearance = useAppearance();

    // The settings panel (#143) renders in a view's chrome, but the preference
    // *read* is the shell's: the notification hook's ring policy is gated by the
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

    /**
     * The voice session's controller, read by the socket's frame handler below.
     *
     * A ref rather than the value, because the handler is installed once (see
     * `useChatClient`) and must always reach the live controller.
     */
    const voiceRef = useRef<VoiceController | null>(null);

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
            // The two notes a voice session takes from the wire (#84, #90 phase
            // 6d): the first frame of a turn moves the machine out of `waiting`,
            // and the spoken-audio span takes it to `speaking`. The shell owns
            // them now — the session outlives the view that used to watch, and
            // this handler already sees every frame.
            voiceRef.current?.noteResponseFrame();
            if ("audioStart" in frame) {
                voiceRef.current?.noteAudioStarted();
                // The spoken-audio span carries the sample rate the player
                // decodes at; a text-mode turn never sends it.
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
     * The microphone (#90 phase 6d), owned by the app rather than by the chat.
     *
     * Everything a voice session needs is already above or below this line: the
     * turn it submits goes through {@link runTurn} (the same runner the composer
     * uses), the barge-in watch stops this shell's own playback and cancels this
     * shell's own turn, and `playbackActive` reads the shell's player. The
     * engines are cheap to hold — Vosk loads its worker and model inside
     * `start()`, openWakeWord loads ORT inside `start()` — so the only cost of
     * having the hook here is the wake-support probe on boot and the arming the
     * phase exists for.
     */
    const voice = useVoiceSession({
        submit: (text) => runTurn(text, "voice", []),
        // A wake match pre-empts the previous reply exactly as a barge-in does
        // (#114). The reply's audio outlives its `done` frame — the lifecycle
        // is already `idle` (so the barge watch is disarmed and the detector
        // has re-armed) while the player still has seconds of speech
        // scheduled. Opening the session without stopping playback left the
        // old answer talking over the new command and queued the new answer's
        // audio behind it, which reads as "it kept speaking the last
        // response". `cancelTurn` is a no-op once the turn has settled, so
        // `stopAudio` is the load-bearing half.
        onWakeCue: () => {
            audio.stop();
            socket.client?.cancelTurn();
            audio.audio.blip();
        },
        // Barge-in (#84 P6, #90 phase 6d): the controller's watch hears the user
        // talk over a playing reply; the shell's half is to stop local playback
        // immediately (before any server round trip) and cancel the turn.
        onBargeIn: () => {
            audio.stop();
            socket.client?.cancelTurn();
        },
        // The watch stays armed while the reply can still be heard, including
        // the tail after its `done` frame (see `watchBargeIn`, #114).
        playbackActive: audio.speaking,
    });
    voiceRef.current = voice.voice;

    /**
     * The device's whereabouts (#31), app-level for the same reason as the
     * microphone: it is a fact about this browser, not about the conversation on
     * screen, and the `location` frame goes out over the shell's socket.
     */
    const location = useLocationSharing({ sendLocation: socket.sendLocation });

    /**
     * Runs one turn on the active thread (#90 phases 6b, 6d).
     *
     * One runner for both origins, because the difference between a typed and a
     * spoken turn is the `mode` and the attachments — nothing else about a turn
     * should depend on which page it started from. With no conversation open
     * (only reachable from the microphone: the composer lives in the chat) it
     * mints one and navigates to it, because an answer nobody can see is not an
     * answer. `newChat` sets the active-id ref eagerly for exactly that case: the
     * frames this turn produces are dispatched by that ref, and no render has
     * happened yet when they arrive.
     *
     * @param text - The prompt text (already trimmed by the caller).
     * @param mode - `"text"` for typed prompts, `"voice"` for mic/wake prompts.
     * @param attachmentIds - Ready attachment ids (typed prompts only).
     * @returns Resolves on the terminal `done` frame.
     */
    async function runTurn(
        text: string,
        mode: ChatMode,
        attachmentIds: string[],
    ): Promise<void> {
        if (socket.isStreaming()) {
            throw new Error("another prompt is already in progress");
        }
        const open = threads.activeIdRef.current;
        const sessionId = open ?? threads.newChat();
        if (open === null) {
            navigate("chat");
        }
        threads.dispatch({
            type: "user",
            sessionId,
            text,
            at: Date.now(),
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
        setTurning(true);
        try {
            await socket.client?.prompt(text, sessionId, attachmentIds, mode);
        } finally {
            setTurning(false);
            threads.persist();
            // A turn is where a tool can raise a notification, and a *held
            // back* one (quiet hours, the delivery budget, the user's switch
            // off) is pushed to nobody — the record is the only trace, and it
            // is not in the list until something re-reads it. Without this the
            // notification appeared only after a page reload, which is the
            // "nothing happened" mystery #139 exists to remove.
            notifications.refresh();
        }
    }

    /**
     * Flips the wake-word toggle and persists it (#84 P4). The gesture also
     * unlocks the audio context so the match cue is audible.
     *
     * The shell's, because the panel that holds the toggle is the shell's now
     * (#90 phase 6d) — and because the microphone it arms is the app's.
     */
    function toggleWake(): void {
        if (voice.toggleWake()) {
            audio.unlock();
        }
    }

    /**
     * What the bar says about the microphone and the location share (#90 phase
     * 6d). Derived here rather than inside `NavBar` so the copy keeps one home
     * (`describeWakeState`, `voiceStatusLine`, `briefLocationState`) and the bar
     * stays a reader of strings — the same reason the chat's status line reads
     * `voiceStatusLine` rather than composing its own sentence.
     */
    const voiceStatus = voiceStatusLine(voice.snapshot, audio.speaking);
    const voiceListening = wakeIsListening(
        voice.wakeAvailable,
        voice.wakeArmed,
    );
    const locationHint = location.locationOn
        ? briefLocationState(location.locationState)
        : null;

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
     * The floating toast stack (#90 phases 6b–6c): up to `TOAST_LIMIT` rows, on
     * every page, because a fired reminder has to reach the user wherever they are
     * — and several in the same minute is the normal case, not the edge case.
     * `selectToasts` decides which (reminders, and timers that failed or were
     * missed) and the account's master switch silences the whole thing, as it does
     * the ring.
     */
    const toasts = selectToasts(notifications.notifications, {
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
        voice,
        location,
        turning,
        runTurn,
    };

    /** The page the address names. */
    function currentView(): ReactNode {
        if (route === "home") {
            return (
                <Dashboard
                    username={credential.username}
                    jobs={jobs}
                    notifications={notifications}
                    token={credential.token}
                    unread={notifications.unread}
                />
            );
        }
        if (route === "chat") {
            return (
                <Chat
                    app={state}
                    threadsOpen={threadsOpen}
                    onCloseThreads={() => setThreadsOpen(false)}
                />
            );
        }
        if (route === "notifications") {
            return (
                <NotificationsPage
                    notifications={notifications}
                    jobs={jobs}
                    token={credential.token}
                />
            );
        }
        if (route === "timers") {
            return (
                <TimersPage
                    jobs={jobs}
                    notifications={notifications}
                    token={credential.token}
                />
            );
        }
        // The last route standing: every path the app links to is a real page
        // now, so there is no placeholder left to fall through to.
        return (
            <RemindersPage
                jobs={jobs}
                notifications={notifications}
                token={credential.token}
            />
        );
    }

    return (
        <div
            className="app"
            /* The glass switch is a variable override in CSS (#146 phase B2),
               so turning it off is one attribute rather than a second set of
               pane rules. */
            data-glass={appearance.appearance.glass ? "on" : "off"}
        >
            {/* The background belongs to the app, not to a page (#146): it is
                fixed behind everything and survives every route change, so a
                navigation does not restart the field. Unmounting it when the
                switch is off also stops the loop, rather than hiding a canvas
                that keeps drawing. */}
            {appearance.appearance.particles && (
                <ParticleCanvas
                    energy={audio.energy}
                    disconnected={
                        socket.status === "reconnecting" ||
                        socket.status === "closed"
                    }
                />
            )}
            <NavBar
                username={credential.username}
                unread={notifications.unread}
                threadsOpen={threadsOpen}
                onToggleThreads={() => setThreadsOpen((open) => !open)}
                status={socket.status}
                settingsOpen={settingsOpen}
                onOpenSettings={() => setSettingsOpen(true)}
                voiceStatus={voiceStatus}
                voiceListening={voiceListening}
                voiceLabel={describeWakeState(
                    voice.wakeAvailable,
                    voice.wakeArmed,
                )}
                voiceError={voice.voiceErrorText}
                locationHint={locationHint}
                locationSentence={describeLocationState(location.locationState)}
            />
            {/* The wide-screen rail (#146 phase D): the same destinations as the
                bar's links, as a column, where the display has the width to
                spend on one. Hidden by CSS below its breakpoint. It is the one
                surface the **Navigation labels** switch reaches (#177). */}
            <IconRail
                unread={notifications.unread}
                navLabels={appearance.appearance.navLabels}
                settingsOpen={settingsOpen}
                onOpenSettings={() => setSettingsOpen(true)}
            />
            <div className="app-view">{currentView()}</div>
            {toasts.length > 0 && (
                <ToastStack
                    toasts={toasts}
                    onMarkRead={notifications.markRead}
                    onDismiss={notifications.dismiss}
                    onSnooze={(notification, minutes) => {
                        const request = snoozeRequestFor(notification, minutes);
                        if (request !== null) {
                            snoozeReminder({ notifications, jobs }, request);
                        }
                    }}
                />
            )}
            {notifications.ring !== null && (
                <TimerRing timer={notifications.ring} onStop={stopTimer} />
            )}
            {/* The settings panel (#143) is the app's, not the chat's (#90 phase
                6d): Settings is an item under Notifications in whichever menu
                is showing, so the dialog it opens has to be renderable from
                every page. */}
            <Settings
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                prefs={prefs.prefs}
                prefsLoaded={prefs.loaded}
                prefsSaving={prefs.saving}
                prefsError={prefs.error}
                onPatchPrefs={prefs.patch}
                browserNotifyAvailable={browserNotify.available}
                browserNotifyOn={browserNotify.enabled}
                browserNotifyLabel={browserNotify.label}
                onToggleBrowserNotify={browserNotify.toggle}
                wakeAvailable={voice.wakeAvailable}
                wakeOn={voice.wakeOn}
                wakeArmed={voice.snapshot.wakeArmed}
                onToggleWake={toggleWake}
                locationOn={location.locationOn}
                locationState={location.locationState}
                onToggleLocation={location.toggleLocation}
                particlesOn={appearance.appearance.particles}
                onToggleParticles={() =>
                    appearance.setParticles(!appearance.appearance.particles)
                }
                glassOn={appearance.appearance.glass}
                onToggleGlass={() =>
                    appearance.setGlass(!appearance.appearance.glass)
                }
                navLabelsOn={appearance.appearance.navLabels}
                onToggleNavLabels={() =>
                    appearance.setNavLabels(!appearance.appearance.navLabels)
                }
                onSignOut={() => {
                    socket.client?.close();
                    onSignedOut();
                }}
            />
        </div>
    );
}
