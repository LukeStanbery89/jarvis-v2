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

/**
 * Whether to render an args block: only when non-undefined and non-empty
 * (an object with no keys, like a no-argument tool's `{}`, is noise).
 */
function hasVisibleArgs(args: unknown): boolean {
    if (args === undefined) {
        return false;
    }
    if (typeof args === "object" && args !== null && !Array.isArray(args)) {
        return Object.keys(args).length > 0;
    }
    return true;
}

/** One collapsible tool notice in the transcript. */
export function ToolCall({ name, args, output }: ToolCallProps) {
    return (
        <details className="tool-call">
            <summary>{`Ran tool ${name}`}</summary>
            {hasVisibleArgs(args) && <pre>{JSON.stringify(args, null, 2)}</pre>}
            {output !== undefined && (
                <pre>{JSON.stringify(output, null, 2)}</pre>
            )}
        </details>
    );
}
