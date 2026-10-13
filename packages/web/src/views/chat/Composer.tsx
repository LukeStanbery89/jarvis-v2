/**
 * The message composer.
 *
 * Owns the draft text and the textarea/file-input refs, the focus-when-idle
 * effect, and the paste/drop/file-picker plumbing; renders the pending
 * attachments, the mic press, the attach button, and the send↔stop toggle.
 * Presentational plus local draft state — all real work (turn running, upload,
 * audio unlock, voice press) arrives as callbacks.
 *
 * On a send press the draft is trimmed, guarded (`""`/streaming), cleared
 * synchronously, and only then handed to `onSend` — parity with the previous
 * clear-before-await order.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Paperclip, SendHorizontal, Square } from "lucide-react";
import type { VoiceSnapshot } from "@lukestanbery/jarvis-voice";
import type { PendingImage } from "../../attachments";
import { PendingAttachments } from "./PendingAttachments";

/** Props for {@link Composer}. */
export interface ComposerProps {
    /** A turn is streaming (gates everything; send↔stop). */
    streaming: boolean;
    /** An STT engine exists (otherwise the mic is disabled). */
    sttAvailable: boolean;
    /** The voice lifecycle state (drives the mic button's look/labels). */
    voiceState: VoiceSnapshot["state"];
    /** A voice turn is mid-flight (the mic rests until it settles). */
    voiceTurnInFlight: boolean;
    /** The composer's attachment chips. */
    pending: PendingImage[];
    /** Sends the trimmed draft (Chat computes ready ids + clears pending). */
    onSend(text: string): void;
    /** Cancels the in-flight turn. */
    onStop(): void;
    /** Attaches image files (picker, paste, drop). */
    onAttach(files: File[]): void;
    /** Drops one pending chip. */
    onRemoveChip(id: string): void;
    /** The mic press: unlock audio + start/stop a voice session. */
    onMicPress(): void;
}

/**
 * The composer bar.
 *
 * @param props - See {@link ComposerProps}.
 */
export function Composer({
    streaming,
    sttAvailable,
    voiceState,
    voiceTurnInFlight,
    pending,
    onSend,
    onStop,
    onAttach,
    onRemoveChip,
    onMicPress,
}: ComposerProps) {
    const [draft, setDraft] = useState("");
    /** The composer textarea (refocused after each turn so chat stays fluid). */
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // Restore focus to the composer once a streaming turn ends, so the next
    // message can be typed without re-clicking the textarea.
    useEffect(() => {
        if (!streaming) {
            composerRef.current?.focus();
        }
    }, [streaming]);

    /** Trims + guards, clears synchronously, then hands the text to Chat. */
    function submit(): void {
        const text = draft.trim();
        if (text === "" || streaming) {
            return;
        }
        setDraft("");
        onSend(text);
    }

    /** Composer keyboard: Enter sends, Shift+Enter inserts a newline. */
    function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    }

    return (
        <div
            className="composer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                if (!streaming) {
                    onAttach(Array.from(e.dataTransfer.files));
                }
            }}
        >
            <PendingAttachments pending={pending} onRemove={onRemoveChip} />
            <input
                type="file"
                accept="image/*"
                multiple
                hidden
                ref={fileInputRef}
                onChange={(e) => {
                    if (e.target.files !== null) {
                        onAttach(Array.from(e.target.files));
                    }
                    e.target.value = "";
                }}
            />
            <button
                type="button"
                className={voiceState === "listening" ? "mic active" : "mic"}
                aria-label={
                    !sttAvailable
                        ? "Voice input unavailable"
                        : voiceState === "listening"
                          ? "Stop and transcribe"
                          : "Start voice input"
                }
                title={
                    !sttAvailable
                        ? "Voice input unavailable — HTTPS or localhost required"
                        : voiceState === "listening"
                          ? "Stop and transcribe"
                          : "Talk to JARVIS"
                }
                disabled={streaming || !sttAvailable || voiceTurnInFlight}
                onClick={onMicPress}
            >
                {!sttAvailable ? (
                    <MicOff size={18} />
                ) : (
                    <Mic
                        size={18}
                        className={
                            voiceState === "listening" ? "pulse" : undefined
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
                    const files = Array.from(e.clipboardData.files).filter(
                        (f) => f.type.startsWith("image/"),
                    );
                    if (files.length > 0) {
                        e.preventDefault();
                        onAttach(files);
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
                aria-label={streaming ? "stop generating" : "send message"}
                title={streaming ? "Stop generating" : "Send message"}
                disabled={!streaming && draft.trim() === ""}
                onClick={() => {
                    if (streaming) {
                        onStop();
                    } else {
                        submit();
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
    );
}
