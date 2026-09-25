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
`~/.jarvis/session-id`, overridable via `JARVIS_SESSION_FILE`, and the
credentials file defaults to `~/.jarvis/credentials.json`, overridable via
`JARVIS_CREDENTIALS_FILE` (`src/config.ts`). `src/session.ts` keeps one
conversation thread **per identity** — a `guest` slot plus one per logged-in
account — so the active `sessionId` sent with every prompt resumes the _right_
server-side thread across restarts (`loadSessionIds` / `sessionIdFor`
/`rotateActiveSession`; a legacy bare-id file is adopted as the guest slot).
The chat wire protocol is defined in the shared
`@lukestanbery/jarvis-protocol` package (parsing via `parseFrame`, serialization via
`serializeRequest`); tool and toolResult frames are surfaced to the REPL's
stderr diagnostics via the `onTool`/`onToolResult` callbacks (`src/client.ts`).

## Login/logout

The REPL's `login [username]` / `logout` commands manage the local device
credential (`src/credentials.ts`, `src/login.ts`): `login` exchanges
username + password (echo suppressed) + device name for a per-device token at
`POST /api/auth/login`, stores it in `~/.jarvis/credentials.json` (0600,
atomic write, keyed by server origin), and closes the socket. Because the
server's strict ownership policy never re-parents a thread across identities,
login/logout **switch the active thread slot** (`sessionIdFor`) instead of
rotating — logging in resumes that account's remembered conversation, logging
out returns to the guest thread, and neither mints a fresh id. A deliberate
fresh start is the `new` command (`rotateActiveSession`), which rotates the
_current_ identity's slot and persists. On the next connect the stored token
is sent as the socket's first frame and authenticated before the first prompt
(`src/client.ts`); a token the server rejects ("invalid device token" at
connect, "device token revoked" mid-prompt) self-heals to a guest: the entry
point clears the stored credential and drops to the remembered guest slot (the
account's slot is left intact for the next login). A handshake that times out
keeps the stored token on disk but stops re-sending it on that socket. The
token and password are secrets: never log them, and keep the
password's echo suppression intact (the REPL's output stream is a
suppressible wrapper; see `askHidden` in `src/index.ts`).

## Logging

CLI diagnostics (banner, errors) go to stderr through the shared
`@lukestanbery/jarvis-logger` instance in `src/logger.ts` (tag `cli`), so **stdout is
reserved for the streamed assistant response** — piping `stdout` captures only
the reply. Default level is `info`; set `JARVIS_LOG_LEVEL`
(`debug` | `info` | `warn` | `error`) to change it.

## Exit commands

Type `exit` or `quit`, or press `Ctrl+C`/`Ctrl+D`, to quit (also honored while
a login is in progress).
