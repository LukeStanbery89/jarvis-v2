/**
 * The scrolling transcript.
 *
 * Renders each message as a memoized {@link MessageRow} — user text with image
 * previews (or a muted "not retained" note), tool-call notices, and Markdown
 * for both sides of the conversation (or an error banner) — plus a thinking
 * row while the agent works on the turn and a source list after an answer
 * built from web searches (#199). Owns the scroll container's auto-scroll via
 * {@link useAutoScroll}. Presentational: props in, no events out.
 */
import {
    Fragment,
    memo,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
} from "react";
import { Image as ImageIcon } from "lucide-react";
import { Markdown } from "../../Markdown";
import { ToolCall } from "../../components/ToolCall";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import type { ThreadMessage } from "../../threads";
import { Sources } from "./Sources";
import { groupSources } from "./sourceLinks";

/** Props for one {@link MessageRow}. */
interface MessageRowProps {
    /** The message to render. */
    message: ThreadMessage;
    /** In-session attachment previews: attachmentId → data: URL. */
    previews: Record<string, string>;
}

/**
 * One transcript row, memoized so an unchanged message (and its Markdown tree)
 * is not re-rendered when a later message streams in.
 *
 * @param props - See {@link MessageRowProps}.
 */
const MessageRow = memo(function MessageRow({
    message,
    previews,
}: MessageRowProps) {
    if (message.role === "user") {
        const ids = message.attachmentIds ?? [];
        return (
            <div className="msg user">
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
                <Markdown text={message.text} />
            </div>
        );
    }
    if (message.role === "tool") {
        return (
            <ToolCall
                name={message.tool.name}
                args={message.tool.args}
                output={message.tool.output}
            />
        );
    }
    return message.error ? (
        <div className="msg assistant error">{message.text}</div>
    ) : (
        <div className="msg assistant">
            <Markdown text={message.text} />
        </div>
    );
});

/**
 * The wait between a prompt and the assistant's first visible words.
 *
 * It sits in an ordinary assistant bubble so the conversation keeps its
 * speaker-side alignment and width. The dots are the whole visible surface;
 * `role="status"` carries a visually hidden "JARVIS is working" so a screen
 * reader still gets the same feedback.
 */
function ThinkingRow() {
    return (
        <div className="msg assistant thinking" role="status">
            <span className="thinking-dots" aria-hidden="true">
                <span />
                <span />
                <span />
            </span>
            <span className="thinking-label">JARVIS is working</span>
        </div>
    );
}

/** Props for {@link Transcript}. */
export interface TranscriptProps {
    /** The active thread's messages. */
    messages: ThreadMessage[];
    /** In-session attachment previews: attachmentId → data: URL. */
    previews: Record<string, string>;
    /** Whether a conversation is open (false ⇒ the empty hint). */
    hasThread: boolean;
    /** The newest server page is in flight for this thread. */
    historyLoading?: boolean;
    /** The server has older rows for this thread. */
    hasMore?: boolean;
    /** An older page is in flight. */
    loadingOlder?: boolean;
    /** Fetches the page immediately older than the first loaded row. */
    onLoadOlder?(): void;
    /** The active thread id (an auto-scroll trigger on switch). */
    activeId: string | null;
    /**
     * Whether the in-flight turn belongs to this thread.
     *
     * The shell keeps one turn in flight at a time; this flag is already scoped
     * to the active conversation, so an unrelated open thread never shows its
     * indicator. It disappears once the assistant has visible words (or an
     * error) — a streaming reply is its own feedback.
     */
    turning: boolean;
}

/**
 * The transcript list.
 *
 * @param props - See {@link TranscriptProps}.
 */
export function Transcript({
    messages,
    previews,
    hasThread,
    historyLoading = false,
    hasMore = false,
    loadingOlder = false,
    onLoadOlder,
    activeId,
    turning,
}: TranscriptProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    /** Scroll metrics captured before an older page is prepended. */
    const preserveRef = useRef<{ height: number; top: number } | null>(null);
    /** Tells useAutoScroll to skip the bottom snap for the prepend render. */
    const holdAutoScroll = useRef(false);
    useAutoScroll(containerRef, messages, activeId, turning, {
        hold: holdAutoScroll,
    });

    // Restore the viewport after an older page is inserted above: keep the
    // reader looking at the same row by preserving the distance from the
    // bottom. This runs before the auto-scroll effect; `holdAutoScroll` makes
    // that effect skip this update.
    useLayoutEffect(() => {
        const preserve = preserveRef.current;
        const el = containerRef.current;
        if (preserve && el) {
            el.scrollTop = el.scrollHeight - (preserve.height - preserve.top);
        }
    }, [messages]);
    useEffect(() => {
        if (loadingOlder) {
            return;
        }
        preserveRef.current = null;
        holdAutoScroll.current = false;
    }, [messages, loadingOlder]);

    /** Fills a short thread rather than leaving a hidden scroll trigger. */
    useEffect(() => {
        if (!hasMore || loadingOlder) {
            return;
        }
        const el = containerRef.current;
        if (
            el &&
            messages.length > 0 &&
            el.scrollHeight <= el.clientHeight + 1
        ) {
            preserveRef.current = {
                height: el.scrollHeight,
                top: el.scrollTop,
            };
            holdAutoScroll.current = true;
            onLoadOlder?.();
        }
    }, [hasMore, loadingOlder, messages.length, onLoadOlder]);

    const { byAssistant, currentAssistantId } = useMemo(
        () => groupSources(messages),
        [messages],
    );
    const last = messages[messages.length - 1];
    // A tool call is still part of the agent working, so only an assistant
    // bubble with visible words (or a settled error) ends the wait.
    const showThinking =
        turning &&
        !(
            last?.role === "assistant" &&
            (last.error === true || last.text.trim() !== "")
        );

    /** Scrolls to the top edge, which asks for the previous page. */
    function handleScroll(event: React.UIEvent<HTMLDivElement>): void {
        const el = event.currentTarget;
        if (
            !hasMore ||
            loadingOlder ||
            el.scrollTop > 48 ||
            preserveRef.current !== null
        ) {
            return;
        }
        preserveRef.current = {
            height: el.scrollHeight,
            top: el.scrollTop,
        };
        holdAutoScroll.current = true;
        onLoadOlder?.();
    }

    return (
        <div className="transcript" ref={containerRef} onScroll={handleScroll}>
            {historyLoading && messages.length === 0 && (
                <p className="hint">Loading conversation…</p>
            )}
            {!hasThread && !historyLoading && (
                <p className="hint">Pick a conversation or start a new one</p>
            )}
            {loadingOlder && (
                <p className="history-loading" role="status">
                    Loading earlier messages…
                </p>
            )}
            {messages.map((message) => {
                // Hold the in-flight answer's sources back until the turn
                // settles: a footnote that scrolls into view below a growing
                // bubble would chase the user away from the new words.
                const sources =
                    message.role === "assistant" &&
                    !(turning && message.id === currentAssistantId)
                        ? byAssistant.get(message.id)
                        : undefined;
                return (
                    <Fragment key={message.id}>
                        <MessageRow message={message} previews={previews} />
                        {sources !== undefined && <Sources sources={sources} />}
                    </Fragment>
                );
            })}
            {showThinking && <ThinkingRow />}
        </div>
    );
}
