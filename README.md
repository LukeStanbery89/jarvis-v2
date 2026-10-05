# jarvis-v2

AI-powered assistant monorepo.

## Packages

| Package                                    | Description                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [packages/protocol](./packages/protocol)   | Shared chat wire-protocol types + framing (`@lukestanbery/jarvis-protocol`)                                          |
| [packages/auth](./packages/auth)           | App database + credential crypto: users/devices/sessions/prefs ledgers (`@lukestanbery/jarvis-auth`)                 |
| [packages/server](./packages/server)       | Express backend server with WebSocket chat + REST admin API (`@lukestanbery/jarvis-server`)                          |
| [packages/cli](./packages/cli)             | WebSocket chat REPL client (`@lukestanbery/jarvis-cli`)                                                              |
| [packages/logger](./packages/logger)       | Shared leveled, timestamped logging (`@lukestanbery/jarvis-logger`)                                                  |
| [packages/portal](./packages/portal)       | React admin portal served by the server at `/` (`@lukestanbery/jarvis-portal`)                                       |
| [packages/web](./packages/web)             | Browser chat client (markdown/image/link rendering) served at `/web` (`@lukestanbery/jarvis-web`)                    |
| [packages/contracts](./packages/contracts) | Contract-first API specs: OpenAPI (REST) + AsyncAPI (WebSocket) + generated types (`@lukestanbery/jarvis-contracts`) |

## Getting started

Install all workspace dependencies from the repository root:

```sh
npm install
```

## Running the server with Docker

The server has a production image ([`Dockerfile`](./Dockerfile)) and a compose
file ([`docker-compose.yml`](./docker-compose.yml)):

```sh
docker compose up -d --build
curl http://localhost:54321/health        # -> {"ok":true}
```

The image is **server-only** — it builds the five packages the server loads at
runtime (`protocol`, `logger`, `auth`, `contracts`, `server`). The CLI, portal,
and web chat client deploy separately (#29); nothing in the image builds or
serves the browser SPAs.

**The LLM is expected on the host.** `LLM_BASE_URL` defaults to
`http://localhost:1234/v1` (LM Studio), but inside a container `localhost` is
the container itself. Compose points it at `host.docker.internal` instead —
native on OrbStack and Docker Desktop, and covered for plain Docker Engine on
Linux by `extra_hosts`. Override it for a remote or containerised endpoint:

```sh
LLM_BASE_URL=http://ollama:11434/v1 docker compose up -d
```

All server state lives in a named volume (`jarvis-data`) mounted at
`/home/jarvis/.jarvis`. The image sets `HOME`, so the app database
(`jarvis.sqlite`) and LangGraph checkpoints (`checkpoints.sqlite`) land there
without needing `JARVIS_DB_PATH` / `JARVIS_CHECKPOINT_PATH` overrides.

**First run:** create the owner account. Bootstrap stays disabled until
`JARVIS_BOOTSTRAP_TOKEN` is set — every caller gets `409 first-owner setup is
disabled`:

```sh
echo "JARVIS_BOOTSTRAP_TOKEN=$(openssl rand -hex 16)" >> .env
docker compose up -d
curl -X POST http://localhost:54321/api/bootstrap \
  -H "x-bootstrap-token: $JARVIS_BOOTSTRAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"username":"owner","password":"a-long-passphrase","deviceName":"laptop"}'
```

Container notes: runs as non-root uid `10001`, ships no compilers or toolchain,
and has a `HEALTHCHECK` that polls `/health`. See
[packages/server/README.md](./packages/server/README.md#docker) for the full
environment reference, including how to mount the SPA builds.

## Architecture

The server answers every prompt with a **LangGraph agent** rather than a bare
LLM: the model can call tools inside a bounded loop before streaming its final
answer, and each client-supplied `sessionId` maps to a conversation thread that
is persisted to a SQLite checkpoint file. The CLI keeps its `sessionId` in
`~/.jarvis/session-id`, so conversations survive both CLI and server restarts.
The wire protocol those two packages speak over `/ws` is defined **once** in
`@lukestanbery/jarvis-protocol`; see each package's README for details.

Alongside the CLI, the server serves a browser **admin portal**
(`packages/portal`) — a React SPA at `/` that manages accounts, devices,
sessions, and prefs through the REST API, authenticating with a cookie session
plus a per-session CSRF nonce rather than device tokens. The server also hosts
the **web chat client** (`packages/web`) at `/web`: a signed-in browser chat
with conversation management and streaming Markdown/tables/images rendering
(it announces those capabilities with a `hello` frame and chats with
`mode: "text"` — voice mode is future work).

During development the workspace packages resolve each other **through the
workspace symlinks** npm creates in `node_modules` — edit source in
`packages/logger`, for example, and `@lukestanbery/jarvis-server` picks up the change as
soon as you rebuild (see `npm run build`). When a package is published and
installed standalone, npm resolves its `@lukestanbery/jarvis-*` dependencies normally from
the registry; the workspace symlink is a dev-only artifact and never ships in
a published tarball.

## Commands

| Command                | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `npm run build`        | Build all packages                                    |
| `npm run typecheck`    | Type-check all packages (src + tests)                 |
| `npm test`             | Run all package tests                                 |
| `npm run test:scripts` | Run the root tooling tests under `scripts/`           |
| `npm run check`        | Deps + lint + build + typecheck + test + format check |
| `npm run check:deps`   | Verify no package imports an undeclared dependency    |
| `npm run lint`         | Lint all TS/TSX sources with ESLint                   |
| `npm run graph:update` | Rebuild the graphify knowledge graph (no LLM cost)    |
| `npm run graph:health` | Report graphify structural health                     |
| `npm run format`       | Auto-format all files with Prettier                   |
| `npm run format:check` | Verify formatting without modifying files             |

## API docs

The API is specified contract-first (see `packages/contracts`): the REST and
WebSocket surfaces are machine-checked against `openapi.yaml` / `asyncapi.yaml`
(types, runtime validation, and conformance tests all derive from them).
Browse the local references with `npm run docs:serve -w @lukestanbery/jarvis-contracts`
(builds to `.docs/`; also published to GitHub Pages when the specs change).

## Code style

Formatting is enforced with [Prettier](https://prettier.io) using the rules in
[`.prettierrc.json`](./.prettierrc.json):

- Strings use double quotes
- Indentation is 4 spaces

Format-on-save is configured for VS Code (`.vscode/settings.json`, requires the
[Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode))
and for the OpenCode editor (`opencode.json`). Run `npm run check` in CI
to enforce dependency declarations, linting, type-checking, tests, and formatting.
Linting runs from the root (`npm run lint`) with
[`eslint.config.js`](./eslint.config.js); it is not type-aware, so
`npm run typecheck` remains the authority on types.
