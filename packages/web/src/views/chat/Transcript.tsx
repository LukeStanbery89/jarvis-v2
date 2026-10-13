/**
 * The scrolling transcript.
 *
 * Renders each message as a memoized {@link MessageRow} — user text with image
 * previews (or a muted "not retained" note), tool-call notices, and assistant
 * Markdown (or an error banner) — and owns the scroll container's
 * auto-scroll via {@link useAutoScroll}. Presentational: props in, no events
 * out.
 */
import { memo, useRef } from "react";
import { Image as ImageIcon } from "lucide-react";
import { Markdown } from "../../Markdown";
import { ToolCall } from "../../components/ToolCall";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import type { ThreadMessage } from "../../threads";

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
                {message.text}
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

/** Props for {@link Transcript}. */
export interface TranscriptProps {
    /** The active thread's messages. */
    messages: ThreadMessage[];
    /** In-session attachment previews: attachmentId → data: URL. */
    previews: Record<string, string>;
    /** Whether a conversation is open (false ⇒ the empty hint). */
    hasThread: boolean;
    /** The active thread id (an auto-scroll trigger on switch). */
    activeId: string | null;
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
    activeId,
}: TranscriptProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    useAutoScroll(containerRef, messages, activeId);
    return (
        <div className="transcript" ref={containerRef}>
            {!hasThread && (
                <p className="hint">Pick a conversation or start a new one</p>
            )}
            {messages.map((message) => (
                <MessageRow
                    key={message.id}
                    message={message}
                    previews={previews}
                />
            ))}
        </div>
    );
}
