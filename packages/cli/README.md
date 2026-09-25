# @lukestanbery/jarvis-cli

CLI text chat client for the J.A.R.V.I.S. AI assistant. This is a REPL: type a prompt,
send it to the server over WebSocket, and watch the response stream back to the
screen.

## Prerequisites

- Node.js 22+ (uses the built-in global `WebSocket`)
- npm

## Install

```sh
npm install -g @lukestanbery/jarvis-cli
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

Start the server first (see `@lukestanbery/jarvis-server`), then run the CLI:

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

### Logging in

Without credentials the CLI runs as a **guest** — the server keeps guest
conversations in ephemeral threads that are deleted when the connection
closes. To use a persistent, owned conversation, log in:

```sh
login                      # prompts for username, password, and device name
login luke                 # pre-fills the username
```

The password is prompted with echo suppressed. On success the CLI stores the
server-issued per-device **token** in `~/.jarvis/credentials.json` (mode
`0600`), closes the current connection, and **resumes the account's remembered
conversation thread** — the server never re-parents a thread across identities,
so the CLI keeps one thread per identity (`guest` plus one per logged-in
account) and _switches_ (not rotates) on login/logout. Logging in again with
the same device name **rotates** the token; the previous token for that device
stops working. Errors map directly from the server: bad credentials (`401`),
rate limiting with lockout (`429`), and a server with no owner yet (`404` —
bootstrap it first, see `@lukestanbery/jarvis-server`).

Log out with `logout` — the stored token is removed and the CLI switches back
to the guest conversation thread. Persisted conversations stay on the server;
logout changes this machine's identity, not the account, and a later `login`
resumes the account's thread where it left off.

Type `new` to start a **fresh conversation** on the current identity (a
deliberate rotation — login/logout never rotate on their own).

The stored token is used on every connect: the CLI sends it as the socket's
**first frame** and authenticates before the first prompt (the banner confirms
`Credentials stored for …`, and the first connect prints `Authenticated as …`).
If the server rejects the token because it was rotated elsewhere or revoked,
the CLI warns, clears the credential, drops to the guest conversation thread,
and continues as a guest — re-run `login` to re-authenticate. The token itself
is never logged.

Tokens are keyed by **server origin**, so logging into a dev server does not
clobber the token for a LAN server.

### Configuration

The server URL defaults to `ws://localhost:54321/ws`. Override it with the
`JARVIS_SERVER_URL` environment variable:

```sh
JARVIS_SERVER_URL=ws://localhost:9000/ws jarvis
```

The CLI keeps one conversation-thread id **per identity** — `guest` plus one
per logged-in account — in `~/.jarvis/session-id` (override the path with
`JARVIS_SESSION_FILE`). The active id is sent as `sessionId` with every
prompt, so each identity continues its own conversation thread across CLI
restarts; login/logout switch between slots and `new` rotates the active one.
Delete the file (or set `JARVIS_SESSION_FILE` to a fresh path) to reset every
thread.

Login tokens are kept in `~/.jarvis/credentials.json` (override the path with
`JARVIS_CREDENTIALS_FILE`), one entry per server origin, written atomically at
mode `0600`. The file holds real credentials — treat it like a private key.

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
