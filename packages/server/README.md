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

### Docker

The repository root ships a production image and a compose file:

```sh
docker compose up -d --build
curl http://localhost:54321/health        # -> {"ok":true}
```

The image builds only the five packages the server loads at runtime —
`protocol`, `logger`, `auth`, `contracts`, and `server` — and ships no
compilers or dev dependencies. It runs as non-root uid `10001` with a
`HEALTHCHECK` against `/health`. Clients (#29) are separate deployments.

Four things are worth knowing:

- **`LLM_BASE_URL` must not stay `localhost`.** Inside a container `localhost`
  is the container, not your machine, so the default `http://localhost:1234/v1`
  cannot reach a host-side LM Studio. Compose sets
  `http://host.docker.internal:1234/v1` for you; override it for any other
  OpenAI-compatible endpoint.
- **State is a named volume.** `jarvis-data` mounts at
  `/home/jarvis/.jarvis`, and because the image sets `HOME` the defaults for
  `JARVIS_DB_PATH` and `JARVIS_CHECKPOINT_PATH` resolve inside it. Both SQLite
  files survive `docker compose down && up`.
- **Bootstrap is off by default.** Set `JARVIS_BOOTSTRAP_TOKEN` (in a `.env`
  beside the compose file, or as an environment variable at `up` time) before
  calling `POST /api/bootstrap`; until then it returns `409`.
- **No SPAs are baked in.** `/` answers `Hello World` and `/web` is unmounted.
  To serve them, build them on the host and mount the directories — see below.

#### Serving the SPAs from the image

Build the SPA bundles on the host (they are not in the image), then mount them
and point the server at the mount points:

```sh
npm run build -w @lukestanbery/jarvis-portal -w @lukestanbery/jarvis-web
```

```yaml
volumes:
    - ./packages/portal/dist:/srv/portal:ro
    - ./packages/web/dist:/srv/web:ro
environment:
    JARVIS_PORTAL_DIR: /srv/portal
    JARVIS_WEB_DIR: /srv/web
```

A directory is mounted only when it contains `index.html`, so a wrong path
degrades to `Hello World` and a warning rather than failing to boot.

#### Container environment reference

Everything in the configuration table below applies unchanged inside the
container, with two differences:

| Variable                                   | In the container                                          |
| ------------------------------------------ | --------------------------------------------------------- |
| `LLM_BASE_URL`                             | Must point off-container (`host.docker.internal:1234/v1`) |
| `JARVIS_DB_PATH`, `JARVIS_CHECKPOINT_PATH` | Default to `/home/jarvis/.jarvis`, on the volume          |

### Configuration

The model is reached via LangChain (`@langchain/openai`) pointed at an
OpenAI-compatible endpoint. Everything is configurable through environment
variables:

| `PORT` | `54321` | HTTP listener port |
| `LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible base URL |
| `LLM_MODEL` | `qwen/qwen3-4b-2507` | Model served by the server |
| `LLM_TEMPERATURE` | `0` | Sampling temperature |
| `LLM_SYSTEM_PROMPT` | `You are J.A.R.V.I.S., a helpful, personal AI assistant. ...` (concise persona) | System message priming every conversation thread; the server always appends two fixed hygiene paragraphs (one tool call at a time with well-formed arguments; exactly one `getCurrentTime` call per time/date/weekday ask, passing the question verbatim, never reusing an earlier answer) plus capability notes — see the Chat protocol section (the image-analysis rule is a third) |
| `JARVIS_AGENT_MAX_TURNS` | `10` | Max agent loop steps per turn (tools + model calls) |
| `JARVIS_CHECKPOINT_PATH` | `~/.jarvis/checkpoints.sqlite` | SQLite checkpoint file for conversation persistence |
| `JARVIS_DB_PATH` | `~/.jarvis/jarvis.sqlite` | App database: users, devices, sessions, prefs |
| `JARVIS_TURN_TIMEOUT_MS` | `120000` | Hard cap for one agent turn before it is aborted |
| `LLM_VL_MODEL` | `qwen3.6-35b-a3b-splash` | Vision-language model the `analyzeImage` tool calls (must accept `image_url` parts) |
| `LLM_VL_MAX_TOKENS` | `1024` | Output-token cap for one image analysis |
| `LLM_VL_TIMEOUT_MS` | `60000` | Wall-clock cap for one image analysis (abort bound) |
| `JARVIS_ATTACHMENT_TTL_MINUTES` | `60` | How long an uploaded image stays analyzable |
| `JARVIS_ATTACHMENT_MAX_BYTES` | `4194304` (4 MiB) | Decoded-byte cap per attachment |
| `JARVIS_ATTACHMENT_MAX_TOTAL_BYTES` | `209715200` (200 MiB) | Per-user total across live attachments |
| `JARVIS_ATTACHMENT_VL_CALLS_PER_MIN` | `10` | Vision-analysis calls per user per minute |
| `JARVIS_ATTACHMENT_MAX_INFLIGHT` | `4` | Concurrent uploads server-wide |
| `JARVIS_ATTACHMENT_DIR` | `<tmpdir>/jarvis-attachments` | Attachment root (mode-verified private; emptied at boot) |
| `JARVIS_BOOTSTRAP_TOKEN` | unset | One-time setup credential; see the `@lukestanbery/jarvis-auth` README |
| `JARVIS_HOST` | `0.0.0.0` | Bind address (all interfaces = LAN posture) |
| `JARVIS_TLS_CERT` | unset | PEM certificate path — enables HTTPS serving |
| `JARVIS_TLS_KEY` | unset | Matching PEM private key (required with `JARVIS_TLS_CERT`) |
| `JARVIS_HTTP_REDIRECT_PORT`| `PORT + 1` | Cleartext port that upgrades to HTTPS (TLS mode) |
| `JARVIS_PORTAL_DIR` | `packages/portal/dist` | Built portal SPA root served at `/`; empty string disables it |
| `JARVIS_WEB_DIR` | `packages/web/dist` | Built web chat client root served at `/web`; empty string disables it |
| `JARVIS_RATE_WINDOW_MS` | `900000` (15 min) | Attempt-accumulation window for login/bootstrap |
| `JARVIS_RATE_MAX_FAILURES` | `10` | Attempts per `(ip, username)` before a lockout |
| `JARVIS_RATE_MAX_IP_FAILURES` | `100` | **Currently inert** — parsed but never read; see the known gap below |
| `JARVIS_RATE_LOCKOUT_MS` | `60000` | Base lockout; doubles per repeat (backoff, ×32 cap) |
| `JARVIS_CORS_ORIGINS` | unset (deny all cross-origin) | Comma-separated exact origins allowed to call `/api` cross-origin; no wildcard |
| `JARVIS_TRUST_PROXY_CIDRS` | unset (trust none) | IPs/subnets whose `X-Forwarded-For` is believed for `req.ip` |
| `JARVIS_SESSION_TTL_MS` | `2592000000` (30 days) | Absolute lifetime of a cookie session (no sliding) |
| `JARVIS_API_CONTRACT` | unset | Set `verify` to also validate REST response bodies against the OpenAPI contract (request shapes are always validated) |
| `JARVIS_LOG_LEVEL` | `info` (`silent` under tests) | Log verbosity: `silent` \| `debug` \| `info` \| `warn` \| `error` |
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
can't be probed. Both login and bootstrap are throttled — see
[Rate limiting](#rate-limiting) for the keys, budgets, and lockout behavior.

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

### Cross-origin and reverse proxy

Most deployments never need this section. If the browser loads the SPAs **from this
server** (the default: `/` and `/web`) or through the Vite dev server's `/api` + `/ws`
proxy, every request is same-origin and the settings below do nothing. They matter
only when a SPA is served from a _different_ origin than the API (issue #63).

#### Allowing a cross-origin browser client

`JARVIS_CORS_ORIGINS` is a comma-separated list of **exact** origins. Unset or empty
**denies all cross-origin requests** — no `Access-Control-Allow-*` header is emitted,
so the browser blocks them and same-origin clients are untouched. Origins are matched
case-insensitively with a trailing `/` ignored, so `https://Desk.example.com/` and
`https://desk.example.com` are the same entry.

```sh
JARVIS_CORS_ORIGINS=https://desk.example.com,http://laptop.local:5173
```

There is deliberately **no wildcard**. The API is credentialed (bearer device token
_and_ session cookie), browsers reject `Access-Control-Allow-Origin: *` on credentialed
requests anyway, and honoring one would hand a credentialed API to any site the user
visits. A literal `*` in the list is dropped with a startup warning. An origin that is
not on the list gets no CORS header rather than a 403, so a refused request does not
confirm that the allowlist exists.

Preflight (`OPTIONS`) is answered with `204` **before** the OpenAPI contract validator,
which matters: the validator rejects `OPTIONS` against paths that declare only
`POST`/`GET`, so a preflight that reached it would fail instead of unlocking the real
request.

The `/ws` upgrade is unaffected — browsers do not gate WebSockets on `Origin`, and the
socket authenticates with its `auth` frame instead.

#### Cookie auth does not work cross-origin

This is a deliberate decision, not an omission. `setSessionCookie` emits
`SameSite=Strict`, which browsers never send on cross-site requests. The alternative,
`SameSite=None`, is **itself rejected by browsers without `Secure`** — and the default
posture is plain HTTP on a LAN, so enabling it would silently break cookie auth
everywhere rather than only cross-origin.

**Cross-origin browser clients must therefore authenticate with a device token**
(`Authorization: Bearer …`), which travels in a header and is unaffected by
SameSite. That is already how `packages/web` works (bearer token in `localStorage`, no
cookies, no CSRF). `packages/portal` authenticates with the cookie session
(`credentials: "same-origin"`) and therefore remains **same-origin only**; moving it
cross-origin would mean switching it to device tokens, not relaxing the cookie.

#### Behind a reverse proxy

`req.ip` is the socket address unless a proxy is trusted, so with a reverse proxy in
front every client shares one address — which collapses the credential throttle's
per-`(ip, username)` and per-`ip` keys into a single bucket (see
[Rate limiting](#rate-limiting)).

List the proxy's addresses to fix that:

```sh
JARVIS_TRUST_PROXY_CIDRS=172.16.0.0/12,10.0.0.5
```

Prefer a CIDR allowlist over a hop count or an unbounded trust: `X-Forwarded-For` is
client-controlled, so trusting it from anyone is a spoofing vector that would let a
caller forge a fresh rate-limit identity per request. Entries that fail to parse never
match, so a typo fails closed (trusting nothing) rather than open. Set this to the
Docker network's subnet when the proxy is a container.

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

## Rate limiting

Every throttle the server applies lives in this section — this is the single source of
truth. Two independent mechanisms exist, because they answer different questions and
must not be interchanged.

### Credential throttle — `src/http/rateLimit.ts`

Guards the expensive password-verification path against guessing.

There is exactly **one** `RateLimiter` instance, built from `appConfig.loginRateLimit`
and shared by every credential endpoint. Endpoints stay isolated by **key namespace**
(`login:` vs `bootstrap:`), not by separate limiters or configs.

| Endpoint                                    | Key                     | Budget                                                                  |
| ------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `POST /api/auth/login`, `POST /api/session` | `login:<ip>:<username>` | `JARVIS_RATE_MAX_FAILURES` (10) per window                              |
| `POST /api/auth/login`, `POST /api/session` | `login:<ip>`            | `JARVIS_RATE_MAX_FAILURES` (10) per window — aggregate across usernames |
| `POST /api/bootstrap`                       | `bootstrap:<ip>`        | `JARVIS_RATE_MAX_FAILURES` (10) per window                              |

Login admits **both** keys on every attempt
(`limiter.admit(userKey) ?? limiter.admit(ipKey)`), so a request must clear the
per-username budget _and_ the per-IP aggregate budget.

Behavior:

- **Fixed window.** Attempts accumulate over `JARVIS_RATE_WINDOW_MS` (15 min) and the
  counter resets when the window lapses, so a client that stops misbehaving recovers on
  its own.
- **Every attempt counts, right or wrong.** `admit()` increments _before_ the expensive
  scrypt verify runs. Node's single thread serializes the increment, so a burst of
  concurrent guesses cannot all observe a pre-limit count while their verifications are
  still in flight.
- **Success clears the key.** `recordSuccess()` deletes the entry, so a legitimate user
  is never punished for repeated correct logins.
- **Lockout backs off.** Crossing the budget locks the key for
  `JARVIS_RATE_LOCKOUT_MS` (60 s), doubling (×2, ×4, …) on each repeat up to ×32, and
  resets the counter to zero for the next window.
- Refusals are `429` with `too many attempts; try again later`.

#### Known gap: `JARVIS_RATE_MAX_IP_FAILURES` is dead config

`RateLimitConfig.maxIpFailures` is parsed from the environment and defaulted to `100`,
but `RateLimiter.admit()` never reads it — it compares every key against `maxFailures`
only. The per-IP aggregate budget is therefore **`maxFailures` (10)**, not 100, on both
the login and bootstrap paths.

Consequences:

- `JARVIS_RATE_MAX_IP_FAILURES` has no effect. Changing it is a no-op.
- The per-IP cap is 10× tighter than documented, so **any IP that produces 10 failed
  attempts in 15 minutes is locked out entirely** — including a whole household or
  office behind one NAT address, where unrelated users lock each other out.

Tracked in [#66](https://github.com/LukeStanbery89/jarvis-v2/issues/66). The table above
documents the behavior that exists today, not the intent.

### Not rate limited

Worth stating explicitly, because these are the surfaces that cost real CPU:

| Surface                                                        | Bounded by                                                                                                                            | Not bounded by                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/ws` chat turns                                               | concurrency only — a per-thread lock (one turn per `sessionId`), one streaming turn per socket, and `JARVIS_TURN_TIMEOUT_MS` per turn | **prompt frequency** — a socket can submit turns back-to-back indefinitely |
| REST resources (`/api/users`, `/api/devices`, `/api/prefs`, …) | authentication and ownership checks                                                                                                   | any request-rate ceiling                                                   |

The `/ws` gap is tracked in [#65](https://github.com/LukeStanbery89/jarvis-v2/issues/65).
Guest sockets (a `/ws` socket that sends a prompt without an `auth` frame) are
unauthenticated and therefore the most exposed.

### Scope and caveats

- **State is in-memory only**, per process. The server is single-instance by design, so
  this is adequate for the LAN posture; a process restart simply resets every counter.
  There is no distributed or persisted state.
- **The credential throttle trusts `req.ip` as-is.** Behind a reverse proxy every request
  appears to originate from the proxy, which collapses the per-`ip` budget into a
  **global** lockout — one attacker locks out everyone. Set
  `app.set("trust proxy", …)` when fronting the server with a proxy. Tracked in
  [#63](https://github.com/LukeStanbery89/jarvis-v2/issues/63).
- **Prefer identity keys for new limiters.** Any throttle added later should key on the
  resolved user identity rather than `req.ip`, so it is correct behind a proxy by
  construction.
- `RateLimiter` is deliberately **not** reused for quotas. Its `admit()` increments on
  every call and `recordSuccess()` deletes the key, so a success-and-release cycle
  counts against the budget — wrong semantics for "N per minute" or "N bytes held".

## Image analysis

Chat prompts can reference uploaded images (#10). The chat model is text-only;
it answers image questions by delegating to a vision-language (VL) model
through the `analyzeImage` tool — the analysis text is all that reaches the
conversation, never the image bytes.

```
 web composer                        server                            LM Studio
 ────────────                        ──────                            ─────────
 📎 / paste / drag-drop
   downscale if over budget ────────▶ POST /api/attachments
   (pure policy + canvas adapter)      requireAuth + requireCsrf
                                       magic-byte sniff, byte caps
                                       ◀── 201 { attachmentId }
 prompt { attachments: [id] } ──────▶ ws.ts: auth required for image prompts;
                                       ids validated BEFORE the turn claims
                                       the thread (unknown/expired/foreign
                                       → immediate error frame)
                                       └─▶ model sees [attachments: …] and
                                            calls analyzeImage ──────────▶ VL model
                                            ◀── analysis text ────────────  (non-streaming)
                                       ◀── chunk … done
```

What the surface guarantees:

- **Authentication is required end to end.** Guests cannot upload, and a
  prompt carrying attachment ids on a guest socket is refused _before_ the
  session ledger row is claimed. The VL-call quota, byte budgets, and
  ownership checks all key on the authenticated `user.id`.
- **Bytes are transient by design.** Uploads live under
  `<tmpdir>/jarvis-attachments` (private-mode verified at use — a
  group/other-accessible root fails startup of the store loudly), expire
  after `JARVIS_ATTACHMENT_TTL_MINUTES`, and are swept at boot (files from a
  previous process are orphans nothing can resolve) and after each upload.
  Transcripts keep only the ids — a reloaded thread shows "image not
  retained" rather than a preview.
- **Quotas are not rate limiting.** The VL-call limiter (per user, per
  minute), the per-user byte ledger, and the upload semaphore are quota
  mechanisms with different semantics than the credential throttle — see
  [Rate limiting](#rate-limiting) for the distinction and why
  `RateLimiter` is deliberately not reused here.
- **Uploads are validated by content, not declaration.** The store sniffs
  magic bytes (PNG/JPEG/GIF/WebP); a declared mime is never trusted, so
  crafted non-image bytes are refused with 403 before any storage.
- **The VL runtime must accept images.** `LLM_VL_MODEL` must name a model on
  the same endpoint that accepts OpenAI `image_url` content parts. The server
  verifies reachability at startup when configured; note that LM Studio
  builds differ in which formats their ingest accepts (the current build
  rejects WebP — the web client therefore re-encodes PNG sources as PNG and
  photos as JPEG).
- **Reasoning never leaks.** The default VL model is a reasoning model; its
  chain-of-thought is discarded and only the final analysis returns.

The web chat client implements the upload flow (📎, paste, drag-and-drop,
`data:` previews, one stricter-budget retry on a 413). The protocol and the
store are client-agnostic — a CLI or camera client can reference attachments
without touching the wire shape; non-browser clients cannot downscale, so
they must stay under the per-attachment cap themselves (hard-rejected above
it).

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
| `GET`    | `/`                        | none                                | Health-check, returns `Hello World` (or the built portal SPA)                            |
| `GET`    | `/web`                     | none                                | Built web chat client SPA (301s to `/web/`, then serves `index.html`)                    |
| `WS`     | `/ws`                      | optional device token (first frame) | Chat endpoint (WebSocket)                                                                |
| `POST`   | `/api/bootstrap`           | `x-bootstrap-token` header          | Create the first (owner) account + device token                                          |
| `POST`   | `/api/auth/login`          | none                                | Username + password → a (rotating) device token                                          |
| `POST`   | `/api/attachments`         | device token or web session         | Upload a base64 image → `{ attachmentId }` for an image-analysis prompt (transient, TTL) |
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
    - **Optional, first frame only:** `{ "hello": true, "capabilities": ["markdown", "image", "link"] }` (shape
      `{ "type": "hello", "capabilities": [...] }`) — the client announces how it renders responses. Each token is
      one of `markdown` / `html` / `image` / `link` (duplicates and unknown tokens are rejected; the list may be
      empty). This affects the agent's system prompt: the model is told the client renders Markdown/images/links
      (or that it only shows plain text). Regardless of capabilities, the server always appends two fixed
      hygiene paragraphs to the system prompt — make exactly one tool call at a time with every required
      argument as well-formed JSON and wait for each result (emulated tool calling in local models otherwise
      fragments calls into empty-arg or misnamed invocations), and make exactly one `getCurrentTime` call per
      time/date/weekday ask, passing the user's question verbatim so the tool returns just the requested facet,
      never reusing a value answered earlier (small local models otherwise reuse a stale timestamp from the
      conversation history or over-report facets that weren't asked for). Since the image-analysis surface (#10),
      a third fixed paragraph pins how to answer attachment-carrying prompts: call `analyzeImage` with the exact id
      from the message's `[attachments: …]` list and answer from the tool's description, never by guessing. Must be
      the very first frame.
    - **First frame (or immediately after `hello`), optional:** `{ "type": "auth", "token": "<device token>" }`
      — authenticates as an account. The server replies with one
      `{ "authResult": { "user": "<name>", "device": "<name>" } }` frame. Never
      authenticate → the socket is a **guest** (ephemeral, identity-independent
      chats).
    - `{ "prompt": "<your prompt>", "sessionId": "<id>", "mode": "text"|"voice", "attachments": ["<id>"] }` —
      the `sessionId` names the conversation thread. Reuse it to continue an earlier
      conversation (bounded to 128 characters); each distinct id is isolated.
      The optional `mode` (default `"text"`) picks the chat style: text prompts
      are answered using the client's declared capabilities, while voice prompts
      always yield plain conversational text. The mode is recorded as the
      session's `kind` when the thread is first claimed (write-once).
      A `hello` or `auth` frame arriving after this is rejected.
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
**session** tagged `guest`/`owned` and `text`/`voice` (the kind is the
prompt's chat `mode`, recorded at first claim). Guest sessions are
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
conversations. That checkpoint file is a separate database from the auth app
database (`JARVIS_DB_PATH`); the server depends on `better-sqlite3` directly to
open it, while account state is reached only through `@lukestanbery/jarvis-auth`.
Try it with the `@lukestanbery/jarvis-cli` REPL.
