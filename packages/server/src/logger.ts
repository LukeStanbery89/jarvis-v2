/**
 * Shared logger instance for the server package.
 *
 * Emits `[INFO]`/`[DEBUG]`/`[WARN]`/`[ERROR]` lines to stdout/stderr with a
 * timestamp, attributed to the `"server"` tag. Default level is `info`; set
 * `JARVIS_LOG_LEVEL` (debug | info | warn | error) to raise or lower it.
 *
 * See `@jarvis/logger` for the full API.
 */
import { createLogger } from "@jarvis/logger";

export const logger = createLogger({ tag: "server" });
