# AGENTS.md

## Purpose

`@lukestanbery/jarvis-server` — Express backend server for the J.A.R.V.I.S. AI assistant. Exposes a `GET /health`
health check, a REST management API (`/api` for accounts/devices/sessions/prefs — device-token **or** cookie auth with
CSRF), a WebSocket chat endpoint (`/ws`) that accepts prompts and streams back a response, and serves the web
portal SPA at `/` when it has been built (see "Web portal" below) plus the web chat client at `/web` (see
"Web chat client").

## Stack

- TypeScript (strict, ES2020, CommonJS)
- Express 5 + `ws` for WebSocket server
- LangChain (`@langchain/core` + `@langchain/openai`) for the model stack
- LangGraph (`@langchain/langgraph`) + SQLite checkpoints for the agent loop
- The app database (`users`/`devices`/`sessions`/`prefs`) + password/device-token crypto live in the shared
  `@lukestanbery/jarvis-auth` package (see its README) — the server only consumes its seams
- `better-sqlite3` is a direct server dependency for exactly one reason: `src/agent.ts` opens the LangGraph
  checkpoint database (`~/.jarvis/checkpoints.sqlite`), a separate file from auth's app database
  (`~/.jarvis/jarvis.sqlite`). The server owns that file's contents; auth supplies only the filesystem-posture
  helpers (`ensurePrivateStorage`/`ensurePrivateFile`) applied to it. Within `src/` the driver is imported in
  one place only (`agent.ts`); server tests build `:memory:` stores via `createInMemoryAppDatabase()` from the
  `@lukestanbery/jarvis-auth/testing` subpath and do not import the driver
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

Authoritative tables: `packages/contracts/docs/endpoints-rest.md` (REST) and
`endpoints-ws.md` (WebSocket), generated from the OpenAPI/AsyncAPI specs in
`packages/contracts/spec/`. The table below is the orientation subset; update
the specs, not this table, when routes change.

| Method   | Path                       | Auth                                  | Description                                                                                           |
| -------- | -------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                  | none                                  | Machine health check → `{ "ok": true }`                                                               |
| `GET`    | `/`                        | none                                  | Serves the built portal SPA ("Hello World" without one)                                               |
| `GET`    | `/web`                     | none                                  | Serves the built web chat client (301 to `/web/`, then the SPA)                                       |
| `WS`     | `/ws`                      | optional device token (first frame)   | Chat endpoint (WebSocket)                                                                             |
| `POST`   | `/api/bootstrap`           | `x-bootstrap-token` header            | Create the first (owner) account + device token                                                       |
| `POST`   | `/api/auth/login`          | none                                  | Username + password → a (rotating) device token                                                       |
| `POST`   | `/api/session`             | none                                  | Username + password → session cookie + CSRF token                                                     |
| `GET`    | `/api/session`             | device token or session               | Current session user (+ the `csrfToken` for cookies)                                                  |
| `DELETE` | `/api/session`             | device token or session (+ CSRF)      | Sign out: revoke the session + clear the cookie                                                       |
| `GET`    | `/api/me`                  | device token or session               | Current user + their devices                                                                          |
| `POST`   | `/api/devices`             | device token or session (+ CSRF)      | Provision a new device token for the caller                                                           |
| `PATCH`  | `/api/devices/{id}`        | device token or session (+ CSRF)      | Rename an owned device                                                                                |
| `DELETE` | `/api/devices/{id}`        | device token or session (+ CSRF)      | Revoke a device (own, or any as owner)                                                                |
| `GET`    | `/api/users`               | device token or session (owner)       | List accounts                                                                                         |
| `POST`   | `/api/users`               | device token or session (owner, CSRF) | Create an account (`role` optional, default `user`)                                                   |
| `PATCH`  | `/api/users/{id}`          | device token or session (owner, CSRF) | Update `role`/`disabled` (self-disable → 400; demoting the last **enabled** owner → 409 `LAST_OWNER`) |
| `GET`    | `/api/users/{id}/devices`  | device token or session (owner)       | List another account's devices (for management)                                                       |
| `GET`    | `/api/users/{id}/prefs`    | device token or session (owner)       | Read any account's preferences                                                                        |
| `PUT`    | `/api/users/{id}/prefs`    | device token or session (owner, CSRF) | Upsert any account's preferences                                                                      |
| `DELETE` | `/api/users/{id}/prefs`    | device token or session (owner, CSRF) | Clear any account's preferences                                                                       |
| `GET`    | `/api/prefs`               | device token or session               | Read the caller's preferences                                                                         |
| `PUT`    | `/api/prefs`               | device token or session (+ CSRF)      | Upsert the caller's preferences                                                                       |
| `DELETE` | `/api/prefs`               | device token or session (+ CSRF)      | Clear the caller's preferences                                                                        |
| `GET`    | `/api/sessions`            | device token or session               | List sessions (owner sees all, with `userId`)                                                         |
| `DELETE` | `/api/sessions/{threadId}` | device token or session (+ CSRF)      | Delete the caller's owned session (owner: any)                                                        |

The server listens on port `54321` by default, overridable via `PORT`. REST auth is
`Authorization: Bearer <device-token>` **or** the `jarvis_session` cookie (see `src/http/middleware.ts`):
`requireAuth` tries the bearer first and falls back to the cookie; cookie-authenticated requests must send
`x-csrf-token` on state-changing methods (`POST`/`PATCH`/`DELETE`/`PUT`) via `requireCsrf`. The session cookie is
`HttpOnly`/`SameSite=Strict`, gets the `Secure` + `__Host-` prefix under TLS, and carries the device-echoed success. Session TTL defaults to `DEFAULT_SESSION_TTL_MS` (30 days), overridable via `JARVIS_SESSION_TTL_MS`.

## Web portal

The server serves the built portal SPA (`@lukestanbery/jarvis-portal`) at `/` via `express.static` plus an SPA
fallback that replays `index.html` for non-`/api` GET/HEAD requests. It is only mounted when the portal has been
built and `index.html` exists at the configured directory; otherwise `GET /` returns `Hello World`.

- The base directory is `JARVIS_PORTAL_DIR`, defaulting to `../../../portal/dist` resolved from `src/` (i.e.
  `packages/portal/dist`, produced by `vite build`). An empty string disables portal serving. `AppConfig.portalDir`
  mirrors the env var in tests.
- Following Node best practice, the SPA is served with a strict CSP
  (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src 'self'`) plus `X-Content-Type-Options: nosniff`. A `Cache-Control: no-cache` header keeps the
  hash-routed shell fresh.
- The `/api` namespace is untouched by the fallback, so REST, `/ws`, and `/health` keep working regardless.

## Web chat client

The server also serves the built web chat SPA (`@lukestanbery/jarvis-web`) at `/web` via `express.static` plus a
`/web`-scoped SPA fallback, mounted before the portal mount. It is only mounted when the client has been built and
`index.html` exists at the configured directory.

- The base directory is `JARVIS_WEB_DIR`, defaulting to `packages/web/dist` (produced by `vite build`); an empty
  string disables it. `AppConfig.webDir` mirrors the env var in tests.
- The mount widens the portal's strict CSP for the browser client only: `img-src 'self' data: https:` (remote
  images render) and a dynamic `connect-src 'self' ws://<host> wss://<host>` built from the request's `Host`
  header so `/ws` can be reached over the socket. The portal mount keeps `img-src 'self' data:` and a static
  `connect-src 'self'`.
- Requests under `/web` are skipped by the portal SPA fallback (which is `/web`-boundary aware — `/webfoo` still gets the portal shell), so with the web client unbuilt or disabled `GET /web` is an honest 404, never the portal shell. `GET /web` itself 301s to `/web/` before serving `index.html` (standard `express.static` directory redirect); note that redirect response carries `serve-static`'s own strict `Content-Security-Policy: default-src 'none'` (browsers follow it and get the real headers on the target).

## Chat protocol

The wire protocol (frame shapes, the ≤128-char `sessionId` and ≤128-char `token` bounds, and all
parsing/serialization) is defined once in `@lukestanbery/jarvis-protocol`; the server imports it and never
re-declares frames.

- Client → Server:
    - **First frame, optional:** `{ "type": "hello", "capabilities": ["markdown", "image", "link"] }` — the client
      announces how it renders responses so the model can tailor formatting. Tokens are from the closed set
      `markdown` / `html` / `image` / `link` (duplicates and unknown tokens are rejected; empty list = plain text).
      `systemPromptForCapabilities` frames each declared token into the system prompt (a client that claims
      `markdown` gets "Markdown is rendered…", etc.). A `hello` after any other frame is rejected as
      `hello frame must be the first frame`.
    - **First frame (or immediately after `hello`), optional:** `{ "type": "auth", "token": "<device token>" }` —
      the server replies with one `{ "authResult": { "user", "device" } }` frame; a bad token gets an error frame
      and the socket continues as a **guest**. An auth frame after any other frame is rejected.
    - `{ "prompt": "<text>", "sessionId": "<id>", "mode": "text"|"voice" }` — names the LangGraph conversation
      thread; the optional `mode` (default `"text"`) picks the chat style: text prompts use the socket's declared
      capabilities, voice prompts always yield plain conversational text (effective capabilities are emptied).
      Sending a prompt without authenticating makes the socket a guest for its lifetime.
- Server → Client per prompt: `tool`/`toolResult` frames while the agent calls tools, then `chunk` frames, then
  `{ "done": true }`. Errors: `{ "error": "<message>" }` + `{ "done": true }`.
- Rejections: a prompt while a previous turn is streaming, a concurrent turn on the same thread across sockets
  (per-thread lock), and a `sessionId` owned by a different principal (`session belongs to another user` — knowing a
  session id alone is never enough to read someone else's conversation).

Every prompt claims its `sessionId` in the session ledger (`AppDatabase.claimSession`) with the prompt's chat
`mode` recorded as the write-once `kind` (default `text`; an already-claimed thread keeps its first mode). Guest
sockets' claimed sessions are deleted on socket close; owned sessions persist. Turns are hard-capped by
`JARVIS_TURN_TIMEOUT_MS` (default `120000`); draining is best-effort on a hung model. Authenticated sockets are
re-checked against the store on every prompt so a revoked device is cut off immediately.

`POST /api/auth/login` and `POST /api/session` are RateLimited against the **same** `login:` quota (per
`(ip, username)` plus an aggregate per `ip`, exponential backoff) by `src/http/rateLimit.ts`, and both reject
disabled accounts with 403. `POST /api/bootstrap` is rate-limited separately. The bootstrap token is single-use — a
`BootstrapGate` in `authRoutes` consumes it after a successful bootstrap, leaving the config object untouched. TLS
is optional in-node (`JARVIS_TLS_CERT`/`JARVIS_TLS_KEY`); in TLS mode the main listener is HTTPS and a cleartext
redirect app (port `PORT + 1`, `JARVIS_HTTP_REDIRECT_PORT`) upgrades requests. `src/fs.ts` chmods `~/.jarvis` to
`0700` and its database files to `0600` on open (via the `fs.ts` helpers exported by `@lukestanbery/jarvis-auth`).

## Source layout

- `src/index.ts` — process entry: loads `.env` via `import "dotenv/config"` (first import, so `config.ts` sees the file; real env always wins), config, `openAppDatabase` (from `@lukestanbery/jarvis-auth`), `createApp`, `attachChatServer` — hands the app to the listener seam.
- `src/config.ts` — `AppConfig` / `getAppConfig` (environment parsing, `JARVIS_*` / `LLM_*`); `RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG` live here (not `http/`); `apiContractVerify` (`JARVIS_API_CONTRACT=verify`) toggles REST response verification; `defaultWebDir`.
- `src/logger.ts` — shared `@lukestanbery/jarvis-logger` instance (tag `server`).
- `src/listener.ts` — `createJarvisServer`: HTTP(S) server construction, in-node TLS / cert reads, half-set-TLS guard, bind + `listen`, and the cleartext redirect listener (`PORT + 1`, `JARVIS_HTTP_REDIRECT_PORT`).
- `src/app.ts` — `createApp(store, appConfig)`: Express app + JSON error handler, `/health`, mounts `/api`, the
  portal static serving + SPA fallback capped with a strict CSP (only when `portalDir` holds `index.html`), and
  (when `webDir` holds `index.html`) the `/web` web chat mount with a widened CSP + `/web`-scoped SPA fallback;
  `createHttpsRedirectApp`.
- `src/http/middleware.ts` — `requireAuth` (Bearer device token, then session-cookie fallback → `req.jarv`),
  `requireOwner`, and `requireCsrf` (timing-safe `x-csrf-token` check for cookie-authenticated state-changing calls);
  `AuthedRequest` derives from the auth `AuthContext` union (`guest | authed | session`) so `authed(req).jarv` is
  the guaranteed non-null identity.
- `src/http/contractValidation.ts` — runtime REST contract gate: resolves the OpenAPI spec from
  `@lukestanbery/jarvis-contracts` (bundle, else source), mounts `express-openapi-validator` ahead of `/api` +
  `/health` (requests always; responses under `JARVIS_API_CONTRACT=verify`; `validateSecurity: false` — auth stays
  in `middleware.ts`), and maps validator errors onto the `{ error }` shape (client 400s; server-side violations
  logged + generic 500).
- `src/http/cookies.ts` — cookie parsing + the `jarvis_session` cookie name/attributes (`__Host-` under TLS).
- `src/http/authRoutes.ts` — the `/api` router (bootstrap, login, session, me, devices, users, sessions, prefs).
- `src/http/rateLimit.ts` — in-memory login/bootstrap throttle (per-`(ip, username)` + per-`ip`, exponential backoff).
- `@lukestanbery/jarvis-auth` (workspace dep) — app database + credential crypto (see its README): `openAppDatabase`
  (backed by `JARVIS_DB_PATH`, `~/.jarvis/jarvis.sqlite`) exposes `AppDatabase` as the intersection of three role
  interfaces — `UserLedger`/`DeviceLedger`/`SessionLedger`; `crypto.ts` (the primitives), `credential.ts` (the
  `CredentialVerifier` seam the REST layer codes against), `ownership.ts` (`ownsRow`/`canManage` — the one
  shared row-ownership policy), `errors.ts`, `types.ts`, `fs.ts`.
- `src/ws.ts` — the `/ws` endpoint: `hello` capability handshake + auth handshake + prompt framing. The session lifecycle (claim, ownership
  guard, per-thread lock, touch, guest cleanup) lives in `src/sessionManager.ts`.
- `src/agent.ts` — `runAgent` seam owning the LangGraph graph + checkpointer; `systemPromptForCapabilities` conditions the system prompt on the client's declared rendering capabilities and always appends two fixed hygiene paragraphs (one well-formed tool call at a time, and exactly one `getCurrentTime` call per time/date/weekday ask with the question passed verbatim so it returns the requested facet) so emulated tool calling doesn't fragment calls or reuse stale time answers.
- `src/transport.ts` — `AgentEvent → ServerFrame` mapping.
- `src/llm/agentGraph.ts` — model node + tools loop (streamed in `messages` mode, flattened to `AgentEvent`s).
- `src/llm/chatModel.ts` — the only module that knows `@langchain/openai`.
- `src/llm/tools/` — the tool implementations.
- `test/` — Vitest suites: `app.test.ts` (health + portal/web serving), `ws.test.ts` (frames + handshakes), `agent.test.ts` (capability prompt conditioning), `http.test.ts`, `sessionManager.test.ts`, `contract.test.ts`.

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
