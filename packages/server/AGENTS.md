# AGENTS.md

## Purpose

`@lukestanbery/jarvis-server` — Express backend server for the J.A.R.V.I.S. AI assistant. Exposes a `GET /health`
health check, a REST management API (`/api` for accounts/devices/sessions/prefs — device-token **or** cookie auth with
CSRF), a WebSocket chat endpoint (`/ws`) that accepts prompts and streams back a response, and serves the web
web app at `/` when it has been built (see "Web app" below) plus the admin portal at `/admin` (see
"Admin portal").

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

The canonical REST/WS surface lives in [`packages/contracts/spec/`](../../packages/contracts/spec/) and the generated docs in [`packages/contracts/docs/`](../../packages/contracts/docs/). Update specs, not ad-hoc tables, when routes change.

## Admin portal (`/admin`)

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

## Web app (`/`)

The server serves the built web app (`@lukestanbery/jarvis-web`) at `/` via `express.static` plus an
SPA fallback — it is the front door since #90 phase 6a, and the admin portal moved to `/admin` behind it. It is only mounted when the client has been built and
`index.html` exists at the configured directory.

- The base directory is `JARVIS_WEB_DIR`, defaulting to `packages/web/dist` (produced by `vite build`); an empty
  string disables it. `AppConfig.webDir` mirrors the env var in tests.
- The app's mount widens the admin surface's strict CSP for the app only: `img-src 'self' data: https:` (remote
  images render), a dynamic `connect-src 'self' ws://<host> wss://<host>` built from the request's `Host`
  header so `/ws` can be reached over the socket, `worker-src 'self';` for the local speech engine's
  same-origin module worker (#84 P3b), and `script-src 'self' 'wasm-unsafe-eval'` — the narrow keyword that
  admits Wasm compile/instantiate without letting JS `eval`/`new Function` through. The `/admin` mount keeps
  `img-src 'self' data:` and a static `connect-src 'self'`, and adds no `worker-src` or `'wasm-unsafe-eval'`.
- The one file that _does_ evaluate strings is the engine's worker entry (`/assets/vosk.worker-<hash>.js`):
  embind's runtime synthesizes per-method invokers with `new Function` on first call, a second eval site the
  fork cannot remove. That **file** is served with its own
  `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'` — for a
  dedicated worker whose entry script declares a CSP, that policy governs the worker scope _instead of_ the
  owner's, so eval is granted only inside that hashed, same-origin module (which itself still `connect-src`s
  same-origin for the model archive). The page scope never allows eval.
- `/web*` answers **301 → `/chat`** (the client's former mount, #90 phase 6a), query string included: one redirect rather than a second mount, a bookmark lands on the chat, and the documented dev flags (`?debug=1`, `?voice-harness=1`, `?voice-trace=1`) survive. It is registered ahead of the app's fallback so the old path cannot be swallowed.
- The app's SPA fallback skips `/admin`, so an unbuilt or disabled admin surface is an honest 404 rather than the app's shell wearing the admin address. Mounted in that order — `/admin` first, then the app at `/` — the admin surface keeps its strict CSP and the app its wider one. It also replays `index.html` for any other GET, which is what lets the app route real paths (`/chat`, `/timers`, …) without a server route each.

## Cross-origin and reverse proxy

Only relevant when a browser SPA is served from a **different origin** than the API (issue #63). The default deployments — the app at `/`, the admin portal at `/admin`, and the Vite dev server's `/api` + `/ws` proxy — are all same-origin and ignore these settings.

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
    - **First frame, optional:** `{ "type": "hello", "capabilities": ["markdown", "html", "image", "link", "audio", "notification"] }` — the client
      announces how it renders responses so the model can tailor formatting. Tokens are from the closed set
      `markdown` / `html` / `image` / `link` / `audio` / `notification` (duplicates and unknown tokens are rejected; empty list = plain text).
      `systemPromptForCapabilities` frames each declared token into the system prompt (a client that claims
      `markdown` gets "Markdown is rendered…", etc.); `notification` (#139) is not a rendering token — it declares that the
      client can handle the out-of-turn `notification` frame, and it is what **gates** that frame, since a client whose
      parser rejects an unreadable frame (the CLI tears its connection down, #106) must never be sent one. A `hello`
      after any other frame is rejected as `hello frame must be the first frame`.
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
- `src/config.ts` — `AppConfig` / `getAppConfig` (environment parsing, `JARVIS_*` / `LLM_*`); `RateLimitConfig` + `DEFAULT_RATE_LIMIT_CONFIG` live here (not `http/`) — `getAppConfig`'s `numberOr` fallbacks reuse the constant's fields, so the defaults have one home (#107 P4); `apiContractVerify` (`JARVIS_API_CONTRACT=verify`) toggles REST response verification; `corsOrigins` (`JARVIS_CORS_ORIGINS`, normalized via `normalizeOrigin`) and `trustProxyCidrs` (`JARVIS_TRUST_PROXY_CIDRS`) hold the cross-origin posture; `defaultWebDir`.
- `src/logger.ts` — shared `@lukestanbery/jarvis-logger` instance (tag `server`).
- `src/listener.ts` — `createJarvisServer`: HTTP(S) server construction, in-node TLS / cert reads, half-set-TLS guard, bind + `listen`, and the cleartext redirect listener (`PORT + 1`, `JARVIS_HTTP_REDIRECT_PORT`).
- `src/app.ts` — `createApp(store, appConfig)`: Express app + JSON error handler, `/health`, mounts `/api`, the
  portal static serving + SPA fallback capped with a strict CSP (only when `portalDir` holds `index.html`), and
  (when `webDir` holds `index.html`) the app mount at `/` with a widened CSP + an SPA fallback that skips `/admin`;
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
- `src/http/authRoutes.ts` — the `/api` router (bootstrap, login, session, me, devices, users, sessions, prefs); every route body runs through one `route()` wrapper whose promise-chain `.catch` maps throws onto `handleError` (sync and async alike) (#107 P4).
- `src/http/cors.ts` — `createCorsMiddleware(origins?)`: the cross-origin policy (exact-origin allowlist, `Vary: Origin`, 204 preflight). Denies all cross-origin when the list is unset/empty; never emits `*`. Must stay mounted ahead of `express.json()` and the contract validator.
- `src/http/rateLimit.ts` — the credential throttle (`RateLimiter`): one in-memory instance shared by every credential endpoint, isolated by key namespace (`login:` / `bootstrap:`), fixed window + per-key lockout with exponential backoff. Counts attempts at admission (before scrypt) and clears a key on success. In-memory per process; trusts `req.ip` as-is. Not reusable as a quota — see the rate-limiting section of `README.md`.
- `@lukestanbery/jarvis-auth` (workspace dep) — app database + credential crypto (see its README): `openAppDatabase`
  (backed by `JARVIS_DB_PATH`, `~/.jarvis/jarvis.sqlite`) exposes `AppDatabase` as the intersection of three role
  interfaces — `UserLedger`/`DeviceLedger`/`SessionLedger`; `crypto.ts` (the primitives), `credential.ts` (the
  `CredentialVerifier` seam the REST layer codes against), `ownership.ts` (`ownsRow`/`canManage` — the one
  shared row-ownership policy), `errors.ts`, `types.ts`, `fs.ts`.
- `src/ws.ts` — the `/ws` endpoint: `hello` capability handshake + auth handshake + `location` device reports (#31) + prompt framing + the `cancel` frame (#84 P6). Its attach options are `ChatServerOptions` (renamed from `AttachmentOptions`, #107 P4), and one turn's forward is a `StreamEventsOptions` object with the spoken-audio pipeline factored into `startTurnAudio` — the old 13-positional-arg `streamEventsToSocket` is gone. The connection handler captures the peer address (`request.socket.remoteAddress`) once and forwards it as `StreamEventsOptions.clientIp`, the guest metering key `wikipedia` reads (#8); behind a reverse proxy that is the proxy's address, so the per-address guest bucket collapses toward global until the trusted-CIDR check lands (#63). The session lifecycle (claim, ownership
  guard, per-thread lock, touch, guest cleanup) lives in `src/sessionManager.ts`. Prompts referencing attachments (#10) require an authenticated socket and pre-turn id validation against the attachment store. A `cancel` never joins the frame tail (it would queue behind the turn it cancels): the message handler intercepts it and aborts the connection's `AbortController` — the signal rides into `runAgent` → `graph.stream` and from there into every metered tool's provider call (`runtime.signal` combined with each client's own timeout via `AbortSignal.any`; a cancelled turn rejects the in-flight fetch instead of draining to its timeout — #103), so signal-honoring model calls reject for real; the cancelled turn ends with a bare `done` (text streamed so far stays in history, never an error frame), the TTS queue drops, and the lock releases when the stream resolves. A cancel arriving while the prompt is still queued aborts at stream start (`cancelPending`); with no turn it is ignored. The audio **drain** races the turn signal: a cancel landing while the final segments synthesize drops the remaining audio instead of finishing it. Lifecycle hardening: `error` listeners on the `wss` and every socket (a malformed frame must never crash the process), a 30 s ping/pong heartbeat (half-open peers are terminated so their cleanup fires; injectable `heartbeatIntervalMs` for tests), and a 1 MiB send-buffer bound — non-terminal stream data (`chunk` frames, binary PCM) past it is dropped and counted, while one-shot and terminal frames always send. Frame logging is type-shaped: prompts via `logger.sensitive`, typed frames by `type` only — a raw-frame log would render device tokens and coordinates verbatim.
- `src/attachments/store.ts` — the transient attachment store (#10): ids, TTL, ownership, magic bytes; factory-created, injected (never built inside the agent graph).
- `src/attachments/limiters.ts` — attachment quotas (VL calls/min, held bytes, upload semaphore); NOT `RateLimiter` reuse.
- `src/agent.ts` — `runAgent` seam owning the LangGraph graph + checkpointer; `systemPromptForCapabilities` conditions the system prompt on the client's declared rendering capabilities (and, under `mode: "voice"` (#83), appends `VOICE_FORMAT_RULE` so the reply is spoken-word prose — no markdown, no parentheses, units spelled out; scoped per-turn, so text prompts on the same thread render richly again) and always appends seven fixed hygiene paragraphs (one well-formed tool call at a time; exactly one `getCurrentTime` call per time/date/weekday ask with the question passed verbatim so it returns the requested facet; attachment-lookups pass the exact id through to `analyzeImage`; discovery-first, re-search-before-claiming-absence, one-exact-id, never-guess discipline for `homeAssistant`; prefer a lookup tool such as `wikipedia`/`webSearch` over memory for facts and fast-changing topics; restraint with `sendNotification` — an interruption, not an answer; and scheduling discipline for `setTimer`/`remindMe`/`scheduleTask` — match the tool to what was asked, ask rather than guess a time, never build a timestamp, and cancel by exact id) so emulated tool calling doesn't fragment calls, reuse stale time answers, invent a device, turn the assistant into a nag, or let it promise a time it invented. `runAgent` stamps `sessionId` and `options.clientIp` into the graph's `configurable` (the guest metering keys `wikipedia` reads, #8) alongside the conditional `userId`/`location`; `RunAgentOptions.signal` (#84 P6) threads the caller's `AbortSignal` into the graph's runnable config, so a cancelled turn rejects the model's in-flight calls instead of draining best-effort.
- `src/transport.ts` — `AgentEvent → ServerFrame` mapping.
- `src/llm/agentGraph.ts` — model node + tools loop (streamed in `messages` mode, flattened to `AgentEvent`s).
- `src/llm/chatModel.ts` — the chat model: one of the two modules that know `@langchain/openai` (the other is `visionModel.ts`).
- `src/llm/visionModel.ts` — the vision-language model the `analyzeImage` tool calls (#10): non-streaming, bounded by an AbortSignal timeout, reasoning discarded.
- `src/llm/tools/search/` — the web-search providers (#9): Tavily + Serper fetch clients over the shared `requestJson` transport (#103) behind one normalized shape; keys are env secrets, never logged or in error text.
- `src/llm/tools/webSearch.ts` — the `webSearch` tool: Tavily-first routing (free quota) with Serper fallback, per-user call quota checked before any fetch, and the turn's `AbortSignal` threaded into the provider call (#103). Registered only when a provider key is configured.
- `src/llm/tools/http.ts` — the shared provider transport (#103): `requestJson` combines the caller's signal with the configured timeout (`AbortSignal.any` — never `signal ?? timeout`, which dropped the timeout for cancelled turns), maps transport/HTTP/JSON failures through per-client `mapFailure` hooks (typed errors keep their exact messages; the original error chains as `cause`), and owns the defensive `asString`/`asNumber` coercers.
- `src/llm/tools/metering.ts` — the shared owner-guard + quota-refusal scaffold (#103): `requireMeteredUser` refuses guest sockets and exhausted per-user quotas with model-facing text (never throws); `requireSignedInUser` is the same identity check alone, for a tool whose bound is not a call quota (`sendNotification`, #139 — the notification service caps interruptions and rows downstream), so a fifth tool refuses a guest in the identical wording rather than in a second phrasing of it; `requireMeteredCaller` is the guest-admitting variant (#8) that charges a verified `userId` to the per-user budget but admits a guest only when BOTH a strict per-`sessionId` bucket and an aggregate per-`clientIp` bucket admit (so a fresh socket cannot reset the budget), refusing an unkeyed guest; `retryAfterText` renders the "try again in about Ns" clause.
- `src/llm/tools/weather/` — the OpenWeather provider (#31): normalized current/forecast shapes, defensive parsing (absent phenomena → undefined), forecast steps folded into days by LOCAL date. Keys are env secrets, never logged or in error text.
- `src/llm/tools/getWeather.ts` — the `getWeather` tool: { location?, scope? }; location falls through model argument → device coordinates (the socket's latest `location` frame via `configurable.location`) → "ask the user which city". Per-user call quota checked before any fetch. Registered only when `OPENWEATHER_API_KEY` is configured.
- `src/llm/tools/homeAssistant/` — the Home Assistant REST client (#15): `GET /api/states` filtered to `JARVIS_HA_READ_DOMAINS` and cached for `JARVIS_HA_CACHE_TTL_MS` (in-flight requests collapse; failures are never cached), `POST /api/services/<domain>/<service>` for writes, which **discards the response body** (its states are dispatch-time, never the outcome) and drops the snapshot — a 2xx alone is the acceptance signal, so `ignoreBody` keeps a proxy-rewritten body from turning a successful write into a failure. `types.ts` is the tool↔client seam; the token is a `Bearer` header only — never in a URL, a log, or error text.
- `src/llm/tools/homeAssistant.ts` — the `homeAssistant` tool: one tool, `{ action, entity_id?, query?, value? }` over `list`/`lights`/`switches`/`get`/`turn_on`/`turn_off`/`toggle`/`set_brightness`/`set_temperature`. The two discovery actions carry the category REST does not — `lights` is the `light`/`switch` domains plus a `JARVIS_HA_LIGHT_TOKENS` fragment in the id or name (a light is a `switch.*` on many instances), `switches` is the `switch` domain minus `_led` shadow children — and every read states how many of the readable entities it matched. Per-user quota checked before any fetch; every write resolves `entity_id` against the live snapshot and is checked against `JARVIS_HA_CONTROL_DOMAINS` (a strict subset of the read domains — locks/covers stay read-only), the action's required domain, and the entity's own state (`unavailable`/`unknown` refuses) before any HTTP. Writes report the **accepted action**, never a state — the model is told to call `get` for current state. Registered only when `HOME_ASSISTANT_URL` and `HOME_ASSISTANT_ACCESS_TOKEN` are both configured.
- `src/rate/fixedWindowQuota.ts` — the generic fixed-window quota (VL calls, search calls, weather calls, Home Assistant calls, and Wikipedia's per-user + two guest buckets); the key type defaults to `number` (the verified `userId`) but is generic, so `wikipedia` (#8) keys its guest budgets on namespaced strings (`"session:<id>"` / `"address:<ip>"`). `VlCallLimiter` is its domain-named alias.
- `src/scheduler/` — fire-at-T jobs (#90). `create.ts` (#90 phase 5) is the **one creation policy**: the bounds a label/message/moment must satisfy, the per-user cap on pending rows, the quiet-hours forecast, the edit, and the snooze (move a pending reminder, re-create a settled one) — shared by the tools and the REST surface, so the model's door and a page's door cannot answer differently, and each renders the outcomes for its own reader. `tools.ts` is the explicit `SCHEDULABLE_TOOLS` allowlist plus `resolveSchedulableTool` (checked at creation and again at fire time, because a stored tool call is a durable capability chosen by the model and executed later with nobody watching); `analyzeImage` is out because it needs a live conversation, and `sendNotification` is out because it _is_ the announcement mechanism — the runner already announces every run, and the first smoke test showed a scheduled notification job announcing twice; `runner.ts` (`createJobRunner`) owns one job's whole life — claim, execute, run row, settle, exactly one notification (`job.finished`/`job.failed`/`job.missed`), whose fate the log states at the default level when it was recorded but not pushed — with `prompt` jobs running `runAgent` on a `job:<id>` thread that never claims a ledger row (a job's runs are not conversations), `tool` jobs invoking the tool directly with the runtime a graph turn would have stamped, and `message` jobs running nothing at all (their text is the payload, delivered by the announcement — a reminder or timer with no model and no tool); the job's `class` rides along to that announcement unchanged, so the thing the user scheduled decides quiet hours rather than the runner, and a `reminder` that lands inside them is not run at all — `deferralFor` moves its `run_at` to the window's end (`quietHoursEnd` in `notify/prefs.ts`) with no run row and no attempt, reading the window live rather than from a copy on the job (so a changed window changes the decision, an extension re-defers, and clearing it does not bring the job forward); `loop.ts` (`createScheduler`) owns the coarse tick, the per-tick bound, the overlap refusal, and boot recovery (a `running` row at boot was left by a process that died — a claim lives in memory — so `start()` fails it and says so). Creation is `llm/tools/jobs.ts` (the model's tools) and `http.ts` (`createJobRouter` — `/api/jobs` CRUD plus run history, mounted only when the scheduler is wired), both over `create.ts`; the row shape itself is owned by the auth README.
- `src/keyedLock.ts` — `createKeyedLock()`, the per-key exclusion set two callers share: `sessionManager.ts` (keyed on the chat thread) and the scheduler's runner (keyed `job:<id>`). One implementation instead of two drifting `Set`s; the keyspaces are disjoint by construction, so a job can never cross-block a conversation.
- `src/llm/tools/wikipedia.ts` — the `wikipedia` tool (#8): `{ query, detail? }` (`"summary"` default, `"full"`). Runs the caller gate (per-user quota, or the dual guest buckets) before any fetch, threads `runtime.signal`, and rethrows aborts via `throwIfAborted`; `formatWikipediaLookup` (pure/exported) renders the article + URL (+ a truncation note for `full`), the disambiguation candidate list, or a no-match. Registered by default (no credential) unless `JARVIS_WIKIPEDIA=off`.
- `src/llm/tools/wikipedia/` — the MediaWiki Action API client (#8): `types.ts` is the tool↔client seam (`WikipediaArticle`/`WikipediaCandidates`/`WikipediaNoMatch`/`WikipediaProvider`/`WikipediaError`); `client.ts` (`createWikipediaClient`) makes ONE `generator=search` request over the shared `requestJson` transport (#103) to resolve title + extract — a summary adds `exintro`+`exsentences` (clamped to the API max 10), `full` omits them and slices the unbounded plain text to `maxFullChars`, a disambiguation page or empty extract falls back to a `list=search` candidate request (which excludes the rejected page itself — it usually ranks first, and it is by definition not an answer — so one extra result is requested), and no results is a `no-match` value not an error. The required `User-Agent` is Wikimedia policy (empty → 403).
- `src/tts/` — server-side TTS (#83): `types.ts` is the `TtsProvider` seam (text → mono float PCM + rate, cooperative `AbortSignal`), `kokoro.ts` is the engine (kokoro-js, lazy dynamic import — the optional deps are `kokoro-js` + `@huggingface/transformers`, ambient-typed in `kokoro-modules.d.ts` because node10 resolution can't see their `exports` types), `segmenter.ts` + `orchestrator.ts` are the turn pipeline (tokens → segments → one sequential synthesis worker → ordered audio). Segmenter granularity (#89, `JARVIS_TTS_SEGMENT=sentence|clause`, default `sentence`): clause mode additionally splits at commas/semicolons (≥ `minClauseChars`, digit-guarded) so the first PCM lands earlier, trading prosody for latency. `speakTurn` takes optional `{ granularity, onFirstSegment }` — `ws.ts` uses the callback plus its own timestamps to log the per-turn TTFA decomposition at debug (`first token / first segment / first audio sent`). Wired into `/ws` for voice-mode turns from `audio`-capable sockets: `audioStart` → binary s16le PCM → `audioEnd`, all before `done`, gated by `JARVIS_TTS_PROVIDER`; speakability is prompt-side (`agent.ts` `VOICE_FORMAT_RULE` — the model writes spoken-word prose for voice turns; incidental markup reads as written, no deterministic say-proofing pass). Synthesis failure never disturbs the text stream (no `audioError` frame yet). Weights cache privately under `~/.jarvis/tts`; missing optional install = unavailable TTS, never a boot failure. `scripts/tts-harness.ts` (`npm run tts:harness`) is the manual text → WAV → playback tool.
- `src/modelFileCache.ts` — the shared download-once model-serving machinery (#107 P3): `ModelFileCache` (lazy first fetch, per-key in-flight collapse, streamed temp-file-then-rename write, `DEFAULT_DOWNLOAD_TIMEOUT_MS` fetch timeout, retry on the next request) plus `createModelFileHandler` (200 with `Content-Type` + `Cache-Control: public, max-age=86400`; JSON 404 unconfigured/unknown; JSON 503 while an upstream fetch fails; optional `HEAD` 200 capability probe). The STT and wake modules are thin `ModelFileSpec` adapters over it — their route behavior lives here now.
- `src/stt/` — local STT model serving (#84 P3b): `model.ts` is the thin STT spec over `modelFileCache.ts` (`SttModelCache` — single archive key, cached file name derived + sanitized from `JARVIS_STT_MODEL_URL`) plus `createSttModelHandler` for `GET /api/stt/model` (200 `application/gzip`; JSON 404 unconfigured; JSON 503 while an upstream fetch fails). Gated by `JARVIS_STT_PROVIDER=vosk`; the archive caches privately under `~/.jarvis/stt` (`JARVIS_STT_MODEL_DIR`). The route is public by design (open-source weights, not user data; the recognition worker cannot attach auth headers) and mounts after the contract validator so it stays contract-checked (`sttModelGet` in the OpenAPI spec).
- `src/wake/` — wake-word model serving (#84 P4): `model.ts` is the thin wake spec over `modelFileCache.ts` (the `WAKE_MODEL_FILES` three-file allowlist + `isWakeModelFile`, `WakeModelCache` — per-file keys — and `createWakeModelHandler` for `GET|HEAD /api/wake/model/:file`: 200 `application/octet-stream` + `Cache-Control: public, max-age=86400`; JSON 404 unconfigured/unknown; JSON 503 while an upstream fetch fails; `HEAD` 200 probe downloads nothing). Gated by `JARVIS_WAKE_PROVIDER=openwakeword`; models cache privately under `~/.jarvis/wake` (`JARVIS_WAKE_MODEL_DIR`) fetched from the openWakeWord release host (`JARVIS_WAKE_MODEL_URL`). Public by design (open-source weights, no auth headers on the browser side) and mounts after the contract validator (`wakeModelGet`/`wakeModelHead` in the OpenAPI spec).
- `src/llm/tools/` — the tool implementations; `analyzeImage.ts` resolves attachment ids and enforces ownership via `ToolRuntime.configurable`. Optional tools (`webSearch`, `getWeather`, `homeAssistant`) register only when their credentials are configured and each gates on the verified `ToolRuntime.configurable.userId`; `wikipedia` (#8) has no credential, so it registers by default (unless `JARVIS_WIKIPEDIA=off`) and is the one tool that also admits guests, metering them through a per-`sessionId` bucket and an aggregate per-peer-address bucket (`requireMeteredCaller`); `notify.ts` (#139) registers whenever the notification surface is wired and refuses guests through `requireSignedInUser` — the same sign-in wording, without a call quota, because what it consumes is already capped downstream; `jobs.ts` (#90 phase 3) registers whenever the scheduler runs and is the only tool group that writes rows rather than reading the world — its six tools (`setTimer`/`remindMe`/`scheduleTask`/`listJobs`/`cancelJob`/`snoozeReminder`) each own their job's `class`, so the model cannot choose how loudly the user is interrupted. Every metered tool threads the turn's `runtime.signal` into its provider calls and rethrows aborts in its catches (`throwIfAborted` — a cancelled turn rejects down the bare-done path rather than answering failure text) — #103.
- `src/llm/tools/notify.ts` — the `sendNotification` tool (#139): the notification channel's first real producer and the agent's half of it. It holds no policy — the call goes through `src/notify/service.ts`, so the user's switch, quiet hours, presence, and the delivery budget keep one home — and returns a short model-facing string per outcome, exhaustive over `NotificationSuppression` (`formatNotifyOutcome`, pure/exported), so the model reports where a notification actually is instead of claiming an interruption that never happened. `requiresAnswer` is deliberately not exposed (nothing consumes an answer yet; that round-trip is #94) and the `kind` is fixed (`agent.request`) because a model-invented category would make grouping, filtering, and future per-category preferences meaningless. It also does not expose a notification _class_ (#90): the class decides whether quiet hours may hold a notification back, so a model choosing one would be a way to pierce them — which is why `priority` no longer does either (it is display emphasis now, and this tool's notifications wait for the window to end). The matching hygiene paragraph in `agent.ts` pins restraint rather than use: an assistant that notifies on every turn teaches the user to ignore notifications.
- `src/llm/tools/jobs.ts` — the six scheduling tools (#90 phase 3): `setTimer` (class `timer`, `minutes` or `seconds`), `remindMe` (class `reminder`, `at`/`onDate`/`inMinutes`), `scheduleTask` (class `notification`, one allowlisted tool call), `listJobs`, `cancelJob`, `snoozeReminder` (moves a pending reminder through the ledger's user-scoped `moveJob`, re-creates a settled one with the same payload, and refuses a running, cancelled, or non-reminder job). The class comes from which tool was called (no schema exposes `class` or `priority` — either would be a way to pierce quiet hours), `scheduler/time.ts` resolves the time from words rather than timestamps, and `scheduler/tools.ts` plus the target tool's own schema decide whether a task is runnable — checked at creation so a refusal reaches the user instead of failing at the due moment. **Creation and snooze policy is not here** (#90 phase 5): the bounds (the per-user cap on pending rows, the horizon, the title/body lengths, the timer's day ceiling) and the quiet-hours prediction live in `scheduler/create.ts`, which the REST surface uses too, so the two doors cannot answer differently; this file renders those outcomes in the model's voice. Every refusal is returned text, never a throw.
- `test/` — Vitest test suites under `test/*.test.ts` (39 suites total: app, ws, agent, http, sessionManager, contract, attachments, config, stt.model, wake.model, modelFileCache, scheduler, jobTime, jobs.tool, tts.orchestrator, wikipedia.client, wikipedia.tool, homeAssistant._, limits, auth._, user._, session._, device._, prefs._, etc.).

`src/ws.ts` and `src/scheduler/runner.ts` are the two modules that run a turn through the agent seam (sockets
and scheduled jobs respectively); exactly two modules know `@langchain/openai`
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
