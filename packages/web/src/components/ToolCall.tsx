/**
 * Collapsible rendering for one tool-call or tool-result notice.
 *
 * The agent's tool traffic (frames `tool`/`toolResult`) is shown as a
 * compact "Ran tool" disclosure instead of raw JSON — the transcript stays
 * readable while the details remain inspectable. String outputs (a tool's
 * textual answer, like `analyzeImage`'s description) render verbatim;
 * structured outputs render as pretty-printed JSON.
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

/** Formats a tool notice's payload: strings verbatim, everything else as JSON. */
function renderPayload(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** One collapsible tool notice in the transcript. */
export function ToolCall({ name, args, output }: ToolCallProps) {
    return (
        <details className="tool-call">
            <summary>{`Ran tool ${name}`}</summary>
            {hasVisibleArgs(args) && <pre>{renderPayload(args)}</pre>}
            {output !== undefined && <pre>{renderPayload(output)}</pre>}
        </details>
    );
}
