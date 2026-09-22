# AGENTS.md

## Purpose

`@lukestanbery/jarvis-cli` — CLI text chat client for the J.A.R.V.I.S. AI assistant. Runs a REPL that forwards prompts to the server over WebSocket and prints the streamed response. Uses Node's global `WebSocket` for transport, `@lukestanbery/jarvis-logger` for logging, and `@lukestanbery/jarvis-protocol` for framing (no third-party runtime deps).

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Node's built-in global `WebSocket` (Node 22+)
- Logging via `@lukestanbery/jarvis-logger` (Consola-based; see `src/logger.ts`)
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

The server URL defaults to `ws://localhost:54321/ws`, overridable via the
`JARVIS_SERVER_URL` environment variable; the session-id file defaults to
`~/.jarvis/session-id`, overridable via `JARVIS_SESSION_FILE` (`src/config.ts`).
`loadOrCreateSessionId()` (`src/session.ts`) loads or creates that file and is
sent as `sessionId` with every prompt so the CLI resumes the server-side
conversation thread across restarts. The chat wire protocol is defined in the
shared `@lukestanbery/jarvis-protocol` package (parsing via `parseFrame`, serialization via
`serializeRequest`); tool and toolResult frames are surfaced to the REPL's
stderr diagnostics via the `onTool`/`onToolResult` callbacks (`src/client.ts`).

## Logging

CLI diagnostics (banner, errors) go to stderr through the shared
`@lukestanbery/jarvis-logger` instance in `src/logger.ts` (tag `cli`), so **stdout is
reserved for the streamed assistant response** — piping `stdout` captures only
the reply. Default level is `info`; set `JARVIS_LOG_LEVEL`
(`debug` | `info` | `warn` | `error`) to change it.

## Exit commands

Type `exit` or `quit`, or press `Ctrl+C`/`Ctrl+D`, to quit.
