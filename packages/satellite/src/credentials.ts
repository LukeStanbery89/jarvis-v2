/**
 * Device-token discovery for the satellite.
 *
 * A headless device should not need a password at boot. Prefer an explicitly
 * configured `JARVIS_SATELLITE_TOKEN`; otherwise reuse the same
 * `~/.jarvis/credentials.json` the text CLI writes when the operator runs
 * `login`. The file is read-only here: the satellite never rotates or writes a
 * device token, and the token is never logged.
 */
import { readFileSync } from "node:fs";
import { credentialOrigins } from "./config";
import { logger } from "./logger";

/** One stored login, matching `packages/cli/src/credentials.ts`. */
interface StoredCredential {
    token: string;
    user: string;
    device: string;
    savedAt: string;
}

interface CredentialFile {
    version: 1;
    servers: Record<string, StoredCredential>;
}

/** A token plus the human-readable metadata the file happened to carry. */
export interface LoadedCredential {
    token: string;
    user?: string;
    device?: string;
    /** Where it came from, for diagnostics; never includes the token. */
    source: "env" | "file";
}

/** Checks a value read from disk before trusting it as a token entry. */
function isStoredCredential(value: unknown): value is StoredCredential {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.token === "string" &&
        entry.token.length > 0 &&
        typeof entry.user === "string" &&
        typeof entry.device === "string" &&
        typeof entry.savedAt === "string"
    );
}

/** Reads the CLI credential store, returning `null` for absent/corrupt data. */
function readCredentialFile(path: string): CredentialFile | null {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn(
                `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as CredentialFile).version === 1 &&
            typeof (parsed as CredentialFile).servers === "object"
        ) {
            return parsed as CredentialFile;
        }
    } catch {
        // Fall through to the malformed warning.
    }
    logger.warn(`Ignoring malformed credential file: ${path}`);
    return null;
}

/**
 * Resolves the device token for `serverUrl`.
 *
 * The environment wins so a service can be provisioned without a user home
 * directory. Otherwise the CLI's per-origin store is checked under both the
 * HTTP and HTTPS spelling of the socket origin.
 */
export function loadCredential(
    serverUrl: string,
    credentialsFile: string,
): LoadedCredential | null {
    const envToken = process.env.JARVIS_SATELLITE_TOKEN?.trim();
    if (envToken) {
        return { token: envToken, source: "env" };
    }

    const store = readCredentialFile(credentialsFile);
    if (store === null) {
        return null;
    }
    for (const origin of credentialOrigins(serverUrl)) {
        const entry = store.servers[origin];
        if (isStoredCredential(entry)) {
            return {
                token: entry.token,
                user: entry.user,
                device: entry.device,
                source: "file",
            };
        }
    }
    return null;
}
