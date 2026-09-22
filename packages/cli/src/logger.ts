/**
 * Shared logger instance for the CLI package.
 *
 * Emits `[INFO]`/`[DEBUG]`/`[WARN]`/`[ERROR]` lines with a timestamp to
 * stderr, attributed to the `"cli"` tag. Diagnostics go to stderr so stdout
 * stays reserved for the streamed assistant response. Default level is
 * `info`; set `JARVIS_LOG_LEVEL` (debug | info | warn | error) to change it.
 *
 * See `@lukestanbery/jarvis-logger` for the full API.
 */
import { createLogger } from "@lukestanbery/jarvis-logger";

export const logger = createLogger({ tag: "cli", stream: process.stderr });
