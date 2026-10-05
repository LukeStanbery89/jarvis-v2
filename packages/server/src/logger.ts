/**
 * Shared logger instance for the server package.
 *
 * Emits `[INFO]`/`[DEBUG]`/`[WARN]`/`[ERROR]` lines to stdout/stderr with a
 * timestamp, attributed to the `"server"` tag. Default level is `info`; set
 * `JARVIS_LOG_LEVEL` (silent | debug | info | warn | error) to raise or lower it.
 * The default drops to `silent` under a test runner, so `npm test` prints only
 * test output; `JARVIS_LOG_LEVEL` still overrides it when a test needs its logs.
 *
 * See `@lukestanbery/jarvis-logger` for the full API.
 */
import { createLogger } from "@lukestanbery/jarvis-logger";

export const logger = createLogger({ tag: "server" });
