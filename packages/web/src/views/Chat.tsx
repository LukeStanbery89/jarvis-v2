/**
 * The chat view: the conversation, its sidebar, and the composer.
 *
 * This used to be the app's composition root. Since #90 phase 6b the shell owns
 * everything that has to survive a route change — the socket, the transcript,
 * the audio player, the notification list and the account's preferences — and
 * hands them to a view as one {@link AppState}. Phase 6d added the microphone,
 * the location share and the settings panel to that list, so what is left here
 * is what the chat *shows*: `runTurn` is the shell's (a spoken turn can start
 * anywhere), Settings is an item under Notifications in the app's menus, and
 * this view renders the transcript, the sidebar's session rows and the composer.
 *
 * The chat is the detailed view of a voice session — the live partial
 * transcript, the stage, and a failed session's reason — while the bar carries
 * the app-level state of one (see `NavBar`). Both read the same snapshot and the
 * same `voiceStatusLine`, so they cannot disagree.
 *
 * Transcript state is a reducer over the pure `threads.ts` helpers (owned by the
 * shell now), with metadata persisted (throttled) to localStorage under the
 * signed-in user's namespace. Opening a thread fetches the newest transcript
 * page from the server; scrolling to the oldest loaded row fetches the next
 * older page and prepends it. The sidebar merges `GET /api/sessions` rows with
 * local metadata, so conversations created on other clients appear with their
 * durable history.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
    /**
     * Whether the narrow-screen thread drawer is showing (#146 phase D).
     *
     * The top bar owns the control, so the shell owns the state; this view owns
     * the drawer it opens and the scrim that closes it.
     */
    threadsOpen: boolean;
    /** Closes the drawer (a pick, the scrim, or Escape in the shell). */
    onCloseThreads(): void;
}

/**
 * The signed-in chat surface: sidebar, transcript, and composer, wired to the
 * `/ws` chat socket and the REST session list.
 */
export function Chat({ app, threadsOpen, onCloseThreads }: ChatProps) {
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
    /** The thread whose newest page is being fetched. */
    const [historyLoading, setHistoryLoading] = useState<string | null>(null);
    /** An older page is in flight; also guards the scroll trigger. */
    const [olderLoading, setOlderLoading] = useState(false);
    const olderRequest = useRef(false);
    /** Per-thread serialized refetches for cross-device activity (#122). */
    const syncChains = useRef(new Map<string, Promise<void>>());
    const sessionActivity = app.sessionSync.activity;
    const sessionDeleted = app.sessionSync.deleted;

    // Another device settled a turn in a thread this one has open. Refetch the
    // newest page and merge it by server id, preserving any older pages the
    // reader already scrolled in. Requests for the same thread are serialized
    // so a slow earlier fetch cannot land after a newer one.
    useEffect(() => {
        if (!sessionActivity) {
            return;
        }
        void refreshSessions();
        if (activeIdRef.current !== sessionActivity.sessionId) {
            return;
        }
        const id = sessionActivity.sessionId;
        const previous = syncChains.current.get(id) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                try {
                    const detail = await api.getSession(credential.token, id, {
                        limit: 20,
                    });
                    if (activeIdRef.current !== id) {
                        return;
                    }
                    dispatch({
                        type: "sync",
                        sessionId: id,
                        detail,
                        at: Date.now(),
                    });
                } catch (err) {
                    if (err instanceof ApiError && err.status === 401) {
                        onAuthRejected();
                        return;
                    }
                    if (err instanceof ApiError && err.status === 404) {
                        dispatch({ type: "deleted", sessionId: id });
                        if (activeIdRef.current === id) {
                            openThread(null);
                        }
                        return;
                    }
                    setBanner(
                        err instanceof Error
                            ? err.message
                            : "could not refresh the conversation",
                    );
                }
            });
        syncChains.current.set(id, next);
        void next.finally(() => {
            if (syncChains.current.get(id) === next) {
                syncChains.current.delete(id);
            }
        });
    }, [
        sessionActivity,
        activeIdRef,
        credential.token,
        dispatch,
        onAuthRejected,
        refreshSessions,
        openThread,
    ]);

    // The shell already removed the deleted thread from the local map. This
    // refreshes the sidebar rows so the server's list agrees.
    useEffect(() => {
        if (sessionDeleted) {
            void refreshSessions();
        }
    }, [sessionDeleted, refreshSessions]);

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
     * Opens a thread and hydrates its newest transcript page.
     *
     * A failure keeps whatever local messages are already in memory; a 404 is
     * the normal shape for an unclaimed local chat, not an error. The
     * `activeIdRef` check makes a slow response harmless when the user picks
     * another conversation while it is in flight.
     */
    async function openWithHistory(id: string): Promise<void> {
        openThread(id);
        setBanner(null);
        setHistoryLoading(id);
        try {
            const detail = await api.getSession(credential.token, id, {
                limit: 20,
            });
            if (activeIdRef.current !== id) {
                return;
            }
            const local = threads[id];
            if (
                detail.messages.length > 0 ||
                local === undefined ||
                local.messages.length === 0
            ) {
                dispatch({
                    type: "hydrate",
                    sessionId: id,
                    detail,
                    at: Date.now(),
                });
            } else if (detail.title !== null) {
                dispatch({
                    type: "title",
                    sessionId: id,
                    title: detail.title,
                });
            }
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                onAuthRejected();
                return;
            }
            if (!(err instanceof ApiError) || err.status !== 404) {
                setBanner(
                    err instanceof Error
                        ? err.message
                        : "could not load the conversation",
                );
            }
        } finally {
            setHistoryLoading((current) => (current === id ? null : current));
        }
    }

    /** Loads the page immediately older than the transcript's first row. */
    async function loadOlder(): Promise<void> {
        if (activeId === null || olderRequest.current) {
            return;
        }
        const record = threads[activeId];
        if (!record?.hasMore || record.nextBefore == null) {
            return;
        }
        olderRequest.current = true;
        setOlderLoading(true);
        try {
            const detail = await api.getSession(credential.token, activeId, {
                limit: 20,
                before: record.nextBefore,
            });
            if (activeIdRef.current === activeId) {
                dispatch({ type: "prepend", sessionId: activeId, detail });
            }
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                onAuthRejected();
                return;
            }
            if (!(err instanceof ApiError) || err.status !== 404) {
                setBanner(
                    err instanceof Error
                        ? err.message
                        : "could not load earlier messages",
                );
            }
        } finally {
            olderRequest.current = false;
            setOlderLoading(false);
        }
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
            {/* Under 48rem the thread list is a drawer over the conversation
                (#146 phase D): the overlay scrim is its own element so the
                press-outside target is a real button rather than a div with a
                click handler. Both are inert on wide screens, where the list is
                a column. */}
            {threadsOpen && (
                <button
                    type="button"
                    className="chat-scrim"
                    aria-label="Close threads"
                    onClick={onCloseThreads}
                />
            )}
            <Sidebar
                entries={entries}
                activeId={activeId}
                streaming={app.turning}
                drawerOpen={threadsOpen}
                onNewChat={() => {
                    onCloseThreads();
                    newChat();
                }}
                onOpenThread={(id) => {
                    onCloseThreads();
                    void openWithHistory(id);
                }}
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
                    hasThread={
                        activeThread !== null ||
                        (activeId !== null && historyLoading === activeId)
                    }
                    historyLoading={
                        activeId !== null && historyLoading === activeId
                    }
                    hasMore={activeThread?.hasMore ?? false}
                    loadingOlder={olderLoading}
                    onLoadOlder={() => void loadOlder()}
                    activeId={activeId}
                    turning={
                        activeId !== null && app.turnSessionId === activeId
                    }
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
