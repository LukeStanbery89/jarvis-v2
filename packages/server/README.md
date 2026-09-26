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

| `PORT` | `54321` | HTTP listener port |
| `LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible base URL |
| `LLM_MODEL` | `qwen/qwen3-4b-2507` | Model served by the server |
| `LLM_TEMPERATURE` | `0` | Sampling temperature |
| `LLM_SYSTEM_PROMPT` | `You are J.A.R.V.I.S., a helpful, personal AI assistant. ...` (concise persona) | System message priming every conversation thread |
| `JARVIS_AGENT_MAX_TURNS` | `10` | Max agent loop steps per turn (tools + model calls) |
| `JARVIS_CHECKPOINT_PATH` | `~/.jarvis/checkpoints.sqlite` | SQLite checkpoint file for conversation persistence |
| `JARVIS_DB_PATH` | `~/.jarvis/jarvis.sqlite` | App database: users, devices, sessions, prefs |
| `JARVIS_TURN_TIMEOUT_MS` | `120000` | Hard cap for one agent turn before it is aborted |
| `JARVIS_BOOTSTRAP_TOKEN` | unset | One-time setup credential; see the `@lukestanbery/jarvis-auth` README |
| `JARVIS_HOST` | `0.0.0.0` | Bind address (all interfaces = LAN posture) |
| `JARVIS_TLS_CERT` | unset | PEM certificate path — enables HTTPS serving |
| `JARVIS_TLS_KEY` | unset | Matching PEM private key (required with `JARVIS_TLS_CERT`) |
| `JARVIS_HTTP_REDIRECT_PORT`| `PORT + 1` | Cleartext port that upgrades to HTTPS (TLS mode) |
| `JARVIS_PORTAL_DIR` | `packages/portal/dist` | Built portal SPA root served at `/`; empty string disables it |
| `JARVIS_RATE_WINDOW_MS` | `900000` (15 min) | Attempt-accumulation window for login/bootstrap |
| `JARVIS_RATE_MAX_FAILURES` | `10` | Attempts per `(ip, username)` before a lockout |
| `JARVIS_RATE_MAX_IP_FAILURES` | `100` | Aggregate attempts per IP before a lockout |
| `JARVIS_RATE_LOCKOUT_MS` | `60000` | Base lockout; doubles per repeat (backoff, ×32 cap) |
| `JARVIS_SESSION_TTL_MS` | `2592000000` (30 days) | Absolute lifetime of a cookie session (no sliding) |
| `JARVIS_API_CONTRACT` | unset | Set `verify` to also validate REST response bodies against the OpenAPI contract (request shapes are always validated) |
| `JARVIS_LOG_LEVEL` | `info` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |
| `JARVIS_LOG_SENSITIVE` | `auto` | Force sensitive payload logging: `full` \| `redacted` |

```sh
LLM_MODEL=some-other-model npm run dev
```

#### `.env` file

Copy the example and edit it instead of prefixing every command:

```sh
cp .env.example .env
```

`packages/server/.env` is loaded automatically at startup (both `npm run dev`
and `npm start`) by `import "dotenv/config"` in `src/index.ts`. Rules:

- It is **gitignored — never commit it**; it can hold secrets such as
  `JARVIS_BOOTSTRAP_TOKEN`. `.env.example` holds placeholders only, so it can
  be shared.
- **Real environment variables always win** over `.env` (dotenv's default), so
  a value set for one run via `VAR=… npm start` overrides the file, and CI /
  systemd environments are unaffected by it.
- It is read once at process start; editing it does not hot-reload under
  `tsx watch`.

First-run setup (once the server is up and `JARVIS_BOOTSTRAP_TOKEN` is set):

```sh
curl -X POST http://localhost:54321/api/bootstrap \
  -H 'x-bootstrap-token: <JARVIS_BOOTSTRAP_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"username":"luke","password":"<choose-a-strong-password>"}'
```

The response's `device.token` is your admin credential. Passwords must be at
least 8 characters, and the bootstrap token is read **only** from the
`x-bootstrap-token` header (never the JSON body). The bootstrap token is
single-use: a `BootstrapGate` in the router consumes it after the first
successful bootstrap (the config object is left untouched), so rerunning with
the same env value cannot mint a second owner — restart the process with a new
token if you truly need to re-bootstrap. Later, log in again
from any client with `POST /api/auth/login` to receive a fresh token, then use
it as `Authorization: Bearer <token>` (for the `/api` routes) or as the
`{ "type": "auth", "token" }` first frame on `/ws`. Re-login on the same
device name rotates the token (the old one stops working); use distinct
`deviceName`s for distinct clients. A failed login is indistinguishable from an
unknown username (same error, uniform response time), so account existence
can't be probed. Login and bootstrap are rate-limited per
`(ip, username)` and per `ip`: after `JARVIS_RATE_MAX_FAILURES` attempts (or
`JARVIS_RATE_MAX_IP_FAILURES` across usernames) within
`JARVIS_RATE_WINDOW_MS`, the client is locked out for
`JARVIS_RATE_LOCKOUT_MS` (doubling on repeat violations) and receives
`429 too many attempts; try again later`. Every attempt — right or wrong — is
counted at admission (before the expensive scrypt verify), so a burst of
concurrent guesses can't race past the budget; a successful login resets the
counter. The limiter is in-memory per process and trusts `req.ip` — set
`app.set("trust proxy", …)` if you ever front the server with a reverse proxy.

### REST contract validation

The server enforces the OpenAPI contract at runtime: `express-openapi-validator`
runs ahead of `/api` (and `/health`) with the spec from
`@lukestanbery/jarvis-contracts` (bundled artifact when built, else the source
YAML — if neither resolves, the server logs a warning and keeps serving
unvalidated rather than refusing requests). Request shapes are always
validated — a body that violates the spec is rejected with `400 { "error": … }`
before any route logic. Response shapes are
checked only with `JARVIS_API_CONTRACT=verify` (set automatically by
`npm run dev` and by the `test/contract.test.ts` suite): a server response that
drifts from the spec fails loudly (logged 500) instead of silently mismatching
the documented contract. Security is deliberately **not** validated by the
middleware (`validateSecurity: false`) — auth is OR-composed (bearer device
token or session cookie) and stays owned by `src/http/middleware.ts`; shape
validation is purely additive to the hand-rolled checks in `authRoutes.ts`.

### Transport security

By default the server is plain HTTP (the LAN posture) and binds
`0.0.0.0` (`JARVIS_HOST` to narrow). When the server will face anything less
trusted than a known LAN, enable TLS in-node with `JARVIS_TLS_CERT` +
`JARVIS_TLS_KEY` (PEM files). TLS mode keeps serving on `PORT` as HTTPS and
starts a cleartext listener on `JARVIS_HTTP_REDIRECT_PORT` (default
`PORT + 1`) that 302-upgrades every request to the HTTPS origin. The WebSocket
endpoint inherits whichever transport the HTTP server uses, so `/ws` is
`wss://` under TLS. Local state under `~/.jarvis` is tightened on startup: the
directory becomes `0700` and each SQLite database `0600`, so account hashes
and conversation checkpoints aren't world-readable on a shared machine.

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

Authoritative machine-checked tables live in `@lukestanbery/jarvis-contracts`:
the spec'd REST surface in [`docs/endpoints-rest.md`](../contracts/docs/endpoints-rest.md)
(generated from `packages/contracts/spec/openapi.yaml`, enforced at runtime by
`express-openapi-validator`) and the WebSocket channel in
[`docs/endpoints-ws.md`](../contracts/docs/endpoints-ws.md). The rows below are
the commonly-used subset for orientation (auth labels match the generated
table — "web session" is the `jarvis_session` cookie):

| Method   | Path                       | Auth                                | Description                                                                              |
| -------- | -------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET`    | `/`                        | none                                | Health-check, returns `Hello World`                                                      |
| `WS`     | `/ws`                      | optional device token (first frame) | Chat endpoint (WebSocket)                                                                |
| `POST`   | `/api/bootstrap`           | `x-bootstrap-token` header          | Create the first (owner) account + device token                                          |
| `POST`   | `/api/auth/login`          | none                                | Username + password → a (rotating) device token                                          |
| `GET`    | `/api/me`                  | device token or web session         | Current user + their devices                                                             |
| `POST`   | `/api/devices`             | device token or web session         | Provision a new device token for the caller                                              |
| `DELETE` | `/api/devices/{id}`        | device token or web session         | Revoke a device (own, or any as owner)                                                   |
| `GET`    | `/api/users`               | device token or web session (owner) | List accounts                                                                            |
| `POST`   | `/api/users`               | device token or web session (owner) | Create an account (`role` optional, default `user`)                                      |
| `PATCH`  | `/api/users/{id}`          | device token or web session (owner) | Update `role`/`disabled` (self-disable → 400; demoting the last **enabled** owner → 409) |
| `GET`    | `/api/sessions`            | device token or web session         | List sessions (owner sees all, with `userId`)                                            |
| `DELETE` | `/api/sessions/{threadId}` | device token or web session         | Delete the caller's owned session (owner: any)                                           |

"Device token" auth is `Authorization: Bearer <token>`; the web session is the
`jarvis_session` cookie (+ `x-csrf-token` on state changes).

### Chat protocol

The wire protocol (frames, limits, and parse/serialize logic) is defined once
in the shared `@lukestanbery/jarvis-protocol` package (machine-readable mirror:
`packages/contracts/spec/asyncapi.yaml`); connect a WebSocket client to `/ws`
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
