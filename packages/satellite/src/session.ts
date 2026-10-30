/**
 * Per-server voice thread persistence.
 *
 * The first satellite slice keeps one conversation id per server, so a restart
 * continues the same thread. The server is authoritative for the transcript
 * (#122); this file only remembers which thread the device was using.
 *
 * Writes are atomic and owner-only. An unwritable location never prevents the
 * daemon from starting: it falls back to an in-memory id for this run.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serverOrigin, type SatelliteConfig } from "./config";
import { logger } from "./logger";

interface SessionFile {
    version: 1;
    servers: Record<string, string>;
}

/** Generates a server-valid conversation id (<= 128 chars). */
function newSessionId(): string {
    return `satellite-${randomUUID()}`;
}

/** Reads the session store, ignoring a missing or malformed file. */
function readStore(file: string): SessionFile | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as SessionFile).version === 1 &&
            typeof (parsed as SessionFile).servers === "object"
        ) {
            return parsed as SessionFile;
        }
        logger.warn(`Ignoring malformed session file: ${file}`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(
                `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    return null;
}

/** Writes the store atomically with owner-only permissions. */
function writeStore(file: string, store: SessionFile): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(store, null, 4)}\n`, { mode: 0o600 });
    renameSync(temp, file);
}

/**
 * Returns the stable conversation id for the configured server.
 *
 * `JARVIS_SATELLITE_SESSION_ID` overrides the store. Otherwise a missing entry
 * is minted and written; a write failure is logged and the id remains valid
 * for the current process.
 */
export function resolveSessionId(config: SatelliteConfig): string {
    if (config.sessionId !== undefined) {
        return config.sessionId;
    }
    const origin = serverOrigin(config.serverUrl);
    const store = readStore(config.sessionFile);
    const existing = store?.servers[origin];
    if (existing !== undefined && existing.length > 0) {
        return existing;
    }
    const id = newSessionId();
    try {
        writeStore(config.sessionFile, {
            version: 1,
            servers: { ...(store?.servers ?? {}), [origin]: id },
        });
    } catch (err) {
        logger.warn(
            `Could not persist the satellite thread id: ${err instanceof Error ? err.message : String(err)} — using ${id} for this run only`,
        );
    }
    return id;
}
