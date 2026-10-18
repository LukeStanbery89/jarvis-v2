/**
 * The chat view: the conversation, its sidebar, and the composer.
 *
 * This used to be the app's composition root. Since #90 phase 6b the shell owns
 * everything that has to survive a route change — the socket, the transcript,
 * the audio player, the notification list and the account's preferences — and
 * hands them to a view as one {@link AppState}. Phase 6d added the microphone,
 * the location share and the settings panel to that list, so what is left here
 * is what the chat *shows*: `runTurn` is the shell's (a spoken turn can start
 * anywhere), the gear is in the top bar, and this view renders the transcript,
 * the sidebar's session rows and the composer.
 *
 * The chat is the detailed view of a voice session — the live partial
 * transcript, the stage, and a failed session's reason — while the bar carries
 * the app-level state of one (see `NavBar`). Both read the same snapshot and the
 * same `voiceStatusLine`, so they cannot disagree.
 *
 * Transcript state is a reducer over the pure `threads.ts` helpers (owned by the
 * shell now), persisted (throttled) to localStorage under the signed-in user's
 * namespace. The sidebar merges the server's `GET /api/sessions` rows (filtered
 * to the caller's own `userId` — owner listings include other accounts) with
 * local threads, so conversations created on other clients appear (empty) and
 * locally-created ones appear before their first server claim.
 */
import { useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { mergeSessions } from "../sidebar";
import { determineReady } from "../attachments";
import { useSessions } from "../hooks/useSessions";
import { voiceStatusLine } from "../hooks/useVoiceSession";
import { useAttachments } from "../hooks/useAttachments";
import type { AppState } from "../appState";
import { Sidebar } from "./chat/Sidebar";
import { Transcript } from "./chat/Transcript";
import { Composer } from "./chat/Composer";

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
    const { credential, onAuthRejected } = app;
    const { cancelTurn } = app.socket;
    // The turn runner is the shell's: a spoken turn takes the identical path
    // from any page, and the composer is just the typed door to it.
    const runTurn = app.runTurn;
    const { threads, activeId, activeIdRef, openThread, newChat, dispatch } =
        app.threads;
    // The player, the microphone and the location share belong to the shell;
    // this view only reads them.
    const { audio, speaking: audioSpeaking, stop: stopAudio } = app.audio;
    const voiceUi = app.voice;

    const { rows, refreshSessions } = useSessions({
        token: credential.token,
        userId: credential.userId,
        onAuthRejected,
    });

    const [banner, setBanner] = useState<string | null>(null);

    const { pending, previews, attachFiles, detachChip, clearPending } =
        useAttachments({ token: credential.token, onError: setBanner });

    const { voice, snapshot: voiceSnapshot } = voiceUi;

    /** Sidebar rows: server sessions merged with local threads, newest first. */
    const entries = useMemo(
        () => mergeSessions(rows, threads),
        [rows, threads],
    );
    const activeThread = activeId !== null ? (threads[activeId] ?? null) : null;
    const transcriptMessages = activeThread?.messages ?? [];

    /** Status-line text for the current voice session (null hides it). */
    const voiceStatus = voiceStatusLine(voiceSnapshot, audioSpeaking);

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
     * Sends the composer text (plus any ready attachments) as one chat turn.
     *
     * The turn itself is the shell's (`runTurn`), because a spoken turn takes
     * the identical path from any page; what is the composer's is the error
     * bubble, and the session-row refresh, which is the sidebar's own view of a
     * turn. (A voice turn needs neither: the sidebar merges locally-created
     * threads, and it re-reads the server's rows when it mounts.)
     */
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
        } finally {
            void refreshSessions();
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

    return (
        <main className="chat">
            <Sidebar
                entries={entries}
                activeId={activeId}
                streaming={app.turning}
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
                        streaming={app.turning}
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
        </main>
    );
}
