/**
 * The composer's pending-attachment chips.
 *
 * Renders one chip per attached image — its upload lifecycle text
 * (uploading/ready/failed), an optional preview, and a remove button. Renders
 * nothing when there are no chips. Presentational: props in, events out.
 */
import { X } from "lucide-react";
import type { PendingImage } from "../../attachments";

/** Props for {@link PendingAttachments}. */
export interface PendingAttachmentsProps {
    /** The composer's chips, through their upload lifecycle. */
    pending: PendingImage[];
    /** Drops one chip. */
    onRemove(id: string): void;
}

/**
 * The pending-attachment chip row.
 *
 * @param props - See {@link PendingAttachmentsProps}.
 */
export function PendingAttachments({
    pending,
    onRemove,
}: PendingAttachmentsProps) {
    if (pending.length === 0) {
        return null;
    }
    return (
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
                        {chip.state.kind === "ready" && chip.name}
                        {chip.state.kind === "failed" &&
                            `${chip.name}: ${chip.state.reason}`}
                    </span>
                    <button
                        type="button"
                        className="chip-remove"
                        aria-label={`remove ${chip.name}`}
                        onClick={() => onRemove(chip.id)}
                    >
                        <X size={14} />
                    </button>
                </span>
            ))}
        </div>
    );
}
