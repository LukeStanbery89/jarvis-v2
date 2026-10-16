/**
 * The chat view: the ~200-line composition root.
 *
 * It owns the cross-cutting chat-turn orchestration — `runTurn` (record →
 * send → settle), `send` (ready attachment ids + error bubble), `remove`,
 * `signOut`, `toggleWake`, and the socket frame → reducer wiring — over the
 * nine hooks in `hooks/` and the presentational components in `views/chat/`
 * (including the settings panel's open state).
 * The {@link ChatClient} and the {@link VoiceController} are constructed inside
 * those hooks' mount effects, so both survive React's StrictMode double-invoke
 * (previously: a stuck `Disconnected` socket and a dead wake/barge-in
 * controller in dev).
 *
 * Transcript state is a reducer over the pure `threads.ts` helpers, persisted
 * (throttled) to localStorage under the signed-in user's namespace. The
 * sidebar merges the server's `GET /api/sessions` rows (filtered to the
 * caller's own `userId` — owner listings include other accounts) with local
 * threads, so conversations created on other clients appear (empty) and
 * locally-created ones appear before their first server claim.
 */
import { useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { StoredCredential } from "../credentials";
import { mergeSessions } from "../sidebar";
import { determineReady } from "../attachments";
import { useThreads } from "../hooks/useThreads";
import { useSessions } from "../hooks/useSessions";
import { useAudio } from "../hooks/useAudio";
import { useChatClient } from "../hooks/useChatClient";
import { useVoiceSession, voiceStatusText } from "../hooks/useVoiceSession";
import { useLocationSharing } from "../hooks/useLocationSharing";
import { useAttachments } from "../hooks/useAttachments";
import { useNotifications } from "../hooks/useNotifications";
import { useBrowserNotify } from "../hooks/useBrowserNotify";
import { usePrefs } from "../hooks/usePrefs";
import {
    type ChatMode,
    type ClientCapability,
} from "@lukestanbery/jarvis-protocol";
import { Sidebar } from "./chat/Sidebar";
import { Transcript } from "./chat/Transcript";
import { Composer } from "./chat/Composer";
import { Notifications } from "./chat/Notifications";
import { Settings } from "./chat/Settings";

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

/** One chat turn runner (typed or voice-origin), shared via `runTurnRef`. */
type RunTurn = (
    text: string,
    mode: ChatMode,
    attachmentIds: string[],
) => Promise<void>;

/** Props for {@link Chat}. */
export interface ChatProps {
    /** The signed-in credential (token lives inside the chat client only). */
    credential: StoredCredential;
    /** The credential stopped working — the app must drop to login. */
    onAuthRejected: () => void;
    /** The user signed out deliberately. */
    onSignedOut: () => void;
}

/**
 * The signed-in chat surface: sidebar, transcript, and composer, wired to
 * the `/ws` chat socket and the REST session list.
 */
export function Chat({ credential, onAuthRejected, onSignedOut }: ChatProps) {
    const {
        threads,
        activeId,
        activeIdRef,
        openThread,
        newChat,
        persist,
        dispatch,
    } = useThreads(credential.username);
    const { rows, refreshSessions } = useSessions({
        token: credential.token,
        userId: credential.userId,
        onAuthRejected,
    });
    const {
        audio,
        speaking: audioSpeaking,
        stop: stopAudio,
        unlock: unlockAudio,
    } = useAudio();

    const [banner, setBanner] = useState<string | null>(null);
    const [streaming, setStreaming] = useState(false);

    const { pending, previews, attachFiles, detachChip, clearPending } =
        useAttachments({ token: credential.token, onError: setBanner });

    /**
     * Latest turn runner, read by the voice controller's submit seam at call
     * time so its closures never go stale (the seam is installed once).
     */
    const runTurnRef = useRef<RunTurn | null>(null);

    const voiceUi = useVoiceSession({
        submit: (text) => {
            const runTurn = runTurnRef.current;
            if (runTurn === null) {
                return Promise.reject(new Error("chat is not ready"));
            }
            return runTurn(text, "voice", []);
        },
        // A wake match pre-empts the previous reply exactly as a barge-in does
        // (#114). The reply's audio outlives its `done` frame — the lifecycle
        // is already `idle` (so the barge watch is disarmed and the detector
        // has re-armed) while the player still has seconds of speech
        // scheduled. Opening the session without stopping playback left the
        // old answer talking over the new command and queued the new answer's
        // audio behind it, which reads as "it kept speaking the last
        // response". `cancelTurn` is a no-op once the turn has settled, so
        // `stopAudio` is the load-bearing half. `client` is declared below but
        // only read post-mount (event time), so the closure is safe.
        onWakeCue: () => {
            stopAudio();
            client?.cancelTurn();
            audio.blip();
        },
        // Barge-in (#84 P6): the controller's watch hears the user talk over a
        // playing reply; the view's half is to stop local playback immediately
        // (before any server round trip) and cancel the turn. Same closure
        // rule as above.
        onBargeIn: () => {
            stopAudio();
            client?.cancelTurn();
        },
        // The watch stays armed while the reply can still be heard, including
        // the tail after its `done` frame (see `watchBargeIn`, #114).
        playbackActive: audioSpeaking,
    });
    const { voice, snapshot: voiceSnapshot } = voiceUi;

    // Notifications (#139): the list is fetched over REST and merged with the
    // live frames the socket pushes, which is why the hook is called before
    // the client that feeds it.
    const notificationsUi = useNotifications({ token: credential.token });
    const [notificationsOpen, setNotificationsOpen] = useState(false);
    // The OS channel (#139 phase 2): a second way to interrupt, for the case
    // where the user is not looking at this tab. Clicking an OS notification
    // comes back here to mark it read.
    const browserNotify = useBrowserNotify({
        username: credential.username,
        notifications: notificationsUi.notifications,
        loaded: notificationsUi.loaded,
        onOpen: notificationsUi.markRead,
    });
    // The settings panel (#143): the account's own preferences live on the
    // server, the browser's four controls on the hooks below — the panel is
    // where the two are labelled and edited together.
    const prefsUi = usePrefs({ token: credential.token });
    const [settingsOpen, setSettingsOpen] = useState(false);

    const { client, status, isStreaming, cancelTurn, sendLocation } =
        useChatClient({
            token: credential.token,
            capabilities: CHAT_CAPABILITIES,
            // `audio` (#83): voice turns from this client are also spoken
            // server-side; the player renders the binary chunks.
            onAudio: (pcm) => audio.play(pcm),
            onNotification: (notification) =>
                notificationsUi.acceptFrame(notification),
            onFrame: (frame) => {
                // Voice turns watch the first frame (waiting → responding)
                // and the spoken-audio span (audioStart → speaking); frames
                // of text-mode turns fall through the voice reducer.
                voice?.noteResponseFrame();
                if ("audioStart" in frame) {
                    audio.setFormat(frame.audioStart.sampleRate);
                    voice?.noteAudioStarted();
                }
                const sessionId = activeIdRef.current;
                if (sessionId === null) {
                    return;
                }
                if ("chunk" in frame) {
                    dispatch({
                        type: "chunk",
                        sessionId,
                        text: frame.chunk,
                        at: Date.now(),
                    });
                } else if ("tool" in frame) {
                    dispatch({
                        type: "tool",
                        sessionId,
                        name: frame.tool.name,
                        args: frame.tool.args,
                        at: Date.now(),
                    });
                } else if ("toolResult" in frame) {
                    dispatch({
                        type: "toolResult",
                        sessionId,
                        name: frame.toolResult.name,
                        output: frame.toolResult.output,
                        at: Date.now(),
                    });
                }
            },
            // A notification raised while the server could not be reached was
            // pushed to nobody, so the list is the only place it can appear:
            // when the client reports that a connection finally came up after
            // a failed attempt, re-read the page. The client reports that
            // itself, because the status sequence cannot distinguish it
            // (`connecting` and `reconnecting` both precede `connected`) — and
            // the effect that tried to, with a dependency that changes every
            // render, was a fetch loop. `refresh` is a stable `useCallback`.
            onReconnected: notificationsUi.refresh,
            onAuthRejected,
        });

    // A notification raised while the socket was down was pushed to nobody, so
    // the list is the only place it can appear — which the `onReconnected`
    // handler passed to the client above handles.

    const { locationOn, locationState, toggleLocation } = useLocationSharing({
        sendLocation,
    });

    /** Sidebar rows: server sessions merged with local threads, newest first. */
    const entries = useMemo(
        () => mergeSessions(rows, threads),
        [rows, threads],
    );
    const activeThread = activeId !== null ? (threads[activeId] ?? null) : null;
    const transcriptMessages = activeThread?.messages ?? [];

    /** Status-line text for the current voice session (null hides it). */
    const voiceStatus =
        voiceSnapshot.state === "speaking" || audioSpeaking
            ? "Speaking…"
            : voiceStatusText(voiceSnapshot);

    /** Deletes a conversation server-side and locally. */
    async function remove(id: string): Promise<void> {
        try {
            await api.deleteSession(credential.token, id);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status !== 404) {
                setBanner(err instanceof Error ? err.message : "delete failed");
                return;
            }
        }
        dispatch({ type: "deleted", sessionId: id });
        if (activeIdRef.current === id) {
            openThread(null);
            // The composer unmounts with the thread — pending uploads would
            // otherwise resurface on the next opened conversation.
            clearPending();
        }
        void refreshSessions();
    }

    /**
     * Runs one chat turn (typed or voice-origin): records the user message,
     * sends the wire frame, and restores composer focus afterwards. Throws
     * for the caller to surface (typed turns → assistant error bubble,
     * voice turns → the voice session's `rejected` state).
     *
     * @param text - Prompt text (already trimmed by the caller).
     * @param mode - `"text"` for typed prompts, `"voice"` for mic prompts.
     * @param attachmentIds - Ready attachment ids (typed prompts only).
     * @returns Resolves on the terminal `done` frame.
     */
    async function runTurn(
        text: string,
        mode: ChatMode,
        attachmentIds: string[],
    ): Promise<void> {
        const sessionId = activeIdRef.current;
        if (sessionId === null) {
            throw new Error("no conversation is open");
        }
        if (isStreaming()) {
            throw new Error("another prompt is already in progress");
        }
        dispatch({
            type: "user",
            sessionId,
            text,
            at: Date.now(),
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
        setStreaming(true);
        try {
            await client?.prompt(text, sessionId, attachmentIds, mode);
        } finally {
            setStreaming(false);
            persist();
            void refreshSessions();
        }
    }
    // The voice controller reads this at submit time — see runTurnRef.
    runTurnRef.current = runTurn;

    /** Sends the composer text (plus any ready attachments) as one chat turn. */
    async function send(text: string): Promise<void> {
        if (activeId === null) {
            return;
        }
        const readyIds = determineReady(pending);
        clearPending();
        try {
            await runTurn(text, "text", readyIds);
        } catch (err) {
            dispatch({
                type: "assistantError",
                sessionId: activeId,
                text: err instanceof Error ? err.message : "the request failed",
                at: Date.now(),
            });
        }
    }

    /**
     * Cancels the in-flight turn (#84 P6): local playback stops
     * immediately, the wire `cancel` goes out, and the server ends the
     * turn with `done` — the text already streamed stays in the
     * conversation. The same path the barge-in watch drives, wired to the
     * composer's stop button.
     */
    function stopTurn(): void {
        stopAudio();
        cancelTurn();
    }

    /** Signs out: tear down the socket, clear the credential. */
    function signOut(): void {
        client?.close();
        onSignedOut();
    }

    /**
     * Flips the wake-word toggle and persists it (#84 P4). The gesture also
     * unlocks the audio context so the match cue is audible.
     */
    function toggleWake(): void {
        if (voiceUi.toggleWake()) {
            unlockAudio();
        }
    }

    return (
        <main className="chat">
            <Sidebar
                username={credential.username}
                entries={entries}
                activeId={activeId}
                streaming={streaming}
                locationOn={locationOn}
                locationState={locationState}
                wakeAvailable={voiceUi.wakeAvailable}
                wakeArmed={voiceSnapshot.wakeArmed}
                unread={notificationsUi.unread}
                settingsOpen={settingsOpen}
                onOpenSettings={() => setSettingsOpen(true)}
                onNewChat={newChat}
                onOpenThread={openThread}
                onRemoveThread={(id) => void remove(id)}
            />
            <section className="conversation">
                {status !== "connected" && (
                    <p className="status" role="status">
                        {status === "connecting" && "Connecting…"}
                        {status === "reconnecting" &&
                            "Connection dropped — reconnecting…"}
                        {status === "closed" && "Disconnected"}
                    </p>
                )}
                {banner && (
                    <p className="status error" role="alert">
                        {banner}
                    </p>
                )}
                <Notifications
                    banner={notificationsUi.banner}
                    notifications={notificationsUi.notifications}
                    unread={notificationsUi.unread}
                    open={notificationsOpen}
                    onToggle={() => setNotificationsOpen((open) => !open)}
                    onMarkRead={notificationsUi.markRead}
                    onDismiss={notificationsUi.dismiss}
                    onSendTest={notificationsUi.sendTest}
                    lastTest={notificationsUi.lastTest}
                />
                <Transcript
                    messages={transcriptMessages}
                    previews={previews}
                    hasThread={activeThread !== null}
                    activeId={activeId}
                />
                {voiceStatus !== null && (
                    <p className="voice-status" role="status">
                        {voiceStatus}
                    </p>
                )}
                {voiceUi.voiceErrorText !== null && (
                    <p className="voice-status error" role="alert">
                        {voiceUi.voiceErrorText}
                    </p>
                )}
                {activeId !== null && (
                    <Composer
                        streaming={streaming}
                        sttAvailable={voiceUi.sttAvailable}
                        voiceState={voiceSnapshot.state}
                        voiceTurnInFlight={voiceUi.voiceTurnInFlight}
                        pending={pending}
                        onSend={send}
                        onStop={stopTurn}
                        onAttach={attachFiles}
                        onRemoveChip={detachChip}
                        onMicPress={() => {
                            // The press is the user gesture: resume the audio
                            // context so this session's spoken response is
                            // audible (#83).
                            unlockAudio();
                            voice?.press();
                        }}
                    />
                )}
            </section>
            <Settings
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                prefs={prefsUi.prefs}
                prefsLoaded={prefsUi.loaded}
                prefsSaving={prefsUi.saving}
                prefsError={prefsUi.error}
                onPatchPrefs={prefsUi.patch}
                browserNotifyAvailable={browserNotify.available}
                browserNotifyOn={browserNotify.enabled}
                browserNotifyLabel={browserNotify.label}
                onToggleBrowserNotify={browserNotify.toggle}
                wakeAvailable={voiceUi.wakeAvailable}
                wakeOn={voiceUi.wakeOn}
                wakeArmed={voiceSnapshot.wakeArmed}
                onToggleWake={toggleWake}
                locationOn={locationOn}
                locationState={locationState}
                onToggleLocation={toggleLocation}
                onSignOut={signOut}
            />
        </main>
    );
}
