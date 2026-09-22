# @lukestanbery/jarvis-server

Express backend server for the J.A.R.V.I.S. AI assistant. Accepts prompt messages over
WebSocket and streams a response back to the client.

## Prerequisites

- Node.js 18+
- npm
- A running OpenAI-compatible inference server. [LM Studio](https://lmstudio.ai) is the
  default — launch it, load a model, and start its local server on port `1234`.

## Install

```sh
npm install @lukestanbery/jarvis-server
```

## Scripts

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run build`     | Compile TypeScript to `dist/`      |
| `npm run typecheck` | Type-check src and tests (no emit) |
| `npm run dev`       | Run the server with watch mode     |
| `npm start`         | Run the compiled server            |
| `npm test`          | Run the test suite (Vitest)        |

## Usage

```sh
npm run dev
```

The server listens on port `54321` by default (chosen from the IANA
dynamic/private range to avoid collisions with other services). Override with
the `PORT` environment variable:

```sh
PORT=8080 npm run dev
```

### Configuration

The model is reached via LangChain (`@langchain/openai`) pointed at an
OpenAI-compatible endpoint. Everything is configurable through environment
variables:

| Variable                 | Default                                                                         | Description                                             |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `LLM_BASE_URL`           | `http://localhost:1234/v1`                                                      | OpenAI-compatible base URL                              |
| `LLM_MODEL`              | `qwen/qwen3-4b-2507`                                                            | Model served by the server                              |
| `LLM_TEMPERATURE`        | `0`                                                                             | Sampling temperature                                    |
| `LLM_SYSTEM_PROMPT`      | `You are J.A.R.V.I.S., a helpful, personal AI assistant. ...` (concise persona) | System message priming every conversation thread        |
| `JARVIS_AGENT_MAX_TURNS` | `10`                                                                            | Max agent loop steps per turn (tools + model calls)     |
| `JARVIS_CHECKPOINT_PATH` | `~/.jarvis/checkpoints.sqlite`                                                  | SQLite checkpoint file for conversation persistence     |
| `JARVIS_DB_PATH`         | `~/.jarvis/jarvis.sqlite`                                                       | App database: users, devices, sessions, prefs           |
| `JARVIS_TURN_TIMEOUT_MS` | `120000`                                                                        | Hard cap for one agent turn before it is aborted        |
| `JARVIS_BOOTSTRAP_TOKEN` | unset                                                                           | Optional bootstrap credential; see `src/auth/README.md` |
| `JARVIS_LOG_LEVEL`       | `info`                                                                          | Log verbosity: `debug` \| `info` \| `warn` \| `error`   |
| `JARVIS_LOG_SENSITIVE`   | `auto`                                                                          | Force sensitive payload logging: `full` \| `redacted`   |

```sh
LLM_MODEL=some-other-model npm run dev
```

First-run setup (once the server is up and `JARVIS_BOOTSTRAP_TOKEN` is set):

```sh
curl -X POST http://localhost:54321/api/bootstrap \
  -H 'x-bootstrap-token: <JARVIS_BOOTSTRAP_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"username":"luke","password":"<choose-a-strong-password>"}'
```

The response's `device.token` is your admin credential. Passwords must be at
least 8 characters, and the bootstrap token is read **only** from the
`x-bootstrap-token` header (never the JSON body). Later, log in again
from any client with `POST /api/auth/login` to receive a fresh token, then use
it as `Authorization: Bearer <token>` (for the `/api` routes) or as the
`{ "type": "auth", "token" }` first frame on `/ws`. Re-login on the same
device name rotates the token (the old one stops working); use distinct
`deviceName`s for distinct clients. A failed login is indistinguishable from an
unknown username (same error, uniform response time), so account existence
can't be probed.

### Logging

Log lines look like
`2026-09-20 12:00:00 [INFO] server — message`, colored by level. Reach the
level filter with `JARVIS_LOG_LEVEL` (default `info`).

User prompts and streamed response tokens are treated as **sensitive
payloads** and are redacted by default (the data is replaced by `[REDACTED]`,
token tracing suppressed). Payloads are logged verbatim only in development:
`npm run dev` sets `NODE_ENV=development`. Production deployments (any other
`NODE_ENV`, including unset) stay redacted even if `JARVIS_LOG_LEVEL=debug` is
forced. Override either way with `JARVIS_LOG_SENSITIVE=full|redacted`. The
option is provided by `@lukestanbery/jarvis-logger` (`sensitive` / `sensitiveDebug`).

### Endpoints

| Method   | Path                      | Auth                                | Description                                         |
| -------- | ------------------------- | ----------------------------------- | --------------------------------------------------- |
| `GET`    | `/`                       | none                                | Health-check, returns `Hello World`                 |
| `WS`     | `/ws`                     | optional device token (first frame) | Chat endpoint (WebSocket)                           |
| `POST`   | `/api/bootstrap`          | `JARVIS_BOOTSTRAP_TOKEN`            | Create the first (owner) account + device token     |
| `POST`   | `/api/auth/login`         | none                                | Username + password → a (rotating) device token     |
| `GET`    | `/api/me`                 | device token                        | Current user + their devices                        |
| `POST`   | `/api/devices`            | device token                        | Provision a new device token for the caller         |
| `DELETE` | `/api/devices/:id`        | device token                        | Revoke a device (own, or any as owner)              |
| `GET`    | `/api/users`              | device token (owner)                | List accounts                                       |
| `POST`   | `/api/users`              | device token (owner)                | Create an account (`role` optional, default `user`) |
| `GET`    | `/api/sessions`           | device token                        | List the caller's owned sessions                    |
| `DELETE` | `/api/sessions/:threadId` | device token                        | Delete the caller's owned session (owner: any)      |

"Device token" auth is `Authorization: Bearer <token>`.

### Chat protocol

The wire protocol (frames, limits, and parse/serialize logic) is defined once
in the shared `@lukestanbery/jarvis-protocol` package; connect a WebSocket client to `/ws`
and exchange JSON text frames:

- Client → Server:
    - **Optional, first frame only:** `{ "type": "auth", "token": "<device token>" }`
      — authenticates as an account. The server replies with one
      `{ "authResult": { "user": "<name>", "device": "<name>" } }` frame. Never
      authenticate → the socket is a **guest** (ephemeral, identity-independent
      chats).
    - `{ "prompt": "<your prompt>", "sessionId": "<id>" }` — the
      `sessionId` names the conversation thread. Reuse it to continue an earlier
      conversation (bounded to 128 characters); each distinct id is isolated.
- Server → Client (in order, per prompt):
    - `{ "tool": { "name": "<tool>", "args": { ... } } }` — the agent is calling
      a tool (emitted once per call).
    - `{ "toolResult": { "name": "<tool>", "output": <any> } }` — the tool returned.
    - zero or more `{ "chunk": "<text>" }` frames — the streamed answer.
    - `{ "done": true }` — the response is complete.
- On invalid input or model failure: `{ "error": "<message>" }`, followed by `{ "done": true }`
- Sending a new prompt while a response is still streaming — or while another
  socket is running a concurrent turn on the same `sessionId` (per-thread lock)
  — is rejected with an `in progress` error frame.
- A `sessionId` owned by a different principal — another account, or a guest's
  thread — is rejected with a `session belongs to another user` error frame:
  knowing a `sessionId` alone is never enough to read or continue a
  conversation you don't own. Sessions are only ever usable by their owner.
- Turns are hard-capped by `JARVIS_TURN_TIMEOUT_MS` (default `120000`): a turn
  that exceeds it is aborted and the client receives a `turn timed out` error
  frame. Draining is **best-effort on a hung model** — the per-thread lock
  releases once the in-flight model call settles.

Every prompt is recorded in the app database (`JARVIS_DB_PATH`, default
`~/.jarvis/jarvis.sqlite`): `sessionId` is claimed atomically as a
**session** tagged `guest`/`owned` and `text`/`voice`. Guest sessions are
deleted when their socket closes; owned sessions persist and can be listed or
deleted via the REST management API. Note that deleting a session removes the
ledger row, not the conversation history in the LangGraph checkpointer (see
`JARVIS_CHECKPOINT_PATH`) — that remains a documented limitation.

Concatenate the `chunk` payloads verbatim to reconstruct the full response. A
single prompt may loop through `tool`/`toolResult` pairs several times before
the agent produces its final text (bounded by `JARVIS_AGENT_MAX_TURNS`); tool
events cannot appear inside the text stream, only before it. The agent state —
including the whole message history of each session — is persisted to the
SQLite checkpoint file (`JARVIS_CHECKPOINT_PATH`), so a server restart resumes
conversations. Try it with the `@lukestanbery/jarvis-cli` REPL.
