# @lukestanbery/jarvis-server

Express backend server for the J.A.R.V.I.S. AI assistant. Accepts prompt messages over
WebSocket and streams a response back to the client.

## Prerequisites

- Node.js 24+
- npm
- A running OpenAI-compatible inference server. [LM Studio](https://lmstudio.ai) is the
  default — launch it, load a model, and start its local server on port `1234`.

## Install

```sh
npm install @lukestanbery/jarvis-server
```

## Scripts

| Script                | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `npm run build`       | Compile TypeScript to `dist/`                              |
| `npm run typecheck`   | Type-check src and tests (no emit)                         |
| `npm run dev`         | Run the server with watch mode                             |
| `npm start`           | Run the compiled server                                    |
| `npm test`            | Run the test suite (Vitest)                                |
| `npm run tts:harness` | Local TTS harness: synthesize text and play it aloud (#83) |

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
variables; a variable that is set but does not parse (a typo, trailing
whitespace) falls back to its documented default with a startup warning
naming the variable — a typo can never break the server start, and it cannot
fail silently either:

| Variable                                 | Default                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                   | `54321`                                                                         | HTTP listener port                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_NOTIFY`                          | (unset)                                                                         | `off` removes the notification surface entirely (#139) — no `/api/notifications` routes and no delivery wiring                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_NOTIFY_DELIVERIES_PER_MIN`       | `20`                                                                            | Pushes allowed per user per minute; over budget a notification is still recorded and listed, just not pushed                                                                                                                                                                                                                                                                                                                                         |
| `JARVIS_NOTIFY_MAX_PER_USER`             | `200`                                                                           | Notifications kept per user; settled rows are evicted first, then the oldest survivor, so the ceiling holds for the table                                                                                                                                                                                                                                                                                                                            |
| `LLM_BASE_URL`                           | `http://localhost:1234/v1`                                                      | OpenAI-compatible base URL                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LLM_MODEL`                              | `qwen/qwen3-4b-2507`                                                            | Model served by the server                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LLM_TEMPERATURE`                        | `0.15`                                                                          | Sampling temperature                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LLM_SYSTEM_PROMPT`                      | `You are J.A.R.V.I.S., a helpful, personal AI assistant. ...` (concise persona) | System message priming every conversation thread; the server always appends five fixed hygiene paragraphs (one tool call at a time with well-formed arguments; exactly one `getCurrentTime` call per time/date/weekday ask, passing the question verbatim, never reusing an earlier answer; the image-analysis rule; the home-assistant rule; and the tools-over-memory rule for research, #8) plus capability notes — see the Chat protocol section |
| `JARVIS_AGENT_MAX_TURNS`                 | `10`                                                                            | Max agent loop steps per turn (tools + model calls)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_CHECKPOINT_PATH`                 | `~/.jarvis/checkpoints.sqlite`                                                  | SQLite checkpoint file for conversation persistence                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_DB_PATH`                         | `~/.jarvis/jarvis.sqlite`                                                       | App database: users, devices, sessions, prefs                                                                                                                                                                                                                                                                                                                                                                                                        |
| `JARVIS_TURN_TIMEOUT_MS`                 | `120000`                                                                        | Hard cap for one agent turn before it is aborted                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LLM_VL_MODEL`                           | `qwen3.6-35b-a3b-splash`                                                        | Vision-language model the `analyzeImage` tool calls (must accept `image_url` parts)                                                                                                                                                                                                                                                                                                                                                                  |
| `LLM_VL_MAX_TOKENS`                      | `1024`                                                                          | Output-token cap for one image analysis                                                                                                                                                                                                                                                                                                                                                                                                              |
| `LLM_VL_TIMEOUT_MS`                      | `60000`                                                                         | Wall-clock cap for one image analysis (abort bound)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_ATTACHMENT_TTL_MINUTES`          | `60`                                                                            | How long an uploaded image stays analyzable                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JARVIS_ATTACHMENT_MAX_BYTES`            | `4194304` (4 MiB)                                                               | Decoded-byte cap per attachment                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `JARVIS_ATTACHMENT_MAX_TOTAL_BYTES`      | `209715200` (200 MiB)                                                           | Per-user total across live attachments                                                                                                                                                                                                                                                                                                                                                                                                               |
| `JARVIS_ATTACHMENT_VL_CALLS_PER_MIN`     | `10`                                                                            | Vision-analysis calls per user per minute                                                                                                                                                                                                                                                                                                                                                                                                            |
| `JARVIS_ATTACHMENT_MAX_INFLIGHT`         | `4`                                                                             | Concurrent uploads server-wide                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_ATTACHMENT_DIR`                  | `<tmpdir>/jarvis-attachments`                                                   | Attachment root (mode-verified private; emptied at boot)                                                                                                                                                                                                                                                                                                                                                                                             |
| `TAVILY_API_KEY`                         | unset                                                                           | Tavily search key — enables the `general`/`news`/`finance` verticals of `webSearch`                                                                                                                                                                                                                                                                                                                                                                  |
| `SERPER_API_KEY`                         | unset                                                                           | Serper search key — enables the Serper-only verticals (`images`, `videos`, `places`, `reviews`, `patents`, `shopping`, `scholar`)                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_SEARCH_TIMEOUT_MS`               | `15000`                                                                         | Wall-clock cap for one provider search call                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JARVIS_SEARCH_MAX_RESULTS`              | `5`                                                                             | Results handed to the model per search                                                                                                                                                                                                                                                                                                                                                                                                               |
| `JARVIS_SEARCH_CALLS_PER_MIN`            | `20`                                                                            | Per-user search-call quota                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `OPENWEATHER_API_KEY`                    | unset                                                                           | OpenWeather key — enables the `getWeather` tool (current + 5-day forecast)                                                                                                                                                                                                                                                                                                                                                                           |
| `JARVIS_WEATHER_UNITS`                   | `imperial`                                                                      | Unit system reported to the model (`metric` supported)                                                                                                                                                                                                                                                                                                                                                                                               |
| `JARVIS_WEATHER_TIMEOUT_MS`              | `10000`                                                                         | Wall-clock cap for one provider weather call                                                                                                                                                                                                                                                                                                                                                                                                         |
| `JARVIS_WEATHER_CALLS_PER_MIN`           | `10`                                                                            | Per-user weather-call quota                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `HOME_ASSISTANT_URL`                     | unset                                                                           | Home Assistant base URL (no trailing slash needed) — enables the `homeAssistant` tool                                                                                                                                                                                                                                                                                                                                                                |
| `HOME_ASSISTANT_ACCESS_TOKEN`            | unset                                                                           | Long-lived HA token; required alongside the URL                                                                                                                                                                                                                                                                                                                                                                                                      |
| `JARVIS_HA_READ_DOMAINS`                 | `light,switch,climate,fan,sensor,binary_sensor,cover,media_player,lock`         | Domains whose entities the model may read                                                                                                                                                                                                                                                                                                                                                                                                            |
| `JARVIS_HA_CONTROL_DOMAINS`              | `light,switch,climate,fan`                                                      | Domains whose entities the model may write (a strict subset of reads)                                                                                                                                                                                                                                                                                                                                                                                |
| `JARVIS_HA_CALLS_PER_MIN`                | `10`                                                                            | Per-user Home Assistant call quota                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_HA_TIMEOUT_MS`                   | `10000`                                                                         | Wall-clock cap for one HA call                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_HA_CACHE_TTL_MS`                 | `15000`                                                                         | How long an entity snapshot is reused; `0` disables the cache                                                                                                                                                                                                                                                                                                                                                                                        |
| `JARVIS_HA_LIST_LIMIT`                   | `40`                                                                            | Max entities listed by one `list`, `lights` or `switches` call                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_HA_LIGHT_TOKENS`                 | `light,lamp,bulb,strip,ceiling,sconce,luminaire,fixture`                        | Name fragments that make a light a light to `action: "lights"`                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_WIKIPEDIA`                       | `on`                                                                            | `off` removes the `wikipedia` tool; it is the one optional tool enabled without a credential                                                                                                                                                                                                                                                                                                                                                         |
| `JARVIS_WIKIPEDIA_LANG`                  | `en`                                                                            | Wiki language subdomain (validated as a host label)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_WIKIPEDIA_TIMEOUT_MS`            | `10000`                                                                         | Wall-clock cap for one Wikipedia API call                                                                                                                                                                                                                                                                                                                                                                                                            |
| `JARVIS_WIKIPEDIA_MAX_SENTENCES`         | `5`                                                                             | Leading sentences a summary extract asks for (API caps at 10)                                                                                                                                                                                                                                                                                                                                                                                        |
| `JARVIS_WIKIPEDIA_MAX_FULL_CHARS`        | `6000`                                                                          | Character budget for `detail: "full"`; the result states the omission                                                                                                                                                                                                                                                                                                                                                                                |
| `JARVIS_WIKIPEDIA_MAX_CANDIDATES`        | `5`                                                                             | Candidate titles returned when a query is ambiguous                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_WIKIPEDIA_CALLS_PER_MIN`         | `20`                                                                            | Per-user Wikipedia call quota                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `JARVIS_WIKIPEDIA_GUEST_SESSION_PER_MIN` | `3`                                                                             | Per-guest-session quota (both this and the per-address budget must admit)                                                                                                                                                                                                                                                                                                                                                                            |
| `JARVIS_WIKIPEDIA_GUEST_IP_PER_MIN`      | `10`                                                                            | Aggregate per-guest-client-address quota                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JARVIS_WIKIPEDIA_USER_AGENT`            | `jarvis-v2/0.1 (+https://github.com/LukeStanbery89/jarvis-v2)`                  | Descriptive `User-Agent` (Wikimedia policy; empty is answered 403)                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_BOOTSTRAP_TOKEN`                 | unset                                                                           | One-time setup credential; see the `@lukestanbery/jarvis-auth` README                                                                                                                                                                                                                                                                                                                                                                                |
| `JARVIS_HOST`                            | `0.0.0.0`                                                                       | Bind address (all interfaces = LAN posture)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JARVIS_TLS_CERT`                        | unset                                                                           | PEM certificate path — enables HTTPS serving                                                                                                                                                                                                                                                                                                                                                                                                         |
| `JARVIS_TLS_KEY`                         | unset                                                                           | Matching PEM private key (required with `JARVIS_TLS_CERT`)                                                                                                                                                                                                                                                                                                                                                                                           |
| `JARVIS_HTTP_REDIRECT_PORT`              | `PORT + 1`                                                                      | Cleartext port that upgrades to HTTPS (TLS mode)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JARVIS_PORTAL_DIR`                      | `packages/portal/dist`                                                          | Built portal SPA root served at `/`; empty string disables it                                                                                                                                                                                                                                                                                                                                                                                        |
| `JARVIS_WEB_DIR`                         | `packages/web/dist`                                                             | Built web chat client root served at `/web`; empty string disables it                                                                                                                                                                                                                                                                                                                                                                                |
| `JARVIS_RATE_WINDOW_MS`                  | `900000` (15 min)                                                               | Attempt-accumulation window for login/bootstrap                                                                                                                                                                                                                                                                                                                                                                                                      |
| `JARVIS_RATE_MAX_FAILURES`               | `10`                                                                            | Attempts per `(ip, username)` before a lockout                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_RATE_MAX_IP_FAILURES`            | `100`                                                                           | Aggregate attempts per IP per window — the cap for `login:<ip>` and `bootstrap:<ip>` keys                                                                                                                                                                                                                                                                                                                                                            |
| `JARVIS_RATE_LOCKOUT_MS`                 | `60000`                                                                         | Base lockout; doubles per repeat (backoff, ×32 cap)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JARVIS_CORS_ORIGINS`                    | unset (deny all cross-origin)                                                   | Comma-separated exact origins allowed to call `/api` cross-origin; no wildcard                                                                                                                                                                                                                                                                                                                                                                       |
| `JARVIS_TRUST_PROXY_CIDRS`               | unset (trust none)                                                              | IPs/subnets whose `X-Forwarded-For` is believed for `req.ip`                                                                                                                                                                                                                                                                                                                                                                                         |
| `JARVIS_SESSION_TTL_MS`                  | `2592000000` (30 days)                                                          | Absolute lifetime of a cookie session (no sliding)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JARVIS_API_CONTRACT`                    | unset                                                                           | Set `verify` to also validate REST response bodies against the OpenAPI contract (request shapes are always validated)                                                                                                                                                                                                                                                                                                                                |
| `JARVIS_LOG_LEVEL`                       | `info` (`silent` under tests)                                                   | Log verbosity: `silent` \| `debug` \| `info` \| `warn` \| `error`                                                                                                                                                                                                                                                                                                                                                                                    |
| `JARVIS_LOG_SENSITIVE`                   | `auto`                                                                          | Force sensitive payload logging: `full` \| `redacted`                                                                                                                                                                                                                                                                                                                                                                                                |

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

Each chat turn is logged at two levels: every token as it streams
(`sensitiveDebug("LLM token", …)`), and the assembled answer once the stream
ends (`sensitive("Agent response", { text, toolCalls })`) — one line per turn,
which is what you want when reading a transcript in development.

### Empty model responses

A turn that ends with **no prose at all** (whitespace-only chunks included)
answers `{"error": "the model returned an empty response"}` + `done`, and logs
a warning naming the tool-call count. This is a model failure being reported,
not a client bug: reasoning-tuned models (the Qwen3 family, for instance) can
spend their entire output budget in the reasoning channel and return an
`AIMessage` whose `content` is empty, which the tracker correctly turns into
zero `token` events. Without the guard the client renders a permanently blank
bubble with no explanation. Note that LM Studio's OpenAI-compatible endpoint
ignores both `reasoning_budget: 0` and
`chat_template_kwargs: { enable_thinking: false }`, so this cannot be switched
off per request — the model itself has to be loaded with thinking disabled, or
answered by a non-reasoning model.

## Rate limiting

Every throttle the server applies lives in this section — this is the single source of
truth. Two independent mechanisms exist, because they answer different questions and
must not be interchanged.

### Credential throttle — `src/http/rateLimit.ts`

Guards the expensive password-verification path against guessing.

There is exactly **one** `RateLimiter` instance, built from `appConfig.loginRateLimit`
and shared by every credential endpoint. Endpoints stay isolated by **key namespace**
(`login:` vs `bootstrap:`), not by separate limiters or configs.

| Endpoint                                    | Key                     | Budget                                                                           |
| ------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `POST /api/auth/login`, `POST /api/session` | `login:<ip>:<username>` | `JARVIS_RATE_MAX_FAILURES` (10) per window                                       |
| `POST /api/auth/login`, `POST /api/session` | `login:<ip>`            | `JARVIS_RATE_MAX_IP_FAILURES` (100) per window — aggregate across usernames      |
| `POST /api/bootstrap`                       | `bootstrap:<ip>`        | `JARVIS_RATE_MAX_IP_FAILURES` (100) per window — bootstrap is keyed purely by IP |

Login admits **both** keys on every attempt
(`limiter.admit(userKey, "username") ?? limiter.admit(ipKey, "ip")`), so a request
must clear the per-username budget _and_ the per-IP aggregate budget; each kind
checks its own threshold (`admit`'s `kind` parameter picks `maxFailures` vs
`maxIpFailures` — the limiter never infers it from the key's text).

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

### Metered-tool quotas — `src/rate/fixedWindowQuota.ts`

Billable or compute-heavy tool calls run on a different mechanism than the
credential throttle: a **per-user fixed-window quota** whose successful calls
stay counted (there is no "failure" to forgive — the budget renews only when
the window lapses). Refusals are returned to the model as retry text ("try
again in Ns") rather than erroring the turn. The generic machinery is
`FixedWindowQuota`; each tool instantiates its own.

| Tool                             | Quota          | Budget                                                 |
| -------------------------------- | -------------- | ------------------------------------------------------ |
| `analyzeImage` (vision analysis) | `vlLimiter`    | `JARVIS_ATTACHMENT_VL_CALLS_PER_MIN` (10/min per user) |
| `webSearch` (#9)                 | `searchQuota`  | `JARVIS_SEARCH_CALLS_PER_MIN` (20/min per user)        |
| `getWeather` (#31)               | `weatherQuota` | `JARVIS_WEATHER_CALLS_PER_MIN` (10/min per user)       |
| `homeAssistant` (#15)            | `haQuota`      | `JARVIS_HA_CALLS_PER_MIN` (10/min per user)            |
| `wikipedia` (#8)                 | `quota`        | `JARVIS_WIKIPEDIA_CALLS_PER_MIN` (20/min per user)     |

The first four are **per-user only**: they refuse a guest outright (a guest has
no verified `userId` to charge). `wikipedia` is the exception — it needs no
credential and costs nothing, so it also admits guests, who are metered by a
**second mechanism** built on the same primitive. A guest call must clear
**both** of these buckets (the `FixedWindowQuota` keys are namespaced strings,
`"session:<id>"` / `"address:<ip>"`, which is why the class is generic over its
key type):

| Guest budget | Key            | Budget                                       | Purpose                                                     |
| ------------ | -------------- | -------------------------------------------- | ----------------------------------------------------------- |
| per session  | `session:<id>` | `JARVIS_WIKIPEDIA_GUEST_SESSION_PER_MIN` (3) | bounds one conversation                                     |
| per address  | `address:<ip>` | `JARVIS_WIKIPEDIA_GUEST_IP_PER_MIN` (10)     | bounds a guest who opens a fresh socket for a fresh session |

This mirrors the credential throttle's per-username + per-IP pair: the
per-session bucket alone is not enough, because a guest chooses its own
`sessionId` and could rotate it to reset the budget. The `address` key is the
socket's peer address (`request.socket.remoteAddress`, captured at handshake),
so behind a reverse proxy it collapses toward one global bucket — the same
`req.ip` caveat [below](#scope-and-caveats), tracked with
[#63](https://github.com/LukeStanbery89/jarvis-v2/issues/63).

### Notification delivery budget — `src/notify/service.ts`

Not a tool quota, but the same primitive for a different resource: a
per-user, per-minute ceiling on how many notifications may be **pushed** to
that user's live sockets (`JARVIS_NOTIFY_DELIVERIES_PER_MIN`, default 20). A
notification past the budget is still recorded and still shows up in
`GET /api/notifications` — the budget bounds interruption, not storage, which
is what keeps a misbehaving producer from turning a chat client into a
firehose without ever losing the message.

Two properties make it behave unlike the tables above. The budget is only
charged when there is somebody to interrupt: a notification raised while the
user has no live socket is left `pending` and spends nothing. And a suppressed
notification is not an error the caller has to handle — `POST
/api/notifications` answers 201 with `suppressed: "cap"` (or `"disabled"`,
`"quiet-hours"`, `"absent"`), so the producer learns what happened without a
failure. Quiet hours come from the user's `notify.quietHours` pref and are evaluated
against the **server process's clock**, not a per-user timezone: JARVIS is a
home server that normally shares its user's clock, and a deployment that does
not (the container defaults to UTC — see `TZ` in `docker-compose.yml`) would
otherwise be quietly wrong. A per-user timezone is the tracked follow-up.

Retention is the other half: `JARVIS_NOTIFY_MAX_PER_USER` (default 200) trims on
every insert, evicting settled rows first — an undelivered notification is the
last thing a prune takes, but it is not exempt, because the rows that pile up
most easily are precisely the `pending` ones nobody was online to receive.

### Not rate limited

Worth stating explicitly, because these are the surfaces that cost real CPU:

| Surface                                                        | Bounded by                                                                                                                            | Not bounded by                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/ws` chat turns                                               | concurrency only — a per-thread lock (one turn per `sessionId`), one streaming turn per socket, and `JARVIS_TURN_TIMEOUT_MS` per turn | **prompt frequency** — a socket can submit turns back-to-back indefinitely |
| REST resources (`/api/users`, `/api/devices`, `/api/prefs`, …) | authentication and ownership checks                                                                                                   | any request-rate ceiling                                                   |
| Notification **records** (`POST /api/notifications`)           | the per-user delivery budget above (which bounds pushes), plus retention                                                              | how many notifications may be _stored_ per minute                          |

The `/ws` gap is tracked in [#65](https://github.com/LukeStanbery89/jarvis-v2/issues/65).
Guest sockets (a `/ws` socket that sends a prompt without an `auth` frame) are
unauthenticated and therefore the most exposed. Their chat **turns** are still
unbounded, but the guest-admitting `wikipedia` tool caps its own calls per
session and per address (see the quota table above), so a guest cannot use that
tool as an unbounded outbound-request amplifier.

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

## Web search and weather

See the configuration table for `TAVILY_API_KEY`, `SERPER_API_KEY`, and `OPENWEATHER_API_KEY`; tools are registered only when their keys are configured.

## Home Assistant

The agent reads and lightly controls the user's own Home Assistant instance
through one `homeAssistant` tool (#15) over the local REST API — two endpoints,
no new dependency: `GET /api/states` for the snapshot and
`POST /api/services/<domain>/<service>` for a write. Configure
`HOME_ASSISTANT_URL` and `HOME_ASSISTANT_ACCESS_TOKEN` (plus the optional
`JARVIS_HA_*` knobs in the configuration table); with either unset the tool is
not registered at all.

- **One tool, one `action`** — `list`, `lights`, `switches`, `get`, `turn_on`,
  `turn_off`, `toggle`, `set_brightness`, `set_temperature`. The two discovery
  actions paper over the fact that a light is not always the `light` domain:
  `lights` matches the `light`/`switch` domains against `JARVIS_HA_LIGHT_TOKENS`
  over id and friendly name, and `switches` drops `_led` shadow children.
- **Reads are broad, writes are narrow** — reads span lights, switches,
  climate, fans, sensors, covers, media players and locks
  (`JARVIS_HA_READ_DOMAINS`); writes are limited to light/switch/climate/fan
  (`JARVIS_HA_CONTROL_DOMAINS`), a strict subset. Locks, covers, scenes,
  buttons and scripts stay readable but not controllable.
- **A write reports the accepted action, never a verified state** — every
  write resolves `entity_id` against the live snapshot and is checked against
  the control domains, the action's required domain, and the entity's own
  state (`unavailable`/`unknown` is refused) before any HTTP, and the 2xx body
  (dispatch-time state, not the outcome) is discarded. The model is told to
  call `get` for current state; writes are logged at info as an audit trail.
- **Metered and bounded** — `JARVIS_HA_CALLS_PER_MIN` (10/min) through the
  shared fixed-window quota and `JARVIS_HA_TIMEOUT_MS` (10 s) per call; the
  token is a `Bearer` header only, never in a URL, a log line, or error text.

The full per-bullet rationale, the snapshot-caching rules, and the
untrusted-input handling live in the `packages/server/src/README.md` file map
(`llm/tools/homeAssistant.ts`, `llm/tools/homeAssistant/client.ts`).

## Wikipedia

The agent looks up encyclopedic topics through one `wikipedia` tool (#8) over
the public MediaWiki Action API — one request on the common path, no
dependency, no API key. Because there is no credential to gate on, this is the
one optional tool that is **enabled by default**; `JARVIS_WIKIPEDIA=off`
removes it.

- **One request on the common path.** A `generator=search` query resolves the
  best title _and_ fetches its extract in the same response. A second
  `list=search` request happens only when the top hit is unusable (a
  disambiguation page, or a hit with no extract): the model is handed candidate
  articles to choose between, or to narrow the query against, instead of a
  body to answer from. The rejected page is dropped from that list — the
  fallback search usually ranks it first, and it is by definition not an
  answer.
- **Two depths.** `detail: "summary"` (the default) returns the lead extract
  (`exintro`, bounded by `JARVIS_WIKIPEDIA_MAX_SENTENCES`, which the API caps at
  10). `detail: "full"` returns the article's plain text cut to
  `JARVIS_WIKIPEDIA_MAX_FULL_CHARS`; the result states how much was omitted and
  links the full article, so the model never presents a partial extract as
  complete. Per-section retrieval is deliberately not attempted — it would
  mean `action=parse` and stripping tens of KB of HTML per section.
- **Descriptive `User-Agent` is required.** Wikimedia's policy requires an agent
  that identifies the client; `JARVIS_WIKIPEDIA_USER_AGENT` defaults to this
  project's URL. An empty agent is answered `403`.
- **Metered, and the only guest-admitting tool.** Signed-in callers use
  `JARVIS_WIKIPEDIA_CALLS_PER_MIN` (20/min); guests — who have no account to
  charge — are metered by **two** buckets that must both admit, a strict
  per-session one and an aggregate per-address one. See the
  [metered-tool quotas](#metered-tool-quotas--srcratefixedwindowquotats) table.

The request/response normalization and the defensive parsing live in the
`packages/server/src/README.md` file map (`llm/tools/wikipedia.ts`,
`llm/tools/wikipedia/client.ts`).

## Endpoints

Authoritative machine-checked tables live in `@lukestanbery/jarvis-contracts`:
the spec'd REST surface in [`docs/endpoints-rest.md`](../contracts/docs/endpoints-rest.md)
(generated from `packages/contracts/spec/openapi.yaml`, enforced at runtime by
`express-openapi-validator`) and the WebSocket channel in
[`docs/endpoints-ws.md`](../contracts/docs/endpoints-ws.md). The rows below are
the commonly-used subset for orientation (auth labels match the generated
table — "web session" is the `jarvis_session` cookie):

| Method   | Path                       | Auth                                | Description                                                                              |
| -------- | -------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET`    | `/`                        | none                                | Returns the built portal SPA if present, otherwise `Hello World`                         |
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

## Chat protocol

The wire protocol (frames, limits, and parse/serialize logic) is defined once
in the shared `@lukestanbery/jarvis-protocol` package (machine-readable mirror:
`packages/contracts/spec/asyncapi.yaml`); connect a WebSocket client to `/ws`
and exchange JSON text frames:

- Client → Server:
    - **Optional, first frame only:** `{ "hello": true, "capabilities": ["markdown", "html", "image", "link", "audio"] }` (shape
      `{ "type": "hello", "capabilities": [...] }`) — the client announces how it renders responses. Each token is
      one of `markdown` / `html` / `image` / `link` / `audio` (duplicates and unknown tokens are rejected; the list may be
      empty). This affects the agent's system prompt: the model is told the client renders Markdown/images/links
      (or that it only shows plain text). Regardless of capabilities, the server always appends five fixed hygiene paragraphs to the system prompt — make exactly one tool call at a time with every required argument as well-formed JSON and wait for each result; make exactly one `getCurrentTime` call per time/date/weekday ask, passing the user's question verbatim; for attachment-carrying prompts, call `analyzeImage` with the exact id from the message's `[attachments: …]` list and answer from the tool's description, never by guessing; for home automation, use `homeAssistant` only as its description allows and report failures plainly; and for factual or fast-changing questions, prefer a lookup tool such as `wikipedia` or `webSearch` over memory. Must be
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
      always yield plain conversational text plus the spoken-word directive —
      the system prompt tells the model to write as it would speak (no
      markdown, no parentheses, spelled-out units) because the reply will be
      read aloud. Scoped to the turn: a later text prompt on the same thread
      renders richly again. The mode is recorded as the
      session's `kind` when the thread is first claimed (write-once).
      A `hello` or `auth` frame arriving after this is rejected.
    - `{ "type": "location", "lat": <number>, "lon": <number>, "label"?: "<place>" }` (#31) —
      the device's whereabouts (any time, refreshable; the latest report wins
      for subsequent turns). Feeds the `getWeather` tool so a locationless
      "what's the weather?" works without asking for a city. Kept in memory
      for the socket's lifetime only; never persisted. See [Weather](#web-search-and-weather).
    - `{ "type": "cancel" }` (#84 P6) — drop the socket's in-flight turn
      (barge-in or the stop button). Valid any time and idempotent: with no
      turn in flight it is ignored (no reply). The server aborts the model
      stream for real (`AbortSignal` threaded into the graph, so even a
      stalled model read rejects), drops the turn's spoken audio, releases
      the thread lock, and ends the turn with a terminal `{ "done": true }`
      — the text already streamed stays in history, and no error frame is
      sent.
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
  releases once the in-flight model call settles; a client `cancel` aborts
  the same signal, so signal-honoring models stop immediately.

Every prompt is recorded in the app database (`JARVIS_DB_PATH`, default
`~/.jarvis/jarvis.sqlite`): `sessionId` is claimed atomically as a
**session** tagged `guest`/`owned` and `text`/`voice` (the kind is the
prompt's chat `mode`, recorded at first claim). Guest sessions are
deleted when their socket closes; owned sessions persist and can be listed or
deleted via the REST management API. Sockets that vanish without a close
frame (a dropped connection, a sleeping laptop) are terminated by a 30-second
ping/pong keepalive, so their cleanup — guest rows included — still fires.
Note that deleting a session removes the
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

## Server-side TTS (#83)

J.A.R.V.I.S. speaks its responses: text-to-speech is **server-side** (one
consistent voice for every client; clients only play audio — the mirror of
client-side STT in `packages/voice`). The engine seam, the Kokoro engine, the
response segmenter, the audio orchestrator, and the wire frames
(`audioStart`/binary PCM/`audioEnd` behind the `audio` capability) are all
shipped (#83). See the
[tracking issue](https://github.com/LukeStanbery89/jarvis-v2/issues/83) for
the strategy and its race-test matrix.

What exists now:

- `src/tts/types.ts` — the `TtsProvider` seam: text → mono float PCM +
  sample rate, with a cooperative `AbortSignal` (checked before init,
  before generate, and after; in-flight engine work cannot be interrupted,
  so the orchestrator drops aborted results by generation id instead).
- `src/tts/kokoro.ts` — `KokoroTtsProvider`, Kokoro-82M via `kokoro-js`
  (ONNX, pure local inference — no Python, no Apple-Silicon lock-in; that
  is what disqualified the MLX sketch). The engine loads through a lazy
  dynamic `import()` on first synthesis; a fake loader keeps the suite
  offline. Options: model id, dtype (`q8` default), voice (`bm_lewis`
  default), speed, and cache dir.
- `src/tts/segmenter.ts` + `src/tts/orchestrator.ts` — the turn pipeline:
  streamed tokens → sentence-boundary segments → one sequential synthesis
  worker → ordered audio, with quiet failure (the text stream is never
  disturbed) and abort on turn timeout / socket close.
- `scripts/tts-harness.ts` (`npm run tts:harness`) — the manual acceptance
  tool: synthesize `JARVIS_TTS_TEXT` (or argv), write a WAV to temp, and
  play it via `afplay`/`aplay`. Prints init/generate timings.

**Wired to `/ws`**: voice-mode prompts from a socket that declared the
`audio` capability are spoken — an `audioStart` frame, binary
little-endian s16le PCM messages (one per segment), and `audioEnd`, all
inside the turn (before `done`), so the per-thread lock covers speaking.
The model is asked to write speakably in the first place: voice turns
carry a spoken-word system-prompt directive (no markdown, no parentheses,
units spelled out — `src/agent.ts` `VOICE_FORMAT_RULE`), so the segmenter
mostly sees clean prose. Incidental markup that slips through is inert
text (it reads as written); a deterministic say-proofing pass is a
deliberate non-goal for now.

Time-to-first-audio (#89): spoken turns log a TTFA decomposition at debug
(`voice turn N TTFA: first token +Xms, first segment +Yms, first audio
sent +Zms` — deltas against the turn's start), and the web client mirrors
it in devtools (`[voice] first audio +Xms since submit, +Yms since
audioStart`). The first-audio lever is the segmenter: `JARVIS_TTS_SEGMENT`
(default `sentence`) selects clause granularity, which additionally splits
at commas/semicolons when the pending text covers at least 40 chars — the
first PCM lands at the first comma instead of the first period, at the
cost of prosody across the split (clauses are synthesized independently).
Numbers ("1,000") never split; short clauses merge into the next one so
fragment overhead cannot dominate the win. Enable it with:

| Variable              | Default    | Description                                    |
| --------------------- | ---------- | ---------------------------------------------- |
| `JARVIS_TTS_PROVIDER` | _(unset)_  | `kokoro` enables synthesis; unset = off        |
| `JARVIS_TTS_VOICE`    | `bm_lewis` | Kokoro voice id                                |
| `JARVIS_TTS_SPEED`    | `1`        | Speaking speed multiplier                      |
| `JARVIS_TTS_SEGMENT`  | `sentence` | `clause` splits at commas/semicolons too (#89) |

Deployment posture (deliberate):

- `kokoro-js` and `@huggingface/transformers` are **optionalDependencies** —
  TTS is config-gated like the optional tools, and a missing install makes
  the provider report itself unavailable; it is never a boot failure.
- Model weights are **never baked into the image**: first synthesis
  downloads the checkpoint into `~/.jarvis/tts` (created `0700` via the auth package's private-fs helpers; set via environment for local runs / `JARVIS_TTS_CACHE_DIR` only affects the standalone TTS harness — the server does not read this env var).
- The Docker prod stage installs with `--omit=optional`, so the runtime
  image neither carries the ONNX stack nor changes behavior.

## Local STT model serving (#84 P3b)

The web chat client's speech recognition runs **on-device** (issue #84):
a WASM engine (Vosk) in the browser transcribes the microphone locally, so
no audio ever leaves the client. The engine needs ~40 MB of model weights;
the server fetches the archive from its configured upstream on the **first
client request**, caches it privately, and streams it to browsers from its
own origin — `GET /api/stt/model` (public by design: the archive is
open-source model weights, never user data, and the recognition worker
cannot attach auth headers; browsers cache it via long-lived headers). The
archive never lands in the Docker image and is never downloaded at boot.

- `src/modelFileCache.ts` — the shared serving machinery both model routes
  use (issue #107 P3): `ModelFileCache` (lazy first fetch, per-key in-flight
  collapse, a **streamed** temp-file-then-rename write so a partial download
  never masquerades as a model and the ~40 MB archive never sits whole in
  memory, a hard fetch timeout — `DEFAULT_DOWNLOAD_TIMEOUT_MS`, 10 minutes —
  so a hung upstream cannot stall a request forever, retry on the next
  request after a failure) plus `createModelFileHandler` (200 with the
  route's `Content-Type` and `Cache-Control: public, max-age=86400`; JSON
  404 unconfigured/unknown; JSON 503 while an upstream fetch fails; optional
  `HEAD` 200 capability probe).
- `src/stt/model.ts` — the STT spec on that machinery: `SttModelCache`
  (single archive key; the cached file name is derived and sanitized from
  `JARVIS_STT_MODEL_URL`) and `createSttModelHandler` for
  `GET /api/stt/model` (200 `application/gzip`).

| Variable               | Default                              | Description                                   |
| ---------------------- | ------------------------------------ | --------------------------------------------- |
| `JARVIS_STT_PROVIDER`  | _(unset)_                            | `vosk` enables model serving; unset = 404     |
| `JARVIS_STT_MODEL_URL` | the vosk-browser small-en-us tarball | Upstream archive fetched on first request     |
| `JARVIS_STT_MODEL_DIR` | `~/.jarvis/stt`                      | Private cache directory (`0700`, file `0600`) |

## Wake-word model serving (#84 P4)

The web chat client's "Hey JARVIS" wake detector (openWakeWord) also runs
**on-device**. It needs three small ONNX models (`melspectrogram.onnx`,
`embedding_model.onnx`, `hey_jarvis_v0.1.onnx` — ~3 MB total); the server
fetches them from the openWakeWord release host on first request and serves
them same-origin from `/api/wake/model/:file`, because the upstream commits
no CORS headers and a `/web`-mounted SPA must load them without them. The
route is an exact per-file allowlist — an unknown name 404s before any
fetch; `HEAD` answers 200 without downloading.

- `src/wake/model.ts` — the wake spec on the shared machinery: the
  `WAKE_MODEL_FILES`/`isWakeModelFile` three-file allowlist (an unknown
  `:file` 404s before any fetch, so the route is never an open proxy),
  `WakeModelCache` (per-file keys over `ModelFileCache`), and
  `createWakeModelHandler` for `GET|HEAD /api/wake/model/:file`
  (200 `application/octet-stream` + `Cache-Control public, max-age=86400`;
  `HEAD` answers 200 without downloading).
- `src/notify/` — server-initiated messaging (#139): `types.ts` is the channel
  seam and its capability vocabulary (`canSpeak`, `canShowText`, …) so a
  satellite speaker or a phone outranks nothing it cannot do; `hub.ts` is the
  live-socket registry (`ws.ts` fills it on auth, empties it on close) that
  makes "is the user reachable?" answerable at all; `service.ts` is the policy
  (presence-first, quiet hours from the `notify.quietHours` pref, the delivery
  budget above); `channels/inApp.ts` is the one phase-1 channel, pushing the
  stored record as a `notification` frame; `http.ts` is `/api/notifications`
  (list + create + read/dismiss/answer), mounted only when notifications are
  configured and refused to guests like every other account-scoped surface.
- `src/llm/tools/notify.ts` — the `sendNotification` tool (#139): the agent's
  half of that surface and the channel's first real producer. It holds no
  policy of its own — it asks `service.ts` and reports the answer — so the
  budget above bounds an over-eager model exactly as it bounds a webhook. The
  tool is registered only when the notification surface is wired, and it is
  announced to the model by a hygiene paragraph that pins restraint rather
  than use: a notification is an interruption, and one that arrives for
  everything stops meaning anything.

| Variable                | Default                                   | Description                                       |
| ----------------------- | ----------------------------------------- | ------------------------------------------------- |
| `JARVIS_WAKE_PROVIDER`  | _(unset)_                                 | `openwakeword` enables model serving; unset = 404 |
| `JARVIS_WAKE_MODEL_URL` | `…/openWakeWord/releases/download/v0.5.1` | Upstream directory each model is fetched from     |
| `JARVIS_WAKE_MODEL_DIR` | `~/.jarvis/wake`                          | Private cache directory (`0700`, file `0600`)     |
