# AGENTS.md

## Purpose

`@jarvis/cli` — CLI text chat client for the Jarvis AI assistant. Runs a REPL that forwards prompts to the server over WebSocket and prints the streamed response. Built with zero runtime dependencies (uses Node's global `WebSocket`).

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Node's built-in global `WebSocket` (Node 22+)
- Tests via Vitest

## Scripts

Run from `packages/cli`:

| Command         | Description                   |
| --------------- | ----------------------------- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev`   | Run the CLI in dev mode       |
| `npm start`     | Run the compiled CLI          |
| `npm test`      | Run the test suite            |

## Configuration

The server URL defaults to `ws://localhost:54321/ws`, overridable via the `JARVIS_SERVER_URL`
environment variable (`src/config.ts`). Chat protocol is defined by `@jarvis/server`.

## Exit commands

Type `exit` or `quit`, or press `Ctrl+C`/`Ctrl+D`, to quit.
