/**
 * The chat view: conversation sidebar + transcript + composer.
 *
 * Transcript state is a reducer over the pure `threads.ts` helpers, persisted
 * (throttled) to localStorage under the signed-in user's namespace. The
 * sidebar merges the server's `GET /api/sessions` rows (filtered to the
 * caller's own `userId` — owner listings include other accounts) with local
 * threads, so conversations created on other clients appear (empty) and
 * locally-created ones appear before their first server claim.
 *
 * The {@link ChatClient} instance lives for the component's lifetime: it
 * runs the hello+auth handshake on connect, streams turn frames into the
 * reducer, reconnects with backoff on drops, and reports permanent auth
 * failures (invalid/revoked token, or a 401 from REST) up to `App`, which
 * drops back to the login screen.
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { api, ApiError, type SessionSummary } from "../api";
import type { StoredCredential } from "../credentials";
import {
    appendChunk,
    appendMessage,
    appendToolResult,
    deleteThread,
    ensureThread,
    loadThreads,
    markAssistantError,
    saveThreads,
    type ThreadMap,
} from "../threads";
import { ChatClient, type ChatStatus } from "../ChatClient";
import { webSocketUrl } from "../wsUrl";
import { Markdown } from "../Markdown";
import { ToolCall } from "../components/ToolCall";
import { MAX_ATTACHMENTS } from "@lukestanbery/jarvis-protocol";
import { prepareForUpload } from "../downscale/browser";
import {
    LoaderCircle,
    LogOut,
    Paperclip,
    SendHorizontal,
    SquarePen,
    Trash2,
    X,
} from "lucide-react";

/**
 * The upload budget the downscale policy plans against, in bytes.
 *
 * Mirrors the server's per-attachment cap (`DEFAULT_ATTACHMENT_MAX_BYTES`,
 * 4 MiB decoded). There is no endpoint exposing the cap, so the two constants
 * must stay in sync; a drifted server answer surfaces as a 413 and the send
 * path retries once with a stricter budget, so drift degrades gracefully.
 */
const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024;

/** One image attached to the composer, through its upload lifecycle. */
interface PendingImage {
    /** Local chip id (not the server attachment id). */
    id: string;
    name: string;
    /** `data:` preview (R6 — not `blob:`, no revoke bookkeeping). */
    dataUrl: string;
    /** Upload state: in flight, resolved id, or failure text. */
    state:
        | { kind: "uploading" }
        | { kind: "ready"; attachmentId: string }
        | { kind: "failed"; reason: string };
}

/** Transcript-store actions, all flowing through the pure threads helpers. */
type ThreadsAction =
    | {
          type: "user";
          sessionId: string;
          text: string;
          at: number;
          attachmentIds?: string[];
      }
    | { type: "chunk"; sessionId: string; text: string; at: number }
    | {
          type: "tool";
          sessionId: string;
          name: string;
          args?: unknown;
          at: number;
      }
    | {
          type: "toolResult";
          sessionId: string;
          name: string;
          output?: unknown;
          at: number;
      }
    | { type: "assistantError"; sessionId: string; text: string; at: number }
    | { type: "ensure"; sessionId: string; at: number }
    | { type: "deleted"; sessionId: string };

/** Applies one action via the pure helpers (reducer for the thread map). */
function threadsReducer(map: ThreadMap, action: ThreadsAction): ThreadMap {
    switch (action.type) {
        case "user":
            return appendMessage(map, action.sessionId, {
                id: crypto.randomUUID(),
                role: "user",
                text: action.text,
                at: action.at,
                ...(action.attachmentIds?.length
                    ? { attachmentIds: action.attachmentIds }
                    : {}),
            });
        case "chunk":
            return appendChunk(map, action.sessionId, action.text, action.at);
        case "tool":
            return appendMessage(map, action.sessionId, {
                id: crypto.randomUUID(),
                role: "tool",
                tool: { name: action.name, args: action.args },
                at: action.at,
            });
        case "toolResult":
            return appendToolResult(
                map,
                action.sessionId,
                action.name,
                action.output,
                action.at,
            );
        case "assistantError":
            return markAssistantError(
                map,
                action.sessionId,
                action.text,
                action.at,
            );
        case "ensure":
            return ensureThread(map, action.sessionId, action.at);
        case "deleted":
            return deleteThread(map, action.sessionId);
    }
}

/** One merged sidebar row. */
interface SidebarRow {
    id: string;
    title: string;
    lastActive: number;
    kind?: "text" | "voice";
}

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
    const [threads, dispatch] = useReducer(
        threadsReducer,
        credential.username,
        (username: string) => loadThreads(localStorage, username),
    );
    const [activeId, setActiveId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [rows, setRows] = useState<SessionSummary[]>([]);
    const [status, setStatus] = useState<ChatStatus>("connecting");
    const [banner, setBanner] = useState<string | null>(null);
    const [streaming, setStreaming] = useState(false);
    /** Images attached to the composer, with their upload lifecycle (#10). */
    const [pending, setPending] = useState<PendingImage[]>([]);
    /** In-session attachment previews: attachmentId → data: URL (not persisted). */
    const [previews, setPreviews] = useState<Record<string, string>>({});

    /** Latest thread map for the throttled persister. */
    const threadsRef = useRef(threads);
    threadsRef.current = threads;
    /** Latest active thread id (client event closures must not go stale). */
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;
    /** Latest auth-rejection callback (client events must stay fresh). */
    const onAuthRejectedRef = useRef(onAuthRejected);
    onAuthRejectedRef.current = onAuthRejected;
    /** The scrolling transcript container (auto-scroll target). */
    const transcriptRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    /** The composer textarea (refocused after each turn so chat stays fluid). */
    const composerRef = useRef<HTMLTextAreaElement | null>(null);

    /** One chat client for the component's lifetime. */
    const clientRef = useRef<ChatClient | null>(null);
    if (clientRef.current === null) {
        clientRef.current = new ChatClient(webSocketUrl(), {
            token: credential.token,
            capabilities: ["markdown", "image", "link"],
            events: {
                onStatus: (next) => setStatus(next),
                onFrame: (frame) => {
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
                onAuthRejected: () => onAuthRejectedRef.current(),
            },
        });
    }
    const client = clientRef.current;

    /** Fetches the caller's own session rows (401 ⇒ dead credential). */
    const refreshSessions = useCallback(async (): Promise<void> => {
        try {
            const all = await api.listSessions(credential.token);
            setRows(all.filter((row) => row.userId === credential.userId));
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                onAuthRejectedRef.current();
                return;
            }
            // Other failures are non-fatal: the sidebar keeps local threads.
        }
    }, [credential.token, credential.userId]);

    // Connect on mount; close for good on unmount.
    useEffect(() => {
        client.connect();
        void refreshSessions();
        return () => {
            client.close();
        };
    }, [client, refreshSessions]);

    // Throttled trailing persistence: at most one write per 300ms burst of
    // chunk updates (the timer always reads the latest map via the ref), a
    // final write at each turn's end (in `send`), and an unmount flush.
    const saveTimer = useRef<number | null>(null);
    const persist = useCallback((): void => {
        saveThreads(localStorage, credential.username, threadsRef.current);
    }, [credential.username]);
    useEffect(() => {
        if (saveTimer.current !== null) {
            return;
        }
        saveTimer.current = window.setTimeout(() => {
            saveTimer.current = null;
            persist();
        }, 300);
    }, [threads, persist]);
    useEffect(
        () => () => {
            if (saveTimer.current !== null) {
                clearTimeout(saveTimer.current);
                saveTimer.current = null;
                persist();
            }
        },
        [persist],
    );

    /** Sidebar rows: server sessions merged with local threads, newest first. */
    const entries = useMemo<SidebarRow[]>(() => {
        const byId = new Map<string, SidebarRow>();
        for (const row of rows) {
            const local = threads[row.threadId];
            byId.set(row.threadId, {
                id: row.threadId,
                title:
                    local?.title ??
                    (row.threadId.length > 8
                        ? `Thread ${row.threadId.slice(0, 8)}`
                        : `Thread ${row.threadId}`),
                lastActive: Date.parse(row.lastActiveAt) || 0,
                kind: row.kind,
            });
        }
        for (const [id, record] of Object.entries(threads)) {
            const existing = byId.get(id);
            if (existing) {
                existing.lastActive = Math.max(
                    existing.lastActive,
                    record.updatedAt,
                );
            } else {
                byId.set(id, {
                    id,
                    title: record.title,
                    lastActive: record.updatedAt,
                });
            }
        }
        return [...byId.values()].sort((a, b) => b.lastActive - a.lastActive);
    }, [rows, threads]);

    const activeThread = activeId !== null ? (threads[activeId] ?? null) : null;

    // Keep the newest content in view: any message change (own send, streamed
    // chunks, tool notices, or a thread switch) snaps the transcript to the
    // bottom. The effect reads the stable messages reference, so it fires on
    // each store mutation, not merely every render.
    const transcriptMessages = activeThread?.messages ?? [];
    useEffect(() => {
        const el = transcriptRef.current;
        if (el && transcriptMessages.length > 0) {
            el.scrollTop = el.scrollHeight;
        }
    }, [transcriptMessages, activeId]);

    // Restore focus to the composer once a streaming turn ends, so the next
    // message can be typed without re-clicking the textarea.
    useEffect(() => {
        if (!streaming) {
            composerRef.current?.focus();
        }
    }, [streaming]);

    /** Attaches image files: prepare (downscale if needed), then upload. */
    function attachFiles(files: FileList | File[]): void {
        for (const file of Array.from(files)) {
            if (!file.type.startsWith("image/")) {
                setBanner(`${file.name} is not an image`);
                continue;
            }
            if (pending.length >= MAX_ATTACHMENTS) {
                setBanner(`At most ${MAX_ATTACHMENTS} images per message`);
                break;
            }
            const id = crypto.randomUUID();
            setPending((current) => [
                ...current,
                {
                    id,
                    name: file.name || "pasted image",
                    dataUrl: "",
                    state: { kind: "uploading" },
                },
            ]);
            void prepareAndUpload(file, id);
        }
    }

    /** Prepares one file (policy + re-encode) and uploads it, retrying a 413 once stricter. */
    async function prepareAndUpload(file: File, chipId: string): Promise<void> {
        const dataUrl = await readAsDataUrl(file).catch(() => "");
        setPending((c) =>
            c.map((p) => (p.id === chipId ? { ...p, dataUrl } : p)),
        );
        try {
            let prepared = await prepareForUpload(file, UPLOAD_BUDGET_BYTES);
            let uploaded: { attachmentId: string };
            try {
                uploaded = await api.uploadAttachment(
                    credential.token,
                    prepared.base64,
                );
            } catch (err) {
                // One retry at half the reported cap — the "stricter budget"
                // rung for a file that slipped past the client-side policy.
                if (
                    err instanceof ApiError &&
                    err.status === 413 &&
                    err.code === "ATTACHMENT_TOO_LARGE"
                ) {
                    prepared = await prepareForUpload(
                        file,
                        Math.floor((err.maxBytes ?? UPLOAD_BUDGET_BYTES) / 2),
                    );
                    uploaded = await api.uploadAttachment(
                        credential.token,
                        prepared.base64,
                    );
                } else {
                    throw err;
                }
            }
            setPending((c) =>
                c.map((p) =>
                    p.id === chipId
                        ? {
                              ...p,
                              state: {
                                  kind: "ready",
                                  attachmentId: uploaded.attachmentId,
                              },
                          }
                        : p,
                ),
            );
            setPreviews((prev) => ({
                ...prev,
                [uploaded.attachmentId]: dataUrl,
            }));
        } catch (err) {
            setPending((c) =>
                c.map((p) =>
                    p.id === chipId
                        ? {
                              ...p,
                              state: {
                                  kind: "failed",
                                  reason:
                                      err instanceof Error
                                          ? err.message
                                          : "upload failed",
                              },
                          }
                        : p,
                ),
            );
        }
    }

    /** Reads a file as a `data:` URL for its composer chip. */
    async function readAsDataUrl(file: File): Promise<string> {
        const blob = await new Promise<Blob | null>((resolve) => {
            if (file.size <= 4 * 1024 * 1024) {
                resolve(file);
            } else {
                resolve(null); // too big to preview raw; chip shows a note
            }
        });
        if (blob === null) {
            return "";
        }
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () =>
                reject(reader.error ?? new Error("read failed"));
            reader.readAsDataURL(blob);
        });
    }

    /** Drops one pending chip (and its upload, if any). */
    function detachChip(chipId: string): void {
        setPending((c) => c.filter((p) => p.id !== chipId));
    }

    /** Starts a fresh conversation (locally; the server row appears on first prompt). */
    function newChat(): void {
        const id = crypto.randomUUID();
        dispatch({ type: "ensure", sessionId: id, at: Date.now() });
        setActiveId(id);
    }

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
            setActiveId(null);
        }
        void refreshSessions();
    }

    /** Sends the composer draft (plus any ready attachments) as one chat turn. */
    async function send(): Promise<void> {
        const text = draft.trim();
        const sessionId = activeId;
        const readyIds = pending
            .filter((p) => p.state.kind === "ready")
            .map(
                (p) =>
                    (p.state as { kind: "ready"; attachmentId: string })
                        .attachmentId,
            );
        if (text === "" || sessionId === null || streaming) {
            return;
        }
        setDraft("");
        dispatch({
            type: "user",
            sessionId,
            text,
            at: Date.now(),
            attachmentIds: readyIds,
        });
        setPending([]);
        setStreaming(true);
        try {
            await client.prompt(text, sessionId, readyIds);
        } catch (err) {
            dispatch({
                type: "assistantError",
                sessionId,
                text: err instanceof Error ? err.message : "the request failed",
                at: Date.now(),
            });
        } finally {
            setStreaming(false);
            persist();
            void refreshSessions();
        }
    }

    /** Composer keyboard: Enter sends, Shift+Enter inserts a newline. */
    function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
        }
    }

    /** Signs out: tear down the socket, clear the credential. */
    function signOut(): void {
        client.close();
        onSignedOut();
    }

    return (
        <main className="chat">
            <aside className="sidebar">
                <div className="sidebar-head">
                    <span>{credential.username}</span>
                    <button
                        type="button"
                        className="icon-btn"
                        aria-label="Sign out"
                        title="Sign out"
                        onClick={signOut}
                    >
                        <LogOut size={16} />
                    </button>
                </div>
                <button
                    type="button"
                    className="new-chat icon-btn"
                    aria-label="New chat"
                    title="New chat"
                    onClick={newChat}
                >
                    <SquarePen size={16} />
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
                                onClick={() => setActiveId(entry.id)}
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
                                className="thread-delete icon-btn small"
                                aria-label={`Delete ${entry.title}`}
                                title={`Delete ${entry.title}`}
                                onClick={() => void remove(entry.id)}
                            >
                                <Trash2 size={14} />
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
                            Pick a conversation or start a new one — JARVIS
                            answers with rich Markdown in text chats.
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
                                            <span
                                                key={attachmentId}
                                                className="attachment-gone"
                                            >
                                                image not retained
                                            </span>
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
                <div
                    className="composer"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                        e.preventDefault();
                        if (activeId !== null && !streaming) {
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
                        className="attach icon-btn"
                        aria-label="attach images"
                        title="Attach images"
                        disabled={activeId === null || streaming}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <Paperclip size={18} />
                    </button>
                    <textarea
                        id="message"
                        name="message"
                        value={draft}
                        placeholder={
                            activeId === null
                                ? "Pick or start a conversation…"
                                : "Message JARVIS…"
                        }
                        disabled={activeId === null}
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
                        className={draft.trim() !== "" ? "send active" : "send"}
                        disabled={
                            activeId === null ||
                            streaming ||
                            draft.trim() === ""
                        }
                        onClick={() => void send()}
                    >
                        {streaming ? (
                            <LoaderCircle size={18} className="spin" />
                        ) : (
                            <SendHorizontal size={18} />
                        )}
                    </button>
                </div>
            </section>
        </main>
    );
}
