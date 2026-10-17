/**
 * The chat view: the conversation, its sidebar, and the composer.
 *
 * This used to be the app's composition root. Since #90 phase 6b the shell owns
 * everything that has to survive a route change — the socket, the transcript,
 * the audio player, the notification list and the account's preferences — and
 * hands them to a view as one {@link AppState}. What is left here is the
 * conversation's own orchestration: `runTurn` (record → send → settle), `send`
 * (ready attachment ids plus an error bubble), `remove`, `signOut`,
 * `toggleWake`, and the hooks that only make sense while a conversation is on
 * screen — `useSessions` (the sidebar's server rows), `useAttachments` (the
 * composer's uploads), `useVoiceSession` (mic, wake word, barge-in) and
 * `useLocationSharing`.
 *
 * The socket's frames are the one thing this view still listens to: a voice
 * session watches the first frame of a turn (waiting → responding) and the
 * spoken-audio span (`audioStart` → speaking), so it subscribes to the shell's
 * frame bus while it is mounted. Everything else a frame carries has already
 * been handled by then — the transcript dispatch and the player are the shell's.
 *
 * Transcript state is a reducer over the pure `threads.ts` helpers (owned by the
 * shell now), persisted (throttled) to localStorage under the signed-in user's
 * namespace. The sidebar merges the server's `GET /api/sessions` rows (filtered
 * to the caller's own `userId` — owner listings include other accounts) with
 * local threads, so conversations created on other clients appear (empty) and
 * locally-created ones appear before their first server claim.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { mergeSessions } from "../sidebar";
import { determineReady } from "../attachments";
import { useSessions } from "../hooks/useSessions";
import { useVoiceSession, voiceStatusText } from "../hooks/useVoiceSession";
import { useLocationSharing } from "../hooks/useLocationSharing";
import { useAttachments } from "../hooks/useAttachments";
import type { AppState } from "../appState";
import type { ChatMode } from "@lukestanbery/jarvis-protocol";
import { Sidebar } from "./chat/Sidebar";
import { Transcript } from "./chat/Transcript";
import { Composer } from "./chat/Composer";
import { Notifications } from "./chat/Notifications";
import { Settings } from "./chat/Settings";

/** One chat turn runner (typed or voice-origin), shared via `runTurnRef`. */
type RunTurn = (
    text: string,
    mode: ChatMode,
    attachmentIds: string[],
) => Promise<void>;

/** Props for {@link Chat}. */
export interface ChatProps {
    /** The app-level state, owned by the shell (see `appState.ts`). */
    app: AppState;
}

/**
 * The signed-in chat surface: sidebar, transcript, and composer, wired to the
 * `/ws` chat socket and the REST session list.
 */
export function Chat({ app }: ChatProps) {
    const { credential, onAuthRejected, onSignedOut } = app;
    const { client, isStreaming, cancelTurn, sendLocation } = app.socket;
    const {
        threads,
        activeId,
        activeIdRef,
        openThread,
        newChat,
        persist,
        dispatch,
    } = app.threads;
    // The player, the notification list and the preference map belong to the
    // shell; this view only reads them.
    const { audio, speaking: audioSpeaking, stop: stopAudio } = app.audio;
    const notificationsUi = app.notifications;
    const prefsUi = app.prefs;
    const browserNotify = app.browserNotify;
    const frames = app.frames;

    const { rows, refreshSessions } = useSessions({
        token: credential.token,
        userId: credential.userId,
        onAuthRejected,
    });

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
        // `stopAudio` is the load-bearing half. The player and the socket come
        // from the shell (they outlive this view), so the closure is safe.
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

    /**
     * The frames a voice session has to see (#90 phase 6b): the first frame of
     * a turn moves the machine out of `waiting`, and the spoken-audio span takes
     * it to `speaking`. The transcript and the player have already had the frame
     * by the time it reaches here, and a frame that arrives while this view is
     * unmounted is nobody's business — there is no voice session to inform.
     *
     * `voice` is read through a ref so the subscription is installed once: the
     * latest-value pattern the submit seam uses, and it leaves no window between
     * an unsubscribe and a resubscribe for a frame to fall into.
     */
    const voiceRef = useRef(voice);
    voiceRef.current = voice;
    useEffect(
        () =>
            frames.subscribe((frame) => {
                voiceRef.current?.noteResponseFrame();
                if ("audioStart" in frame) {
                    voiceRef.current?.noteAudioStarted();
                }
            }),
        [frames],
    );

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [notificationsOpen, setNotificationsOpen] = useState(false);

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
            // A turn is where a tool can raise a notification, and a *held
            // back* one (quiet hours, the delivery budget, the user's switch
            // off) is pushed to nobody — the record is the only trace, and it
            // is not in the list until something re-reads it. Without this the
            // notification appeared only after a page reload, which is the
            // "nothing happened" mystery #139 exists to remove.
            notificationsUi.refresh();
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
            audio.unlock();
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
                settingsOpen={settingsOpen}
                onOpenSettings={() => setSettingsOpen(true)}
                onNewChat={newChat}
                onOpenThread={openThread}
                onRemoveThread={(id) => void remove(id)}
            />
            <section className="conversation">
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
                    onToggle={() => {
                        const opening = !notificationsOpen;
                        setNotificationsOpen(opening);
                        if (opening) {
                            // Opening the list is the user asking "what is
                            // there?" — and a held-back notification has no
                            // push to announce it, so the fetch is the only way
                            // it ever appears.
                            notificationsUi.refresh();
                        }
                    }}
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
                            audio.unlock();
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
