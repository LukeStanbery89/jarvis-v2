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

| Command               | Description                                        |
| --------------------- | -------------------------------------------------- |
| `npm run build`       | Compile TypeScript to `dist/`                      |
| `npm run typecheck`   | Type-check src and tests                           |
| `npm run dev`         | Run the server with watch mode                     |
| `npm start`           | Run the compiled server                            |
| `npm test`            | Run the test suite                                 |
| `npm run tts:harness` | Local TTS harness: text → PCM → played aloud (#83) |

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
  images render), a dynamic `connect-src 'self' ws://<host> wss://<host>` built from the request's `Host`
  header so `/ws` can be reached over the socket, `worker-src 'self';` for the local speech engine's
  same-origin module worker (#84 P3b), and `script-src 'self' 'wasm-unsafe-eval'` — the narrow keyword that
  admits Wasm compile/instantiate without letting JS `eval`/`new Function` through. The portal mount keeps
  `img-src 'self' data:` and a static `connect-src 'self'`, and adds no `worker-src` or `'wasm-unsafe-eval'`.
- The one file that _does_ evaluate strings is the engine's worker entry (`/web/assets/vosk.worker-<hash>.js`):
  embind's runtime synthesizes per-method invokers with `new Function` on first call, a second eval site the
  fork cannot remove. That **file** is served with its own
  `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'` — for a
  dedicated worker whose entry script declares a CSP, that policy governs the worker scope _instead of_ the
  owner's, so eval is granted only inside that hashed, same-origin module (which itself still `connect-src`s
  same-origin for the model archive). The page scope never allows eval.
- Requests under `/web` are skipped by the portal SPA fallback (which is `/web`-boundary aware — `/webfoo` still gets the portal shell), so with the web client unbuilt or disabled `GET /web` is an honest 404, never the portal shell. `GET /web` itself 301s to `/web/` before serving `index.html` (standard `express.static` directory redirect); note that redirect response carries `serve-static`'s own strict `Content-Security-Policy: default-src 'none'` (browsers follow it and get the real headers on the target).

## Cross-origin and reverse proxy

Only relevant when a browser SPA is served from a **different origin** than the API (issue #63). The default deployments — SPAs served from `/` and `/web`, and the Vite dev server's `/api` + `/ws` proxy — are all same-origin and ignore these settings.

- `JARVIS_CORS_ORIGINS` is a comma-separated allowlist of **exact** origins. Unset or empty **denies all cross-origin requests** (no `Access-Control-*` header is emitted), so same-origin clients are unaffected. Origins are normalized case-insensitively with a trailing `/` dropped.
- **No wildcard, ever.** The API is credentialed (bearer token _and_ cookie); browsers reject `Access-Control-Allow-Origin: *` on credentialed requests anyway, and a literal `*` entry is dropped with a warning. A disallowed origin gets no header rather than a 403, so a refusal does not confirm the allowlist exists.
- Preflight is answered with `204` **before** `mountContractValidator`, which is load-bearing: the validator rejects `OPTIONS` against paths declaring only `POST`/`GET`, so a preflight reaching it would fail with a validation error instead of unlocking the real request. Keep the CORS mount first in `createApp`.
- `JARVIS_TRUST_PROXY_CIDRS` lists the IPs/subnets whose `X-Forwarded-For` is believed, so `req.ip` is the real client rather than the proxy — without it every client behind a proxy shares one rate-limit bucket. Unset trusts nothing; unparseable entries never match, so a typo fails closed.
- **Cookie auth does not work cross-origin, by decision.** `setSessionCookie` emits `SameSite=Strict`, never sent cross-site, and `SameSite=None` is itself rejected without `Secure` (the default posture is plain HTTP). Cross-origin browser clients must use device-token auth; `packages/web` already does, while `packages/portal` (cookie session) stays same-origin.

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
    - **Any time, refreshable:** `{ "type": "location", "lat": <n>, "lon": <n>, "label"?: "<place>" }` (#31) —
      the device's whereabouts for location-aware tools (the `getWeather` tool). Lat/lon are finite within
      their geographic ranges; the optional label is ≤64 chars. The latest report wins for subsequent turns;
      kept in memory for the socket's lifetime only, never persisted, never logged at coordinate precision.
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
disabled accounts with 403. `POST /api/bootstrap` shares the same `RateLimiter` instance but is isolated by its own
`bootstrap:` key namespace. Per-username keys enforce `maxFailures`; the aggregate per-IP keys (login and
bootstrap) enforce `maxIpFailures` — `admit(key, kind)` makes that explicit per call (#66). The single source of
truth for throttling is the rate-limiting section of this package's `README.md`. The `/ws` chat path is
**not** frequency-limited (#65).
The bootstrap token is single-use — a
`BootstrapGate` in `authRoutes` consumes it after a successful bootstrap, leaving the config object untouched. TLS
is optional in-node (`JARVIS_TLS_CERT`/`JARVIS_TLS_KEY`); in TLS mode the main listener is HTTPS and a cleartext
redirect app (port `PORT + 1`, `JARVIS_HTTP_REDIRECT_PORT`) upgrades requests. `src/fs.ts` chmods `~/.jarvis` to
`0700` and its database files to `0600` on open (via the `fs.ts` helpers exported by `@lukestanbery/jarvis-auth`).

## Source layout

- `src/index.ts` — process entry: loads `.env` via `import "dotenv/config"` (first import, so `config.ts` sees the file; real env always wins), config, `openAppDatabase` (from `@lukestanbery/jarvis-auth`), `createApp`, `attachChatServer` — hands the app to the listener seam.
- `src/config.ts` — `AppConfig` / `getAppConfig` (environment parsing, `JARVIS_*` / `LLM_*`); `RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG` live here (not `http/`); `apiContractVerify` (`JARVIS_API_CONTRACT=verify`) toggles REST response verification; `corsOrigins` (`JARVIS_CORS_ORIGINS`, normalized via `normalizeOrigin`) and `trustProxyCidrs` (`JARVIS_TRUST_PROXY_CIDRS`) hold the cross-origin posture; `defaultWebDir`.
- `src/logger.ts` — shared `@lukestanbery/jarvis-logger` instance (tag `server`).
- `src/listener.ts` — `createJarvisServer`: HTTP(S) server construction, in-node TLS / cert reads, half-set-TLS guard, bind + `listen`, and the cleartext redirect listener (`PORT + 1`, `JARVIS_HTTP_REDIRECT_PORT`).
- `src/app.ts` — `createApp(store, appConfig)`: Express app + JSON error handler, `/health`, mounts `/api`, the
  portal static serving + SPA fallback capped with a strict CSP (only when `portalDir` holds `index.html`), and
  (when `webDir` holds `index.html`) the `/web` web chat mount with a widened CSP + `/web`-scoped SPA fallback;
  `createHttpsRedirectApp`. Sets `app.set("trust proxy", …)` from `trustProxyCidrs` and mounts
  `createCorsMiddleware` **before** `express.json()` and the contract validator — both orderings are load-bearing.
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
- `src/http/cors.ts` — `createCorsMiddleware(origins?)`: the cross-origin policy (exact-origin allowlist, `Vary: Origin`, 204 preflight). Denies all cross-origin when the list is unset/empty; never emits `*`. Must stay mounted ahead of `express.json()` and the contract validator.
- `src/http/rateLimit.ts` — the credential throttle (`RateLimiter`): one in-memory instance shared by every credential endpoint, isolated by key namespace (`login:` / `bootstrap:`), fixed window + per-key lockout with exponential backoff. Counts attempts at admission (before scrypt) and clears a key on success. In-memory per process; trusts `req.ip` as-is. Not reusable as a quota — see the rate-limiting section of `README.md`.
- `@lukestanbery/jarvis-auth` (workspace dep) — app database + credential crypto (see its README): `openAppDatabase`
  (backed by `JARVIS_DB_PATH`, `~/.jarvis/jarvis.sqlite`) exposes `AppDatabase` as the intersection of three role
  interfaces — `UserLedger`/`DeviceLedger`/`SessionLedger`; `crypto.ts` (the primitives), `credential.ts` (the
  `CredentialVerifier` seam the REST layer codes against), `ownership.ts` (`ownsRow`/`canManage` — the one
  shared row-ownership policy), `errors.ts`, `types.ts`, `fs.ts`.
- `src/ws.ts` — the `/ws` endpoint: `hello` capability handshake + auth handshake + `location` device reports (#31) + prompt framing. The session lifecycle (claim, ownership
  guard, per-thread lock, touch, guest cleanup) lives in `src/sessionManager.ts`. Prompts referencing attachments (#10) require an authenticated socket and pre-turn id validation against the attachment store.
- `src/attachments/store.ts` — the transient attachment store (#10): ids, TTL, ownership, magic bytes; factory-created, injected (never built inside the agent graph).
- `src/attachments/limiters.ts` — attachment quotas (VL calls/min, held bytes, upload semaphore); NOT `RateLimiter` reuse.
- `src/agent.ts` — `runAgent` seam owning the LangGraph graph + checkpointer; `systemPromptForCapabilities` conditions the system prompt on the client's declared rendering capabilities (and, under `mode: "voice"` (#83), appends `VOICE_FORMAT_RULE` so the reply is spoken-word prose — no markdown, no parentheses, units spelled out; scoped per-turn, so text prompts on the same thread render richly again) and always appends four fixed hygiene paragraphs (one well-formed tool call at a time; exactly one `getCurrentTime` call per time/date/weekday ask with the question passed verbatim so it returns the requested facet; attachment-lookups pass the exact id through to `analyzeImage`; and discovery-first, re-search-before-claiming-absence, one-exact-id, never-guess discipline for `homeAssistant`) so emulated tool calling doesn't fragment calls, reuse stale time answers, or invent a device.
- `src/transport.ts` — `AgentEvent → ServerFrame` mapping.
- `src/llm/agentGraph.ts` — model node + tools loop (streamed in `messages` mode, flattened to `AgentEvent`s).
- `src/llm/chatModel.ts` — the chat model: one of the two modules that know `@langchain/openai` (the other is `visionModel.ts`).
- `src/llm/visionModel.ts` — the vision-language model the `analyzeImage` tool calls (#10): non-streaming, bounded by an AbortSignal timeout, reasoning discarded.
- `src/llm/tools/search/` — the web-search providers (#9): hand-rolled Tavily + Serper fetch clients behind one normalized shape; keys are env secrets, never logged or in error text.
- `src/llm/tools/webSearch.ts` — the `webSearch` tool: Tavily-first routing (free quota) with Serper fallback, per-user call quota checked before any fetch. Registered only when a provider key is configured.
- `src/llm/tools/weather/` — the OpenWeather provider (#31): normalized current/forecast shapes, defensive parsing (absent phenomena → undefined), forecast steps folded into days by LOCAL date. Keys are env secrets, never logged or in error text.
- `src/llm/tools/getWeather.ts` — the `getWeather` tool: { location?, scope? }; location falls through model argument → device coordinates (the socket's latest `location` frame via `configurable.location`) → "ask the user which city". Per-user call quota checked before any fetch. Registered only when `OPENWEATHER_API_KEY` is configured.
- `src/llm/tools/homeAssistant/` — the Home Assistant REST client (#15): `GET /api/states` filtered to `JARVIS_HA_READ_DOMAINS` and cached for `JARVIS_HA_CACHE_TTL_MS` (in-flight requests collapse; failures are never cached), `POST /api/services/<domain>/<service>` for writes, which **discards the response body** (its states are dispatch-time, never the outcome) and drops the snapshot — a 2xx alone is the acceptance signal, so `ignoreBody` keeps a proxy-rewritten body from turning a successful write into a failure. `types.ts` is the tool↔client seam; the token is a `Bearer` header only — never in a URL, a log, or error text.
- `src/llm/tools/homeAssistant.ts` — the `homeAssistant` tool: one tool, `{ action, entity_id?, query?, value? }` over `list`/`lights`/`switches`/`get`/`turn_on`/`turn_off`/`toggle`/`set_brightness`/`set_temperature`. The two discovery actions carry the category REST does not — `lights` is the `light`/`switch` domains plus a `JARVIS_HA_LIGHT_TOKENS` fragment in the id or name (a light is a `switch.*` on many instances), `switches` is the `switch` domain minus `_led` shadow children — and every read states how many of the readable entities it matched. Per-user quota checked before any fetch; every write resolves `entity_id` against the live snapshot and is checked against `JARVIS_HA_CONTROL_DOMAINS` (a strict subset of the read domains — locks/covers stay read-only), the action's required domain, and the entity's own state (`unavailable`/`unknown` refuses) before any HTTP. Writes report the **accepted action**, never a state — the model is told to call `get` for current state. Registered only when `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_ACCESS_TOKEN` are both configured.
- `src/rate/fixedWindowQuota.ts` — the generic per-user fixed-window quota (VL calls, search calls, weather calls, Home Assistant calls); `VlCallLimiter` is its domain-named alias.
- `src/tts/` — server-side TTS (#83): `types.ts` is the `TtsProvider` seam (text → mono float PCM + rate, cooperative `AbortSignal`), `kokoro.ts` is the engine (kokoro-js, lazy dynamic import — the optional deps are `kokoro-js` + `@huggingface/transformers`, ambient-typed in `kokoro-modules.d.ts` because node10 resolution can't see their `exports` types), `segmenter.ts` + `orchestrator.ts` are the turn pipeline (tokens → segments → one sequential synthesis worker → ordered audio). Segmenter granularity (#89, `JARVIS_TTS_SEGMENT=sentence|clause`, default `sentence`): clause mode additionally splits at commas/semicolons (≥ `minClauseChars`, digit-guarded) so the first PCM lands earlier, trading prosody for latency. `speakTurn` takes optional `{ granularity, onFirstSegment }` — `ws.ts` uses the callback plus its own timestamps to log the per-turn TTFA decomposition at debug (`first token / first segment / first audio sent`). Wired into `/ws` for voice-mode turns from `audio`-capable sockets: `audioStart` → binary s16le PCM → `audioEnd`, all before `done`, gated by `JARVIS_TTS_PROVIDER`; speakability is prompt-side (`agent.ts` `VOICE_FORMAT_RULE` — the model writes spoken-word prose for voice turns; incidental markup reads as written, no deterministic say-proofing pass). Synthesis failure never disturbs the text stream (no `audioError` frame yet). Weights cache privately under `~/.jarvis/tts`; missing optional install = unavailable TTS, never a boot failure. `scripts/tts-harness.ts` (`npm run tts:harness`) is the manual text → WAV → playback tool.
- `src/stt/` — local STT model serving (#84 P3b): `model.ts` is the download-once cache (`SttModelCache` — lazy first fetch, in-flight collapse, temp-file-then-rename, retry on the next request) plus `createSttModelHandler` for `GET /api/stt/model` (200 `application/gzip`; JSON 404 unconfigured; JSON 503 while an upstream fetch fails). Gated by `JARVIS_STT_PROVIDER=vosk`; the archive caches privately under `~/.jarvis/stt` (`JARVIS_STT_MODEL_DIR`) fetched from `JARVIS_STT_MODEL_URL`. The route is public by design (open-source weights, not user data; the recognition worker cannot attach auth headers) and mounts after the contract validator so it stays contract-checked (`sttModelGet` in the OpenAPI spec).
- `src/wake/` — wake-word model serving (#84 P4): `model.ts` is a per-file download-once cache (`WakeModelCache` — three-file allowlist, lazy first fetch, in-flight collapse, temp-file-then-rename, retry on the next request) plus `createWakeModelHandler` for `GET|HEAD /api/wake/model/:file` (200 `application/octet-stream` + `Cache-Control: public, max-age=86400`; JSON 404 unconfigured/unknown; JSON 503 while an upstream fetch fails). Gated by `JARVIS_WAKE_PROVIDER=openwakeword`; models cache privately under `~/.jarvis/wake` (`JARVIS_WAKE_MODEL_DIR`) fetched from the openWakeWord release host (`JARVIS_WAKE_MODEL_URL`). Public by design (open-source weights, no auth headers on the browser side) and mounts after the contract validator (`wakeModelGet`/`wakeModelHead` in the OpenAPI spec).
- `src/llm/tools/` — the tool implementations; `analyzeImage.ts` resolves attachment ids and enforces ownership via `ToolRuntime.configurable`. Optional tools (`webSearch`, `getWeather`, `homeAssistant`) register only when their credentials are configured, and each gates on the verified `ToolRuntime.configurable.userId`.
- `test/` — Vitest suites: `app.test.ts` (health + portal/web serving), `ws.test.ts` (frames + handshakes), `agent.test.ts` (capability prompt conditioning), `http.test.ts`, `sessionManager.test.ts`, `contract.test.ts`, `homeAssistant.client.test.ts`, `homeAssistant.tool.test.ts`.

`src/ws.ts` is the only module that touches the agent seam; exactly two modules know `@langchain/openai`
(`chatModel.ts` for chat, `visionModel.ts` for image analysis); nothing outside `@lukestanbery/jarvis-auth` hashes or compares secrets (within it, only
`crypto.ts` holds the primitives — the REST layer reaches password crypto solely through the `credential.ts` seam).

## Logging

Server logs go through the shared `@lukestanbery/jarvis-logger` instance in `src/logger.ts` (tag `server`):
`YYYY-MM-DD HH:mm:ss [LEVEL] server — message` lines, colored by level. Default level is `info`; set
`JARVIS_LOG_LEVEL` (`silent` | `debug` | `info` | `warn` | `error`) to change it; the default is `silent` under a test runner.

User prompts (`logger.sensitive`) and streamed tokens (`logger.sensitiveDebug`) are sensitive payloads: redacted
by default, logged verbatim only under `NODE_ENV=development` (the `npm run dev` script sets this). Production is
redacted by default — never log prompt/response payloads there; `JARVIS_LOG_SENSITIVE=full|redacted` overrides the
mode. Never prefix log messages with `[INFO]`/`[DEBUG]`.
