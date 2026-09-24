# AGENTS.md

## Purpose

`@lukestanbery/jarvis-server` — Express backend server for the J.A.R.V.I.S. AI assistant. Exposes a `GET /` health
check, a REST management API (`/api` for accounts/devices/sessions/prefs — device-token **or** cookie auth with
CSRF), and a WebSocket chat endpoint (`/ws`) that accepts prompts and streams back a response.

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Express 5 + `ws` for WebSocket server
- LangChain (`@langchain/core` + `@langchain/openai`) for the model stack
- LangGraph (`@langchain/langgraph`) + SQLite checkpoints for the agent loop
- The app database (`users`/`devices`/`sessions`) + password/device-token crypto live in the shared
  `@lukestanbery/jarvis-auth` package (better-sqlite3; see its README) — the server only consumes its seams
- Logging via `@lukestanbery/jarvis-logger` (see `src/logger.ts`)
- Tests via Vitest + supertest

## Scripts

Run from `packages/server`:

| Command             | Description                    |
| ------------------- | ------------------------------ |
| `npm run build`     | Compile TypeScript to `dist/`  |
| `npm run typecheck` | Type-check src and tests       |
| `npm run dev`       | Run the server with watch mode |
| `npm start`         | Run the compiled server        |
| `npm test`          | Run the test suite             |

## Endpoints

| Method   | Path                      | Auth                                  | Description                                         |
| -------- | ------------------------- | ------------------------------------- | --------------------------------------------------- |
| `GET`    | `/`                       | none                                  | Health-check, returns `Hello World`                 |
| `WS`     | `/ws`                     | optional device token (first frame)   | Chat endpoint (WebSocket)                           |
| `POST`   | `/api/bootstrap`          | `JARVIS_BOOTSTRAP_TOKEN`              | Create the first (owner) account + device token     |
| `POST`   | `/api/auth/login`         | none                                  | Username + password → a (rotating) device token     |
| `POST`   | `/api/session`            | none                                  | Username + password → session cookie + CSRF token   |
| `GET`    | `/api/session`            | session cookie                        | Current session user                                |
| `DELETE` | `/api/session`            | session cookie (+ CSRF)               | Sign out: revoke the session + clear the cookie     |
| `GET`    | `/api/me`                 | device token or session               | Current user + their devices                        |
| `POST`   | `/api/devices`            | device token or session (+ CSRF)      | Provision a new device token for the caller         |
| `PATCH`  | `/api/devices/:id`        | device token or session (+ CSRF)      | Rename an owned device                              |
| `DELETE` | `/api/devices/:id`        | device token or session (+ CSRF)      | Revoke a device (own, or any as owner)              |
| `GET`    | `/api/users`              | device token or session (owner)       | List accounts                                       |
| `POST`   | `/api/users`              | device token or session (owner, CSRF) | Create an account (`role` optional, default `user`) |
| `PATCH`  | `/api/users/:id`          | device token or session (owner, CSRF) | Update `role`/`disabled` (self-disable → 400)       |
| `GET`    | `/api/users/:id/prefs`    | device token or session (owner)       | Read any account's preferences                      |
| `PUT`    | `/api/users/:id/prefs`    | device token or session (owner, CSRF) | Upsert any account's preferences                    |
| `GET`    | `/api/prefs`              | device token or session               | Read the caller's preferences                       |
| `PUT`    | `/api/prefs`              | device token or session (+ CSRF)      | Upsert the caller's preferences                     |
| `GET`    | `/api/sessions`           | device token or session               | List sessions (owner sees all, with `userId`)       |
| `DELETE` | `/api/sessions/:threadId` | device token or session (+ CSRF)      | Delete the caller's owned session (owner: any)      |

The server listens on port `54321` by default, overridable via `PORT`. REST auth is
`Authorization: Bearer <device-token>` **or** the `jarvis_session` cookie (see `src/http/middleware.ts`):
`requireAuth` tries the bearer first and falls back to the cookie; cookie-authenticated requests must send
`x-csrf-token` on state-changing methods (`POST`/`PATCH`/`DELETE`/`PUT`) via `requireCsrf`. The session cookie is
`HttpOnly`/`SameSite=Strict`, gets the `Secure` + `__Host-` prefix under TLS, and carries the device-echoed success. Session TTL defaults to `DEFAULT_SESSION_TTL_MS` (24h), overridable via `JARVIS_SESSION_TTL_MS`.

## Chat protocol

The wire protocol (frame shapes, the ≤128-char `sessionId` and ≤128-char `token` bounds, and all
parsing/serialization) is defined once in `@lukestanbery/jarvis-protocol`; the server imports it and never
re-declares frames.

- Client → Server:
    - **First frame, optional:** `{ "type": "auth", "token": "<device token>" }` — the server replies with one
      `{ "authResult": { "user", "device" } }` frame; a bad token gets an error frame and the socket continues as a
      **guest**. An auth frame after the first frame is rejected.
    - `{ "prompt": "<text>", "sessionId": "<id>" }` — names the LangGraph conversation thread. Sending a prompt
      without authenticating makes the socket a guest for its lifetime.
- Server → Client per prompt: `tool`/`toolResult` frames while the agent calls tools, then `chunk` frames, then
  `{ "done": true }`. Errors: `{ "error": "<message>" }` + `{ "done": true }`.
- Rejections: a prompt while a previous turn is streaming, a concurrent turn on the same thread across sockets
  (per-thread lock), and a `sessionId` owned by a different principal (`session belongs to another user` — knowing a
  session id alone is never enough to read someone else's conversation).

Every prompt claims its `sessionId` in the session ledger (`AppDatabase.claimSession`). Guest sockets' claimed
sessions are deleted on socket close; owned sessions persist. Turns are hard-capped by `JARVIS_TURN_TIMEOUT_MS`
(default `120000`); draining is best-effort on a hung model. Authenticated sockets are re-checked against the
store on every prompt so a revoked device is cut off immediately.

`POST /api/auth/login` and `POST /api/session` are RateLimited against the **same** `login:` quota (per
`(ip, username)` plus an aggregate per `ip`, exponential backoff) by `src/http/rateLimit.ts`, and both reject
disabled accounts with 403. `POST /api/bootstrap` is rate-limited separately. The bootstrap token is single-use — a
`BootstrapGate` in `authRoutes` consumes it after a successful bootstrap, leaving the config object untouched. TLS
is optional in-node (`JARVIS_TLS_CERT`/`JARVIS_TLS_KEY`); in TLS mode the main listener is HTTPS and a cleartext
redirect app (port `PORT + 1`, `JARVIS_HTTP_REDIRECT_PORT`) upgrades requests. `src/fs.ts` chmods `~/.jarvis` to
`0700` and its database files to `0600` on open (via the `fs.ts` helpers exported by `@lukestanbery/jarvis-auth`).

## Source layout

- `src/index.ts` — process entry: config, `openAppDatabase` (from `@lukestanbery/jarvis-auth`), `createApp`, `attachChatServer` — hands the app to the listener seam.
- `src/config.ts` — `AppConfig` / `getAppConfig` (environment parsing, `JARVIS_*` / `LLM_*`); `RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG` live here (not `http/`).
- `src/logger.ts` — shared `@lukestanbery/jarvis-logger` instance (tag `server`).
- `src/listener.ts` — `createJarvisServer`: HTTP(S) server construction, in-node TLS / cert reads, half-set-TLS guard, bind + `listen`, and the cleartext redirect listener (`PORT + 1`, `JARVIS_HTTP_REDIRECT_PORT`).
- `src/app.ts` — `createApp(store, appConfig)`: Express app + JSON error handler, mounts `/api`; `createHttpsRedirectApp`.
- `src/http/middleware.ts` — `requireAuth` (Bearer device token, then session-cookie fallback → `req.jarv`),
  `requireOwner`, and `requireCsrf` (timing-safe `x-csrf-token` check for cookie-authenticated state-changing calls).
- `src/http/cookies.ts` — cookie parsing + the `jarvis_session` cookie name/attributes (`__Host-` under TLS).
- `src/http/authRoutes.ts` — the `/api` router (bootstrap, login, session, me, devices, users, sessions, prefs).
- `src/http/rateLimit.ts` — in-memory login/bootstrap throttle (per-`(ip, username)` + per-`ip`, exponential backoff).
- `@lukestanbery/jarvis-auth` (workspace dep) — app database + credential crypto (see its README): `openAppDatabase`
  (backed by `JARVIS_DB_PATH`, `~/.jarvis/jarvis.sqlite`) exposes `AppDatabase` as the intersection of three role
  interfaces — `UserLedger`/`DeviceLedger`/`SessionLedger`; `crypto.ts` (the primitives), `credential.ts` (the
  `CredentialVerifier` seam the REST layer codes against), `ownership.ts` (`ownsRow`/`canManage` — the one
  shared row-ownership policy), `errors.ts`, `types.ts`, `fs.ts`.
- `src/ws.ts` — the `/ws` endpoint: auth handshake + prompt framing. The session lifecycle (claim, ownership
  guard, per-thread lock, touch, guest cleanup) lives in `src/sessionManager.ts`.
- `src/agent.ts` — `runAgent` seam owning the LangGraph graph + checkpointer.
- `src/transport.ts` — `AgentEvent → ServerFrame` mapping.
- `src/llm/agentGraph.ts` — model node + tools loop (streamed in `messages` mode, flattened to `AgentEvent`s).
- `src/llm/chatModel.ts` — the only module that knows `@langchain/openai`.
- `src/llm/tools/` — the tool implementations.
- `test/` — Vitest suites: `app.test.ts`, `ws.test.ts`, `http.test.ts`, `sessionManager.test.ts`.

`src/ws.ts` is the only module that touches the agent seam; `src/llm/chatModel.ts` is the only module that knows
`@langchain/openai`; nothing outside `@lukestanbery/jarvis-auth` hashes or compares secrets (within it, only
`crypto.ts` holds the primitives — the REST layer reaches password crypto solely through the `credential.ts` seam).

## Logging

Server logs go through the shared `@lukestanbery/jarvis-logger` instance in `src/logger.ts` (tag `server`):
`YYYY-MM-DD HH:mm:ss [LEVEL] server — message` lines, colored by level. Default level is `info`; set
`JARVIS_LOG_LEVEL` (`debug` | `info` | `warn` | `error`) to change it.

User prompts (`logger.sensitive`) and streamed tokens (`logger.sensitiveDebug`) are sensitive payloads: redacted
by default, logged verbatim only under `NODE_ENV=development` (the `npm run dev` script sets this). Production is
redacted by default — never log prompt/response payloads there; `JARVIS_LOG_SENSITIVE=full|redacted` overrides the
mode. Never prefix log messages with `[INFO]`/`[DEBUG]`.
