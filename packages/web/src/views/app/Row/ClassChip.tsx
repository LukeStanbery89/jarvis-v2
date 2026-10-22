/**
 * Class chip/eyebrow per presentation (#156).
 */
export interface ClassChipProps {
    kind: string;
    className?: string;
}

export function ClassChip({ kind, className = "" }: ClassChipProps) {
    // Derive color class from kind
    const k = kind.toLowerCase();
    const colorClass = k.includes("timer")
        ? "chip-timer"
        : k.includes("reminder")
          ? "chip-reminder"
          : "chip-notification";
    return (
        <span className={`class-chip ${colorClass} ${className}`.trim()}>
            {kind}
        </span>
    );
}
