#!/usr/bin/env node

/**
 * CLI entry point.
 *
 * Starts a readline REPL that forwards each line to the server over
 * WebSocket and prints the streamed response as it arrives.
 */
import * as readline from "node:readline";
import { ChatClient } from "./client";
import { getServerUrl } from "./config";
import { loadOrCreateSessionId } from "./session";
import { logger } from "./logger";
import { renderHandlers } from "./render";

const serverUrl = getServerUrl();
const sessionId = loadOrCreateSessionId();
const client = new ChatClient(serverUrl);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
});

logger.info(`J.A.R.V.I.S. CLI — connected to ${serverUrl}`);
logger.info(`Conversation session: ${sessionId}`);
logger.info(
    "Type a prompt and press Enter. Type 'exit' or press Ctrl+C to quit.",
);

// Tracks the in-flight prompt so the app waits for it to finish streaming
// before exiting when the REPL closes.
let inflight: Promise<void> = Promise.resolve();

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
