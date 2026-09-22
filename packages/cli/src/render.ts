/**
 * Renders one prompt's stream to the terminal.
 *
 * Home of the named `PromptHandlers` passed to `ChatClient.prompt`, kept out
 * of the REPL loop (`index.ts`) so the two concerns stay separable: chunk text
 * goes to stdout — reserved for the assistant's reply — while tool activity
 * surfaces as stderr diagnostics through the shared logger.
 */
import type { PromptHandlers } from "./client";
import { logger } from "./logger";

/**
 * The render `PromptHandlers` for a text session: prints chunks as they
 * stream, reports tool calls at `info`, and logs tool results at `debug`.
 */
export const renderHandlers: PromptHandlers = {
    onChunk: (chunk) => {
        process.stdout.write(chunk);
    },
    onTool: (name, args) => {
        logger.info(`Agent calling tool ${name}${describeArgs(args)}`);
    },
    onToolResult: (name, output) => {
        logger.debug(`Tool ${name} returned: ${summarize(output)}`);
    },
};

/** Renders tool args compactly for the stderr diagnostic. */
function describeArgs(args: unknown): string {
    if (args === undefined) {
        return "";
    }
    try {
        return ` ${JSON.stringify(args)}`;
    } catch {
        return " (unprintable args)";
    }
}

/** Truncates a tool result for the stderr diagnostic. */
function summarize(output: unknown): string {
    const rendered =
        typeof output === "string" ? output : JSON.stringify(output);
    if (rendered === undefined || rendered.length <= 120) {
        return rendered ?? "no output";
    }
    return `${rendered.slice(0, 117)}...`;
}
