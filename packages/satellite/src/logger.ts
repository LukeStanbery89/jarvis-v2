/**
 * Shared logger for the satellite daemon.
 *
 * Diagnostics go to stderr so stdout stays available for the spoken turn's
 * text (the CLI's convention). The default level is `info`; set
 * `JARVIS_LOG_LEVEL` to `debug` while bringing up a device.
 */
import { createLogger } from "@lukestanbery/jarvis-logger";

export const logger = createLogger({
    tag: "satellite",
    stream: process.stderr,
});
