/**
 * Collapsible rendering for one tool-call or tool-result notice.
 *
 * The agent's tool traffic (frames `tool`/`toolResult`) is shown as a
 * compact "Ran tool" disclosure instead of raw JSON — the transcript stays
 * readable while the details remain inspectable.
 */

/** Props for {@link ToolCall}. */
export interface ToolCallProps {
    /** The tool's name. */
    name: string;
    /** The tool's raw JSON input, when it takes any. */
    args?: unknown;
    /** The tool's output, when the notice is a toolResult. */
    output?: unknown;
}

/** One collapsible tool notice in the transcript. */
export function ToolCall({ name, args, output }: ToolCallProps) {
    return (
        <details className="tool-call">
            <summary>{`Ran tool ${name}`}</summary>
            {args !== undefined && <pre>{JSON.stringify(args, null, 2)}</pre>}
            {output !== undefined && (
                <pre>{JSON.stringify(output, null, 2)}</pre>
            )}
        </details>
    );
}
