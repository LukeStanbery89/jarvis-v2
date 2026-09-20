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

const serverUrl = getServerUrl();
const client = new ChatClient(serverUrl);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

console.log(`Jarvis CLI — connected to ${serverUrl}`);
console.log(
    `Type a prompt and press Enter. Type 'exit' or press Ctrl+C to quit.`,
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
            await client.prompt(prompt, (chunk) => {
                process.stdout.write(chunk);
            });
            process.stdout.write("\n");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stdout.write(`\nError: ${message}\n`);
        }
    })();
    void inflight.then(() => rl.prompt());
});

rl.on("close", async () => {
    client.close();
    await inflight;
    process.exit(0);
});
