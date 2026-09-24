#!/usr/bin/env node

/**
 * CLI entry point.
 *
 * Starts a readline REPL that forwards each line to the server over
 * WebSocket and prints the streamed response as it arrives. The REPL also
 * handles the `login` / `logout` commands, which manage the local device
 * credential (see `src/credentials.ts` and `src/login.ts`).
 */
import * as readline from "node:readline";
import { Writable } from "node:stream";
import { ChatClient } from "./client";
import { getServerUrl, serverOrigin } from "./config";
import {
    clearCredentials,
    loadCredentials,
    saveCredentials,
} from "./credentials";
import { askLoginDetails, loginRequest, type AskHidden } from "./login";
import { loadOrCreateSessionId, rotateSessionId } from "./session";
import { logger } from "./logger";
import { renderHandlers } from "./render";

const serverUrl = getServerUrl();

/**
 * Resolves the server origin (credentials key + REST base), exiting with a
 * readable message instead of a stack trace when `JARVIS_SERVER_URL` is not
 * a valid URL.
 */
function resolveOrigin(): string {
    try {
        return serverOrigin(serverUrl);
    } catch (err) {
        logger.error(
            `${err instanceof Error ? err.message : String(err)} — check JARVIS_SERVER_URL`,
        );
        process.exit(1);
    }
}

const origin = resolveOrigin();
let sessionId = loadOrCreateSessionId();
const client = new ChatClient(serverUrl);

// The REPL's terminal output, with echo suppression for secret entry.
// `askHidden` mutes it while the password is typed; terminal mode makes
// readline echo the typed characters to `output`, so muting discards them.
// Only a TTY gets terminal mode — piped input never echoes anyway, and the
// wrapper stream itself has no isTTY to auto-detect from.
let outputMuted = false;
const replOutput = new Writable({
    write(chunk, _encoding, callback) {
        if (!outputMuted) {
            process.stderr.write(chunk);
        }
        callback();
    },
});

const rl = readline.createInterface({
    input: process.stdin,
    output: replOutput,
    // Explicit because createInterface's auto-detect checks the *output*
    // stream's isTTY — the mute wrapper has none, which would silently turn
    // terminal mode (raw input, line editing, echo interception) off. Piped
    // input never echoes in the first place, so keying on stdin is safe.
    terminal: process.stdin.isTTY === true,
});

/** Reads a secret on the REPL interface while its echo is suppressed. */
const askHidden: AskHidden = (question) =>
    new Promise((resolve) => {
        process.stderr.write(question);
        outputMuted = true;
        rl.question("", (answer) => {
            outputMuted = false;
            // The newline that ended the secret was echoed into the muted
            // stream; restore the line break for the next prompt.
            process.stderr.write("\n");
            // Keep the secret out of the interface's in-memory history —
            // up-arrow would otherwise replay it after login. (`history` is
            // public API but untyped in current @types/node.)
            const withHistory = rl as unknown as { history: string[] };
            const index = withHistory.history.indexOf(answer);
            if (index >= 0) {
                withHistory.history.splice(index, 1);
            }
            resolve(answer);
        });
    });

/** Logs the startup banner, including the identity implied by stored credentials. */
function printBanner(): void {
    const stored = loadCredentials(origin);
    logger.info(`J.A.R.V.I.S. CLI — server ${serverUrl}`);
    if (stored) {
        logger.info(
            `Credentials stored for ${stored.user} (device: ${stored.device})`,
        );
    } else {
        logger.info("No stored credentials — running as a guest");
    }
    logger.info(`Conversation session: ${sessionId}`);
    logger.info(
        "Type a prompt and press Enter. Commands: login, logout, exit.",
    );
}

printBanner();

// Tracks the in-flight prompt so the app waits for it to finish streaming
// before exiting when the REPL closes.
let inflight: Promise<void> = Promise.resolve();

// True while the interactive `login` command owns stdin — lines consumed by
// its prompts must not leak into the chat prompt dispatch.
let loginActive = false;

/**
 * Runs the interactive `login` command.
 *
 * Collects credentials (username pre-filled from `usernameArg`, hidden
 * password, device name), exchanges them for a device token at the server's
 * `POST /api/auth/login`, and stores the token under the server's origin.
 * On success the socket is closed and the session id rotated: the server's
 * strict ownership policy never re-parents a thread across identities, so
 * the next prompt reconnects — as an authenticated principal, in phase 2 —
 * on a fresh conversation thread.
 */
async function handleLogin(usernameArg: string): Promise<void> {
    if (client.isBusy()) {
        logger.error(
            "A response is still streaming — wait for it, then run 'login' again.",
        );
        rl.prompt();
        return;
    }
    loginActive = true;
    try {
        const inputs = await askLoginDetails(
            rl,
            askHidden,
            usernameArg || undefined,
        );
        if (!inputs) {
            logger.warn("Login cancelled.");
            return;
        }
        const result = await loginRequest(serverUrl, inputs);
        saveCredentials(origin, {
            token: result.token,
            user: result.user,
            device: result.device,
            savedAt: new Date().toISOString(),
        });
        client.close();
        sessionId = rotateSessionId();
        logger.info(
            `Logged in as ${result.user} (device: ${result.device}) — credentials stored.`,
        );
        logger.info(`Fresh conversation session: ${sessionId}`);
    } catch (err) {
        logger.error(
            `Login failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    } finally {
        loginActive = false;
        rl.prompt();
    }
}

/**
 * Runs the `logout` command.
 *
 * Removes the stored credential for this server, closes the socket, and
 * rotates the session id so the next prompt runs as a guest on a fresh
 * thread. Persisted owned sessions are kept server-side — logout changes
 * this machine's identity, not the account.
 */
function handleLogout(): void {
    if (client.isBusy()) {
        logger.error(
            "A response is still streaming — wait for it, then run 'logout' again.",
        );
        rl.prompt();
        return;
    }
    let removed: boolean;
    try {
        removed = clearCredentials(origin);
    } catch (err) {
        logger.error(
            `Logout failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        rl.prompt();
        return;
    }
    if (!removed) {
        logger.warn("Not logged in.");
        rl.prompt();
        return;
    }
    client.close();
    sessionId = rotateSessionId();
    logger.info("Logged out — the next prompt runs as a guest.");
    rl.prompt();
}

rl.setPrompt("> ");
rl.prompt();

rl.on("line", (line) => {
    const prompt = line.trim();
    if (prompt === "") {
        rl.prompt();
        return;
    }
    if (prompt === "exit" || prompt === "quit") {
        client.close();
        rl.close();
        return;
    }
    if (loginActive) {
        logger.warn(
            "A login is already in progress — answer its prompts (or press Ctrl+C) first.",
        );
        rl.prompt();
        return;
    }
    if (prompt === "login" || prompt.startsWith("login ")) {
        void handleLogin(prompt.slice("login".length).trim());
        return;
    }
    if (prompt === "logout") {
        handleLogout();
        return;
    }

    inflight = (async () => {
        try {
            await client.prompt(prompt, sessionId, renderHandlers);
            process.stdout.write("\n");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Error: ${message}`);
        }
    })();
    void inflight.then(() => rl.prompt());
});

rl.on("close", async () => {
    client.close();
    await inflight;
    process.exit(0);
});
