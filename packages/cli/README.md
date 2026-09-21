# @jarvis/cli

CLI text chat client for the J.A.R.V.I.S. AI assistant. This is a REPL: type a prompt,
send it to the server over WebSocket, and watch the response stream back to the
screen.

## Prerequisites

- Node.js 22+ (uses the built-in global `WebSocket`)
- npm

## Install

```sh
npm install -g @jarvis/cli
```

## Scripts

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`      |
| `npm run typecheck` | Type-check src and tests (no emit) |
| `npm run dev`       | Run the CLI in dev mode            |
| `npm start`         | Run the compiled CLI               |
| `npm test`          | Run the test suite (Vitest)        |

## Usage

Start the server first (see `@jarvis/server`), then run the CLI:

```sh
npm run dev
```

Or build and run the compiled output:

```sh
npm run build && node dist/index.js
```

When installed globally, it is available as the `jarvis` command:

```sh
jarvis
```

Type a prompt and press Enter; the server's response is printed as it streams
in. When the agent calls a tool, the CLI prints a diagnostic line to **stderr**
(e.g. `Agent calling tool getCurrentTime`) and keeps the streamed answer on
stdout. Type `exit` or `quit`, or press `Ctrl+C`/`Ctrl+D`, to quit.

### Configuration

The server URL defaults to `ws://localhost:54321/ws`. Override it with the
`JARVIS_SERVER_URL` environment variable:

```sh
JARVIS_SERVER_URL=ws://localhost:9000/ws jarvis
```

The CLI keeps a conversation id in `~/.jarvis/session-id` (override the path
with `JARVIS_SESSION_FILE`). The id is sent as `sessionId` with every prompt,
so the server continues the same conversation thread across CLI restarts;
delete the file (or set `JARVIS_SESSION_FILE` to a fresh path) to start a new
conversation.

If the server is unreachable, the CLI prints the error and keeps running — just
try again once the server is up.

### Logging

The CLI prints its banner, prompt, and errors to **stderr** and keeps stdout
reserved for the streamed assistant response, so piping stdout captures only
the reply:

```sh
echo "Hello" | jarvis   # stdout = the assistant's reply, diagnostics on stderr
```

Log lines look like `2026-09-20 12:00:00 [INFO] cli — ...`, colored by level.
The default level is `info`; override it with the `JARVIS_LOG_LEVEL`
environment variable (`debug` | `info` | `warn` | `error`).
