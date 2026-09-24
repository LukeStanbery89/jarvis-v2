/**
 * Login over the server's REST API.
 *
 * `loginRequest` posts to `POST /api/auth/login` on the server origin derived
 * from the WebSocket URL (see `serverOrigin`) and maps error responses to
 * readable messages — the server's own `{ "error": ... }` body is preferred
 * so wording stays in sync with the REST layer. `askLoginDetails` collects
 * credentials interactively on the REPL's readline interface; the caller
 * supplies the `askHidden` helper so password entry runs on the *same*
 * interface with its output suppressed (a second interface would hand raw
 * terminal mode back and forth and leave the REPL's line editing broken).
 *
 * Tokens and passwords are never logged.
 */
import * as readline from "node:readline";
import { hostname } from "node:os";
import { serverOrigin } from "./config";

/** Longest device name the server accepts (`DEVICE_NAME_MAX` in the REST layer). */
const DEVICE_NAME_MAX = 64;

/** How long `loginRequest` waits for the server before giving up. */
export const LOGIN_TIMEOUT_MS = 15_000;

/**
 * Reads a secret without echoing it.
 *
 * Implemented by the caller (the entry point owns the REPL's output stream
 * and suppresses it while the secret is typed).
 */
export type AskHidden = (question: string) => Promise<string>;

/** Credentials collected by the interactive login prompt. */
export interface LoginInputs {
    username: string;
    password: string;
    deviceName: string;
}

/** Normalized success response from `POST /api/auth/login`. */
export interface LoginResult {
    /** Username that logged in. */
    user: string;
    /** Device name the token was issued to. */
    device: string;
    /** The per-device token to store and send as the WS auth frame. */
    token: string;
}

/**
 * Logs in and returns the issued device token.
 *
 * Throws an `Error` with a user-facing message when the server is
 * unreachable, rejects the credentials, rate-limits the attempt, stalls
 * longer than `timeoutMs` (default `LOGIN_TIMEOUT_MS`), or answers with an
 * unexpected body.
 */
export async function loginRequest(
    serverUrl: string,
    inputs: LoginInputs,
    timeoutMs: number = LOGIN_TIMEOUT_MS,
): Promise<LoginResult> {
    const origin = serverOrigin(serverUrl);
    let res: Response;
    try {
        res = await fetch(`${origin}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(inputs),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
            throw new Error(`timed out reaching ${origin}`);
        }
        throw new Error(`could not reach ${origin}`);
    }
    const body = (await res.json().catch(() => null)) as {
        error?: unknown;
        user?: { username?: unknown };
        device?: { name?: unknown; token?: unknown };
    } | null;
    if (!res.ok) {
        const message =
            typeof body?.error === "string"
                ? body.error
                : `login failed (HTTP ${res.status})`;
        throw new Error(message);
    }
    const { username, deviceName, token } = {
        username: body?.user?.username,
        deviceName: body?.device?.name,
        token: body?.device?.token,
    };
    if (
        typeof username !== "string" ||
        typeof deviceName !== "string" ||
        typeof token !== "string" ||
        token.length === 0
    ) {
        throw new Error(`unexpected login response from ${origin}`);
    }
    return { user: username, device: deviceName, token };
}

/**
 * Builds the default device name from the machine's hostname.
 *
 * Strips a `.local` mDNS suffix, drops characters outside
 * `[a-zA-Z0-9._-]`, truncates to the server's device-name bound, and falls
 * back to `"cli"` when nothing usable remains — each machine then gets its
 * own device row, so logging in from a second machine never rotates away the
 * first machine's token.
 */
export function sanitizeDeviceName(rawHostname: string): string {
    const cleaned = rawHostname
        .replace(/\.local\.?$/i, "")
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .slice(0, DEVICE_NAME_MAX);
    return cleaned.length > 0 ? cleaned : "cli";
}

/** Returns this machine's default device name (see `sanitizeDeviceName`). */
export function defaultDeviceName(): string {
    return sanitizeDeviceName(hostname());
}

/** Resolves with the next line entered on `rl` (without the newline). */
function ask(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Prompts interactively for login credentials on `rl`.
 *
 * Asks for a username (pre-filled with `defaultUsername` when the user typed
 * `login <username>`, cancelling when empty either way), a password (read
 * through `askHidden`, so no echo), and a device name (defaulting to
 * `defaultDeviceName()`, truncated to the server's bound). All input goes
 * through the one REPL interface, so terminal raw mode is never handed off.
 */
export async function askLoginDetails(
    rl: readline.Interface,
    askHidden: AskHidden,
    defaultUsername?: string,
): Promise<LoginInputs | null> {
    const usernameLabel = defaultUsername
        ? `Username [${defaultUsername}]: `
        : "Username: ";
    const rawUsername = (await ask(rl, usernameLabel)).trim();
    const username = rawUsername.length > 0 ? rawUsername : defaultUsername;
    if (!username) {
        return null;
    }

    const password = await askHidden("Password: ");

    const rawDevice = (
        await ask(rl, `Device name [${defaultDeviceName()}]: `)
    ).trim();
    const deviceName =
        rawDevice.length > 0
            ? rawDevice.slice(0, DEVICE_NAME_MAX)
            : defaultDeviceName();
    return { username, password, deviceName };
}
