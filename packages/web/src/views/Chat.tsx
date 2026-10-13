/**
 * The chat view: conversation sidebar + transcript + composer.
 *
 * This is the composition root: it owns the chat-turn orchestration
 * (record → send → settle) and the JSX, while the eight hooks in `hooks/` own
 * their slices of state — the transcript store, the REST session list, the
 * audio player, the chat socket, the voice session, location sharing,
 * attachments, and auto-scroll. The {@link ChatClient} and the
 * {@link VoiceController} are constructed inside those hooks' mount effects, so
 * both survive React's StrictMode double-invoke (previously: a stuck
 * `Disconnected` socket and a dead wake/barge-in controller in dev).
 *
 * Transcript state is a reducer over the pure `threads.ts` helpers, persisted
 * (throttled) to localStorage under the signed-in user's namespace. The
 * sidebar merges the server's `GET /api/sessions` rows (filtered to the
 * caller's own `userId` — owner listings include other accounts) with local
 * threads, so conversations created on other clients appear (empty) and
 * locally-created ones appear before their first server claim.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { StoredCredential } from "../credentials";
import { mergeSessions, describeWakeState } from "../sidebar";
import { determineReady } from "../attachments";
import { useThreads } from "../hooks/useThreads";
import { useSessions } from "../hooks/useSessions";
import { useAudio } from "../hooks/useAudio";
import { useChatClient } from "../hooks/useChatClient";
import { useVoiceSession, voiceStatusText } from "../hooks/useVoiceSession";
import { useLocationSharing } from "../hooks/useLocationSharing";
import { useAttachments } from "../hooks/useAttachments";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { Markdown } from "../Markdown";
import { ToolCall } from "../components/ToolCall";
import {
    type ChatMode,
    type ClientCapability,
} from "@lukestanbery/jarvis-protocol";
import { describeLocationState } from "../location";
import {
    AudioLines,
    Image as ImageIcon,
    LogOut,
    MapPin,
    Mic,
    MicOff,
    Paperclip,
    SendHorizontal,
    Square,
    SquarePen,
    Trash2,
    X,
} from "lucide-react";

/**
 * The capabilities this client announces in its `hello` frame. Module-level so
 * the construction effect sees a stable reference and never re-runs.
 */
const CHAT_CAPABILITIES: ClientCapability[] = [
    "markdown",
    "image",
    "link",
    "audio",
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

    const [draft, setDraft] = useState("");
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
        onWakeCue: () => audio.blip(),
        // Barge-in (#84 P6): the controller's watch hears the user talk over a
        // playing reply; the view's half is to stop local playback immediately
        // (before any server round trip) and cancel the turn. `client` is
        // declared below but only read post-mount (event time), so the closure
        // is safe.
        onBargeIn: () => {
            stopAudio();
            client?.cancelTurn();
        },
    });
    const { voice, snapshot: voiceSnapshot } = voiceUi;

    const { client, status, isStreaming, cancelTurn, sendLocation } =
        useChatClient({
            token: credential.token,
            capabilities: CHAT_CAPABILITIES,
            // `audio` (#83): voice turns from this client are also spoken
            // server-side; the player renders the binary chunks.
            onAudio: (pcm) => audio.play(pcm),
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
            onAuthRejected,
        });

    const { locationOn, locationState, toggleLocation } = useLocationSharing({
        sendLocation,
    });

    /** The scrolling transcript container (auto-scroll target). */
    const transcriptRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    /** The composer textarea (refocused after each turn so chat stays fluid). */
    const composerRef = useRef<HTMLTextAreaElement | null>(null);

    /** Sidebar rows: server sessions merged with local threads, newest first. */
    const entries = useMemo(
        () => mergeSessions(rows, threads),
        [rows, threads],
    );

    const activeThread = activeId !== null ? (threads[activeId] ?? null) : null;
    const transcriptMessages = activeThread?.messages ?? [];
    useAutoScroll(transcriptRef, transcriptMessages, activeId);

    /** Status-line text for the current voice session (null hides it). */
    const voiceStatus =
        voiceSnapshot.state === "speaking" || audioSpeaking
            ? "Speaking…"
            : voiceStatusText(voiceSnapshot);
    /** A voice session that ended in failure, kept until the next press. */
    const voiceErrorText = voiceUi.voiceErrorText;

    /** Tooltip/a11y text for the wake toggle state (#84 P4). */
    const wakeStateText = describeWakeState(
        voiceUi.wakeAvailable,
        voiceSnapshot.wakeArmed,
    );

    // Restore focus to the composer once a streaming turn ends, so the next
    // message can be typed without re-clicking the textarea.
    useEffect(() => {
        if (!streaming) {
            composerRef.current?.focus();
        }
    }, [streaming]);

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

    /** Sends the composer draft (plus any ready attachments) as one chat turn. */
    async function send(): Promise<void> {
        const text = draft.trim();
        const readyIds = determineReady(pending);
        if (text === "" || activeId === null || streaming) {
            return;
        }
        setDraft("");
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

    /** Composer keyboard: Enter sends, Shift+Enter inserts a newline. */
    function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
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
            <aside className="sidebar">
                <div className="sidebar-head">
                    <span>{credential.username}</span>
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
                            onClick={toggleLocation}
                        >
                            <MapPin size={16} />
                        </button>
                        {voiceUi.wakeAvailable && (
                            <button
                                type="button"
                                className={
                                    voiceSnapshot.wakeArmed
                                        ? "icon-btn location active"
                                        : "icon-btn location"
                                }
                                aria-pressed={voiceUi.wakeOn}
                                aria-label={wakeStateText}
                                title={wakeStateText}
                                onClick={toggleWake}
                            >
                                <AudioLines size={16} />
                            </button>
                        )}
                        <button
                            type="button"
                            className="icon-btn"
                            aria-label="Sign out"
                            title="Sign out"
                            onClick={signOut}
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
                    onClick={newChat}
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
                                onClick={() => openThread(entry.id)}
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
                                onClick={() => void remove(entry.id)}
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))}
                </nav>
            </aside>
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
                <div className="transcript" ref={transcriptRef}>
                    {activeThread === null && (
                        <p className="hint">
                            Pick a conversation or start a new one
                        </p>
                    )}
                    {activeThread?.messages.map((message) => {
                        if (message.role === "user") {
                            const ids = message.attachmentIds ?? [];
                            return (
                                <div className="msg user" key={message.id}>
                                    {ids.map((attachmentId) =>
                                        previews[attachmentId] ? (
                                            <img
                                                key={attachmentId}
                                                className="attachment-thumb"
                                                src={previews[attachmentId]}
                                                alt="attached image"
                                            />
                                        ) : (
                                            <ImageIcon
                                                key={attachmentId}
                                                className="attachment-gone"
                                                size={36}
                                                role="img"
                                                aria-label="image not retained"
                                            />
                                        ),
                                    )}
                                    {message.text}
                                </div>
                            );
                        }
                        if (message.role === "tool") {
                            return (
                                <ToolCall
                                    key={message.id}
                                    name={message.tool.name}
                                    args={message.tool.args}
                                    output={message.tool.output}
                                />
                            );
                        }
                        return message.error ? (
                            <div
                                className="msg assistant error"
                                key={message.id}
                            >
                                {message.text}
                            </div>
                        ) : (
                            <div className="msg assistant" key={message.id}>
                                <Markdown text={message.text} />
                            </div>
                        );
                    })}
                </div>
                {voiceStatus !== null && (
                    <p className="voice-status" role="status">
                        {voiceStatus}
                    </p>
                )}
                {voiceErrorText !== null && (
                    <p className="voice-status error" role="alert">
                        {voiceErrorText}
                    </p>
                )}
                {activeId !== null && (
                    <div
                        className="composer"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            if (!streaming) {
                                attachFiles(e.dataTransfer.files);
                            }
                        }}
                    >
                        {pending.length > 0 && (
                            <div className="pending-attachments">
                                {pending.map((chip) => (
                                    <span className="chip" key={chip.id}>
                                        {chip.dataUrl !== "" && (
                                            <img
                                                src={chip.dataUrl}
                                                alt={chip.name}
                                                className="attachment-thumb"
                                            />
                                        )}
                                        <span>
                                            {chip.state.kind === "uploading" &&
                                                `uploading ${chip.name}…`}
                                            {chip.state.kind === "ready" &&
                                                chip.name}
                                            {chip.state.kind === "failed" &&
                                                `${chip.name}: ${chip.state.reason}`}
                                        </span>
                                        <button
                                            type="button"
                                            className="chip-remove"
                                            aria-label={`remove ${chip.name}`}
                                            onClick={() => detachChip(chip.id)}
                                        >
                                            <X size={14} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <input
                            type="file"
                            accept="image/*"
                            multiple
                            hidden
                            ref={fileInputRef}
                            onChange={(e) => {
                                if (e.target.files !== null) {
                                    attachFiles(e.target.files);
                                }
                                e.target.value = "";
                            }}
                        />
                        <button
                            type="button"
                            className={
                                voiceSnapshot.state === "listening"
                                    ? "mic active"
                                    : "mic"
                            }
                            aria-label={
                                !voiceUi.sttAvailable
                                    ? "Voice input unavailable"
                                    : voiceSnapshot.state === "listening"
                                      ? "Stop and transcribe"
                                      : "Start voice input"
                            }
                            title={
                                !voiceUi.sttAvailable
                                    ? "Voice input unavailable — HTTPS or localhost required"
                                    : voiceSnapshot.state === "listening"
                                      ? "Stop and transcribe"
                                      : "Talk to JARVIS"
                            }
                            disabled={
                                streaming ||
                                !voiceUi.sttAvailable ||
                                voiceUi.voiceTurnInFlight
                            }
                            onClick={() => {
                                // The press is the user gesture: resume the
                                // audio context so this session's spoken
                                // response is audible (#83).
                                unlockAudio();
                                voice?.press();
                            }}
                        >
                            {!voiceUi.sttAvailable ? (
                                <MicOff size={18} />
                            ) : (
                                <Mic
                                    size={18}
                                    className={
                                        voiceSnapshot.state === "listening"
                                            ? "pulse"
                                            : undefined
                                    }
                                />
                            )}
                        </button>
                        <button
                            type="button"
                            className="attach"
                            aria-label="attach images"
                            title="Attach images"
                            disabled={streaming}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <Paperclip size={18} />
                        </button>
                        <textarea
                            id="message"
                            name="message"
                            value={draft}
                            placeholder="Message JARVIS…"
                            disabled={streaming}
                            ref={composerRef}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={onKeyDown}
                            onPaste={(e) => {
                                const files = Array.from(
                                    e.clipboardData.files,
                                ).filter((f) => f.type.startsWith("image/"));
                                if (files.length > 0) {
                                    e.preventDefault();
                                    attachFiles(files);
                                }
                            }}
                        />
                        <button
                            type="button"
                            className={
                                streaming
                                    ? "send stop"
                                    : draft.trim() !== ""
                                      ? "send active"
                                      : "send"
                            }
                            aria-label={
                                streaming ? "stop generating" : "send message"
                            }
                            title={
                                streaming ? "Stop generating" : "Send message"
                            }
                            disabled={!streaming && draft.trim() === ""}
                            onClick={() => {
                                if (streaming) {
                                    stopTurn();
                                } else {
                                    void send();
                                }
                            }}
                        >
                            {streaming ? (
                                <Square size={18} />
                            ) : (
                                <SendHorizontal size={18} />
                            )}
                        </button>
                    </div>
                )}
            </section>
        </main>
    );
}
